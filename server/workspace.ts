import type pg from 'pg';
import type { Mutation, Receipt, Role, Snapshot, Task } from '../lib/model';
import { digest } from './auth';
import { transaction } from './db';

const taskFields = 'id, project_id AS "projectId", title, done, assignee_id AS "assigneeId", version';
type Identity = { id: string; session: string };

async function activeSession(db: pg.PoolClient, session: Identity) {
  return (await db.query(
    'SELECT 1 FROM sessions WHERE digest=$1 AND user_id=$2 AND expires_at > clock_timestamp() FOR SHARE',
    [session.session, session.id],
  )).rowCount;
}

async function membership(db: pg.PoolClient, workspace: string, user: string) {
  return (await db.query<{role: Role}>(
    'SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspace, user],
  )).rows[0]?.role;
}

export async function snapshot(pool: pg.Pool, workspace: string, session: Identity) {
  return transaction(pool, async (db) => {
    const user = session.id;
    if (!await activeSession(db, session)) return { outcome: 'unauthenticated' } as const;
    const role = await membership(db, workspace, user);
    if (!role) return { outcome: 'forbidden' } as const;
    const state = await db.query<{revision: string}>('SELECT revision FROM workspaces WHERE id=$1 FOR SHARE', [workspace]);
    const projects = await db.query('SELECT id, title FROM projects WHERE workspace_id=$1 ORDER BY title, id', [workspace]);
    const tasks = await db.query('SELECT ' + taskFields + ' FROM tasks WHERE workspace_id=$1 ORDER BY title, id', [workspace]);
    const members = await db.query(
      'SELECT u.id, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name, u.id',
      [workspace],
    );
    const activity = await db.query<Snapshot['activity'][number]>(
      `SELECT a.revision, u.name AS actor, a.kind, a.title, a.at, a.resolves
       FROM activity a JOIN users u ON u.id=a.actor_id
       WHERE a.workspace_id=$1 ORDER BY a.revision DESC LIMIT 100`,
      [workspace],
    );
    const conflicts = await db.query<Snapshot['conflicts'][number]>(
      `SELECT proposal AS operation, result AS receipt FROM receipts
       WHERE workspace_id=$1 AND actor_id=$2 AND proposal IS NOT NULL AND resolved_by IS NULL ORDER BY id`, [workspace, user],
    );
    const value: Snapshot = {
      revision: state.rows[0].revision, role, projects: projects.rows, tasks: tasks.rows,
      members: members.rows, activity: activity.rows, conflicts: conflicts.rows,
    };
    return { outcome: 'snapshot', value } as const;
  });
}

async function nextRevision(db: pg.PoolClient, ws: string) {
  return (await db.query<{revision: string}>(
    'UPDATE workspaces SET revision=revision+1 WHERE id=$1 RETURNING revision', [ws],
  )).rows[0].revision;
}

async function change(db: pg.PoolClient, ws: string, actor: string, op: Mutation): Promise<Receipt> {
  if ('resolves' in op && op.resolves) {
    const prior = (await db.query<{result: Receipt}>(
      `SELECT result FROM receipts WHERE workspace_id=$1 AND actor_id=$2 AND id=$3 AND entity_id=$4
       AND resolved_by IS NULL AND result->>'status'='conflict'`, [ws, actor, op.resolves, op.entityId],
    )).rows[0]?.result;
    if (prior?.status !== 'conflict' || (op.kind === 'task.update' && prior.current.version !== op.version)) {
      return { status: 'rejected', reason: 'Conflict already closed or version unavailable' };
    }
  }

  if (op.kind === 'project.create') {
    const inserted = await db.query(
      'INSERT INTO projects (workspace_id,id,title) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ws, op.entityId, op.title],
    );
    if (!inserted.rowCount) return { status: 'rejected', reason: 'Project ID already exists' };
  } else if (op.kind === 'conflict.keep') {
    // Only this actor's conflict ledger changes. No workspace task or shared activity changes.
    return { status: 'applied', revision: await nextRevision(db, ws) };
  } else {
    if (op.assigneeId && !(await db.query(
      'SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR KEY SHARE', [ws, op.assigneeId],
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
      if (task.version !== op.version) return { status: 'conflict', current: task, revision: await nextRevision(db, ws) };
      await db.query(
        'UPDATE tasks SET title=$3, done=$4, assignee_id=$5, version=version+1 WHERE workspace_id=$1 AND id=$2',
        [ws, op.entityId, op.title, op.done, op.assigneeId],
      );
    }
  }

  const revision = await nextRevision(db, ws);
  await db.query(
    'INSERT INTO activity (workspace_id,revision,actor_id,kind,title,resolves) VALUES ($1,$2,$3,$4,$5,$6)',
    [ws, revision, actor, op.kind, op.title, op.kind === 'task.update' ? op.resolves : null],
  );
  return { status: 'applied', revision };
}

export async function mutate(pool: pg.Pool, workspace: string, session: Identity, op: Mutation) {
  return transaction(pool, async (db) => {
    const user = session.id;
    if (!await activeSession(db, session)) return { outcome: 'unauthenticated' } as const;
    const role = await membership(db, workspace, user);
    if (!role) return { outcome: 'forbidden' } as const;
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace]);
    const fingerprint = digest(JSON.stringify(op, Object.keys(op).sort()));
    const former = (await db.query<{fingerprint: string; result: Receipt}>(
      'SELECT fingerprint, result FROM receipts WHERE workspace_id=$1 AND actor_id=$2 AND id=$3',
      [workspace, user, op.id],
    )).rows[0];
    if (former) return former.fingerprint === fingerprint
      ? { outcome: 'receipt', receipt: former.result, replay: true } as const
      : { outcome: 'key-reused' } as const;

    if (role === 'viewer' && op.kind !== 'conflict.keep') return { outcome: 'forbidden' } as const;

    const receipt = await change(db, workspace, user, op);
    await db.query(
      'INSERT INTO receipts (workspace_id,actor_id,id,entity_id,fingerprint,result,proposal) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [workspace, user, op.id, op.entityId, fingerprint, JSON.stringify(receipt),
        receipt.status === 'conflict' ? JSON.stringify(op) : null],
    );
    if ('resolves' in op && op.resolves && receipt.status !== 'rejected') {
      await db.query('UPDATE receipts SET resolved_by=$4 WHERE workspace_id=$1 AND actor_id=$2 AND id=$3',
        [workspace, user, op.resolves, op.id]);
    }
    return { outcome: 'receipt', receipt, replay: false } as const;
  });
}
