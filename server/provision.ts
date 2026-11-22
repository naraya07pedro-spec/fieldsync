import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { openPool, transaction } from './db';
import { hashPassword } from './auth';

const [workspace, email, name, role] = process.argv.slice(2);
const user = z.object({
  workspace: z.string().trim().min(1).max(100),
  email: z.email().transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1).max(100),
  role: z.enum(['admin', 'editor', 'viewer']),
}).parse({ workspace, email, name, role });
if (process.stdin.isTTY) throw new Error('Provide the password through redirected stdin.');
const password = (await readFile('/dev/stdin', 'utf8')).replace(/\r?\n$/, '');
if (password.length < 12 || password.length > 128) throw new Error('Password must have 12–128 characters');
const pool = openPool();
try {
  const hash = await hashPassword(password);
  await transaction(pool, async (db) => {
    const account = await db.query<{ id: string }>(
      'INSERT INTO users (email, name, password) VALUES ($1,$2,$3) RETURNING id',
      [user.email, user.name, hash],
    );
    await db.query('INSERT INTO workspaces (name) VALUES ($1) ON CONFLICT DO NOTHING', [user.workspace]);
    await db.query(
      'INSERT INTO memberships (workspace_id, user_id, role) SELECT id, $2, $3 FROM workspaces WHERE name=$1',
      [user.workspace, account.rows[0].id, user.role],
    );
  });
  console.log('Created account and workspace membership.');
} finally {
  await pool.end();
}
