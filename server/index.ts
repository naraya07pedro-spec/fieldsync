import { createApi } from './api';
import { openPool } from './db';

const pool = openPool();
pool.on('error', (error) => console.error('PostgreSQL pool:', error.message));
const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000';
const web = process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3001';
const app = await createApi(pool, origin, web);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void app.close().then(() => pool.end()).catch(() => { process.exitCode = 1; }));
}
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
console.log('FieldSync gateway listening on %s', origin);
