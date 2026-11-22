import type pg from 'pg';
import type { Mutation, Receipt, Role, Snapshot, Task } from '../lib/model';
import { digest } from './auth';
import { transaction } from './db';

const taskFields = 'id, project_id AS "projectId", title, done, assignee_id AS "assigneeId", version';

async function membership(db: pg.PoolClient, workspace: string, user: string) {
  return (await db.query<{role: Role}>(
    'SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspace, user],
  )).rows[0]?.role;
}

export async function snapshot(pool: pg.Pool, workspace: string, user: string): Promise<Snapshot | null> {
  return transaction(pool, async (db) => {
    if (!await membership(db, workspace, user)) return null;
    const state = await db.query<{revision: string}>('SELECT revision FROM workspaces WHERE id=$1 FOR SHARE', [workspace]);
    const projects = await db.query('SELECT id, title FROM projects WHERE workspace_id=$1 ORDER BY title, id', [workspace]);
    const tasks = await db.query('SELECT ' + taskFields + ' FROM tasks WHERE workspace_id=$1 ORDER BY title, id', [workspace]);
    const members = await db.query(
      'SELECT u.id, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name, u.id',
      [workspace],
    );
    const activity = await db.query(
      `SELECT a.revision, u.name AS actor, a.kind, a.title, a.at, a.resolves
       FROM activity a JOIN users u ON u.id=a.actor_id
       WHERE a.workspace_id=$1 ORDER BY a.revision DESC LIMIT 100`,
      [workspace],
    );
    return { revision: state.rows[0].revision, projects: projects.rows, tasks: tasks.rows, members: members.rows, activity: activity.rows };
  });
}

async function change(db: pg.PoolClient, ws: string, actor: string, op: Mutation): Promise<Receipt> {
  if (op.kind === 'project.create') {
    const inserted = await db.query(
      'INSERT INTO projects (workspace_id,id,title) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ws, op.entityId, op.title],
    );
    if (!inserted.rowCount) return { status: 'rejected', reason: 'Project ID already exists' };
  } else {
    if (op.assigneeId && !(await db.query(
      'SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2', [ws, op.assigneeId],
    )).rowCount) return { status: 'rejected', reason: 'Assignee is outside this workspace' };

    if (op.kind === 'task.create') {
      const inserted = await db.query(
        `INSERT INTO tasks (workspace_id,id,project_id,title,done,assignee_id)
         SELECT $1,$2,id,$4,$5,$6 FROM projects WHERE workspace_id=$1 AND id=$3 ON CONFLICT DO NOTHING`,
        [ws, op.entityId, op.projectId, op.title, op.done, op.assigneeId],
      );
      if (!inserted.rowCount) return { status: 'rejected', reason: 'Unknown project or task ID already exists' };
    } else {
      const task = (await db.query<Task>(
        'SELECT ' + taskFields + ' FROM tasks WHERE workspace_id=$1 AND id=$2', [ws, op.entityId],
      )).rows[0];
      if (!task) return { status: 'rejected', reason: 'Unknown task' };
      if (op.resolves && !(await db.query(
        `SELECT 1 FROM receipts WHERE workspace_id=$1 AND actor_id=$2 AND id=$3 AND entity_id=$4
         AND result->>'status'='conflict' AND (result->'current'->>'version')::integer=$5`,
        [ws, actor, op.resolves, op.entityId, op.version],
      )).rowCount) return { status: 'rejected', reason: 'Unknown conflict version' };
      if (task.version !== op.version) return { status: 'conflict', current: task };
      await db.query(
        'UPDATE tasks SET title=$3, done=$4, assignee_id=$5, version=version+1 WHERE workspace_id=$1 AND id=$2',
        [ws, op.entityId, op.title, op.done, op.assigneeId],
      );
    }
  }

  const { revision } = (await db.query<{revision: string}>(
    'UPDATE workspaces SET revision=revision+1 WHERE id=$1 RETURNING revision', [ws],
  )).rows[0];
  await db.query(
    'INSERT INTO activity (workspace_id,revision,actor_id,kind,title,resolves) VALUES ($1,$2,$3,$4,$5,$6)',
    [ws, revision, actor, op.kind, op.title, op.kind === 'task.update' ? op.resolves : null],
  );
  return { status: 'applied', revision };
}

export async function mutate(pool: pg.Pool, workspace: string, user: string, op: Mutation) {
  return transaction(pool, async (db) => {
    const role = await membership(db, workspace, user);
    if (!role || role === 'viewer') return { outcome: 'forbidden' } as const;
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace]);
    const fingerprint = digest(JSON.stringify(op, Object.keys(op).sort()));
    const former = (await db.query<{fingerprint: string; result: Receipt}>(
      'SELECT fingerprint, result FROM receipts WHERE workspace_id=$1 AND actor_id=$2 AND id=$3',
      [workspace, user, op.id],
    )).rows[0];
    if (former) return former.fingerprint === fingerprint
      ? { outcome: 'receipt', receipt: former.result, replay: true } as const
      : { outcome: 'key-reused' } as const;

    const receipt = await change(db, workspace, user, op);
    await db.query('INSERT INTO receipts VALUES ($1,$2,$3,$4,$5,$6)',
      [workspace, user, op.id, op.entityId, fingerprint, JSON.stringify(receipt)]);
    return { outcome: 'receipt', receipt, replay: false } as const;
  });
}
