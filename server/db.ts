import pg from 'pg';

export function openPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
}

export async function transaction<T>(pool: pg.Pool, work: (db: pg.PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
