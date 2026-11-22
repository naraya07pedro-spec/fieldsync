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
import { transaction } from './db';
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
  const peers = new Map<WebSocket, { workspace: string; session: string; user: string }>();
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 } });
  await app.register(throttle, { global: false });

  async function identify(token?: string) {
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    const session = digest(token);
    return (await pool.query<{ id: string; name: string; session: string; expires_at: Date }>(
      `SELECT u.id, u.name, s.digest AS session, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
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
      const previous = request.cookies[cookieName];
      await transaction(pool, async (db) => {
        if (previous && /^[\w-]{43}$/.test(previous)) {
          await db.query('DELETE FROM sessions WHERE digest=$1', [digest(previous)]);
        }
        await db.query(
          `INSERT INTO sessions (digest,user_id,expires_at) VALUES ($1,$2,now() + $3 * interval '1 second')`,
          [digest(token), account.id, sessionSeconds],
        );
      });
      if (previous) for (const [socket, peer] of peers) if (peer.session === digest(previous)) socket.close(1008);
      return reply.setCookie(cookieName, token, { ...cookiePolicy, maxAge: sessionSeconds }).send({ ok: true });
    });

    api.post('/logout', async (request, reply) => {
      const session = await identify(request.cookies[cookieName]);
      if (session) {
        if (request.headers['x-fieldsync-actor'] !== session.id) {
          return reply.code(401).send({ error: 'Session changed' });
        }
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
      return { id, name, expiresAt: session.expires_at.toISOString(), workspaces: rows } satisfies Profile;
    });

    api.get<{Params: {id: string}}>('/workspaces/:id', async (request, reply) => {
      const session = await identify(request.cookies[cookieName]);
      if (!session) return reply.code(401).send({ error: 'Sign in required' });
      if (!uuid.safeParse(request.params.id).success) return reply.code(400).send({ error: 'Invalid workspace ID' });
      if (request.headers['x-fieldsync-actor'] !== session.id) return reply.code(401).send({ error: 'Session changed' });
      const state = await snapshot(pool, request.params.id, session);
      if (state.outcome === 'unauthenticated') return reply.code(401).send({ error: 'Sign in required' });
      if (state.outcome === 'forbidden') return reply.code(403).send({ error: 'Workspace access denied' });
      return state.value;
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
      const result = await mutate(pool, workspace, session, parsed.data);
      if (result.outcome === 'unauthenticated') return reply.code(401).send({ error: 'Sign in required' });
      if (result.outcome === 'forbidden') return reply.code(403).send({ error: 'Workspace write denied' });
      if (result.outcome === 'key-reused') return reply.code(409).send({ error: 'Mutation ID already used for different content' });
      if (!result.replay && result.receipt.status !== 'rejected') {
        const targets = [...peers].filter(([,peer]) => peer.workspace === workspace);
        const privateChange = result.receipt.status === 'conflict' || parsed.data.kind === 'conflict.keep';
        const notify = privateChange ? targets.filter(([,peer]) => peer.user === session.id) : targets;
        void updatePeers(notify, 'changed');
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
      void identify(token).then(async (session) => {
        if (!session || socket.readyState !== socket.OPEN) return socket.close(1008);
        const peer = { workspace, session: session.session, user: session.id };
        peers.set(socket, peer);
        await updatePeers([[socket, peer]], 'ready');
      }).catch(() => socket.close(1011));
    });
  }, { prefix: '/api' });

  async function updatePeers(targets: [WebSocket, {workspace: string; session: string; user: string}][], message?: string) {
    if (!targets.length) return;
    try {
      const active = await pool.query<{session: string; workspace: string}>(
        `SELECT s.digest AS session, m.workspace_id AS workspace
         FROM sessions s JOIN memberships m ON m.user_id=s.user_id
         WHERE s.digest=ANY($1::text[]) AND s.expires_at > clock_timestamp()`,
        [[...new Set(targets.map(([,peer]) => peer.session))]],
      );
      const allowed = new Set(active.rows.map((row) => row.session + row.workspace));
      for (const [socket, peer] of targets) {
        if (socket.readyState !== socket.OPEN) continue;
        if (!allowed.has(peer.session + peer.workspace)) socket.close(1008);
        else if (message) socket.send(message, () => {});
      }
    } catch {
      for (const [socket] of targets) socket.close(1011);
    }
  }

  const timer = setInterval(() => void updatePeers([...peers]), 15_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  if (webOrigin) await app.register(proxy, {
    upstream: webOrigin,
    websocket: process.env.NODE_ENV !== 'production',
    replyOptions: {
      rewriteRequestHeaders(_request, headers) {
        const forwarded = { ...headers };
        delete forwarded.cookie;
        delete forwarded.authorization;
        delete forwarded['x-fieldsync-actor'];
        return forwarded;
      },
    },
  });
  return app;
}
