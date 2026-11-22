import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { hashPassword } from '../server/auth';
import { transaction } from '../server/db';
import type { Role } from '../lib/model';

export async function fixtures(pool: pg.Pool) {
  const suffix = randomBytes(8).toString('hex');
  const password = randomBytes(24).toString('hex');
  const hash = await hashPassword(password);
  return transaction(pool, async (db) => {
    const workspace = async (name: string) => (await db.query<{id: string}>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [name],
    )).rows[0].id;
    const field = await workspace('Field crew ' + suffix);
    const other = await workspace('Private crew ' + suffix);
    async function user(name: string, role: Role, ws = field) {
      const email = name.toLowerCase() + '-' + suffix + '@example.test';
      const { id } = (await db.query<{id: string}>(
        'INSERT INTO users (email,name,password) VALUES ($1,$2,$3) RETURNING id', [email, name, hash],
      )).rows[0];
      await db.query('INSERT INTO memberships VALUES ($1,$2,$3)', [ws, id, role]);
      return { id, email, password };
    }
    return { field, other, alex: await user('Alex', 'admin'), blair: await user('Blair', 'editor'),
      viewer: await user('Casey', 'viewer'), outsider: await user('Drew', 'editor', other) };
  });
}
