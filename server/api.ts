import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import proxy from '@fastify/http-proxy';
import throttle from '@fastify/rate-limit';
import { z } from 'zod';
import type pg from 'pg';
import type { WebSocket } from 'ws';
import { mutation, uuid, type Profile } from '../lib/model';
import { digest, sessionToken, validPassword } from './auth';
import { mutate, snapshot } from './workspace';

const credentials = z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(128) });
const sessionSeconds = 12 * 60 * 60;

export async function createApi(pool: pg.Pool, origin: string, webOrigin?: string) {
  const url = new URL(origin);
  if (origin !== url.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid PUBLIC_ORIGIN');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('PUBLIC_ORIGIN must use HTTPS outside loopback');
  }
  const secure = url.protocol === 'https:';
  const cookieName = secure ? '__Host-fieldsync' : 'fieldsync';
  const cookiePolicy = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure };
  const app = Fastify({ bodyLimit: 16_384, logger: false });
  const peers = new Map<WebSocket, { workspace: string; session: string }>();
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 } });
  await app.register(throttle, { global: false });

  async function identify(token?: string) {
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    const session = digest(token);
    return (await pool.query<{ id: string; name: string; session: string }>(
      `SELECT u.id, u.name, s.digest AS session FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.digest=$1 AND s.expires_at > now()`, [session],
    )).rows[0] ?? null;
  }

  await app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      if (request.method === 'POST' && request.headers.origin !== origin) {
        return reply.code(403).send({ error: 'Origin denied' });
      }
    });

    api.setErrorHandler((error, _request, reply) => {
      const status = (error as {statusCode?: number}).statusCode ?? 500;
      if (status >= 500) {
        console.error('API request failed:', error instanceof Error ? error.name : 'Unknown error');
        return reply.code(500).send({ error: 'Service unavailable' });
      }
      return reply.send(error);
    });

    api.get('/health', async (_request, reply) => {
      try {
        await pool.query('SELECT 1');
        return { ok: true };
      } catch {
        return reply.code(503).send({ ok: false });
      }
    });

    api.post('/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
      const input = credentials.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: 'Invalid credentials format' });
      const account = (await pool.query<{id: string; password: string}>(
        'SELECT id, password FROM users WHERE email=$1', [input.data.email.toLowerCase()],
      )).rows[0];
      const valid = await validPassword(input.data.password, account?.password);
      if (!valid || !account) return reply.code(401).send({ error: 'Invalid email or password' });
      const token = sessionToken();
      await pool.query(
        `INSERT INTO sessions (digest,user_id,expires_at) VALUES ($1,$2,now() + $3 * interval '1 second')`,
        [digest(token), account.id, sessionSeconds],
      );
      return reply.setCookie(cookieName, token, { ...cookiePolicy, maxAge: sessionSeconds }).send({ ok: true });
    });

    api.post('/logout', async (request, reply) => {
      const session = await identify(request.cookies[cookieName]);
      if (session) {
        await pool.query('DELETE FROM sessions WHERE digest=$1', [session.session]);
        for (const [socket, peer] of peers) if (peer.session === session.session) socket.close(1008);
      }
      return reply.clearCookie(cookieName, cookiePolicy).send({ ok: true });
    });

    api.get('/me', async (request, reply) => {
      const session = await identify(request.cookies[cookieName]);
      if (!session) return reply.code(401).send({ error: 'Sign in required' });
      const { id, name } = session;
      const { rows } = await pool.query<Profile['workspaces'][number]>(
        `SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON w.id=m.workspace_id
         WHERE m.user_id=$1 ORDER BY w.name`,
        [id],
      );
      return { id, name, workspaces: rows } satisfies Profile;
    });

    api.get<{Params: {id: string}}>('/workspaces/:id', async (request, reply) => {
      const session = await identify(request.cookies[cookieName]);
      if (!session) return reply.code(401).send({ error: 'Sign in required' });
      if (!uuid.safeParse(request.params.id).success) return reply.code(400).send({ error: 'Invalid workspace ID' });
      if (request.headers['x-fieldsync-actor'] !== session.id) return reply.code(401).send({ error: 'Session changed' });
      const state = await snapshot(pool, request.params.id, session.id);
      return state ?? reply.code(403).send({ error: 'Workspace access denied' });
    });

    api.post<{Params: {id: string}}>('/workspaces/:id/mutations', async (request, reply) => {
      const session = await identify(request.cookies[cookieName]);
      if (!session) return reply.code(401).send({ error: 'Sign in required' });
      if (request.headers['x-fieldsync-actor'] !== session.id) return reply.code(401).send({ error: 'Session changed' });
      const parsed = mutation.safeParse(request.body);
      if (!uuid.safeParse(request.params.id).success || !parsed.success) {
        return reply.code(400).send({ error: 'Invalid mutation' });
      }
      const workspace = request.params.id.toLowerCase();
      const result = await mutate(pool, workspace, session.id, parsed.data);
      if (result.outcome === 'forbidden') return reply.code(403).send({ error: 'Workspace write denied' });
      if (result.outcome === 'key-reused') return reply.code(409).send({ error: 'Mutation ID already used for different content' });
      if (!result.replay && result.receipt.status === 'applied') {
        for (const [socket, peer] of peers) {
          if (peer.workspace === workspace && socket.readyState === socket.OPEN) {
            socket.send('changed', () => {});
          }
        }
      }
      return result.receipt;
    });

    api.get<{Params: {id: string}}>('/live/:id', {
      websocket: true,
      preValidation: async (request, reply) => {
        if (request.headers.origin !== origin) return reply.code(403).send({ error: 'Origin denied' });
        if (!uuid.safeParse(request.params.id).success) return reply.code(400).send({ error: 'Invalid workspace ID' });
        const session = await identify(request.cookies[cookieName]);
        if (!session) return reply.code(401).send({ error: 'Sign in required' });
        const workspace = request.params.id.toLowerCase();
        const allowed = await pool.query(
          'SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspace, session.id],
        );
        if (!allowed.rowCount) return reply.code(403).send({ error: 'Workspace access denied' });
      },
    }, (socket, request) => {
      socket.on('error', () => peers.delete(socket));
      socket.on('close', () => peers.delete(socket));
      socket.on('message', () => socket.close(1008));
      const token = request.cookies[cookieName];
      const workspace = request.params.id.toLowerCase();
      void identify(token).then((session) => {
        if (!session || socket.readyState !== socket.OPEN) return socket.close(1008);
        peers.set(socket, { workspace, session: session.session });
        socket.send('ready', () => {});
      }).catch(() => socket.close(1011));
    });
  }, { prefix: '/api' });

  const timer = setInterval(async () => {
    if (!peers.size) return;
    try {
      const active = await pool.query<{session: string; workspace: string}>(
        `SELECT s.digest AS session, m.workspace_id AS workspace
         FROM sessions s JOIN memberships m ON m.user_id=s.user_id
         WHERE s.digest=ANY($1::text[]) AND s.expires_at > now()`,
        [[...new Set([...peers.values()].map((peer) => peer.session))]],
      );
      const allowed = new Set(active.rows.map((row) => row.session + row.workspace));
      for (const [socket, peer] of peers) if (!allowed.has(peer.session + peer.workspace)) socket.close(1008);
    } catch {
      for (const socket of peers.keys()) socket.close(1011);
    }
  }, 15_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  if (webOrigin) await app.register(proxy, { upstream: webOrigin, websocket: true });
  return app;
}
