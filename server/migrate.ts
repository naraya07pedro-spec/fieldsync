import { readFile } from 'node:fs/promises';
import { openPool, transaction } from './db';

const pool = openPool();
try {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(50172401)');
    await db.query(sql);
  });
} finally {
  await pool.end();
}
