import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { digest } from '../server/auth';
import { createApi } from '../server/api';
import { openPool } from '../server/db';
import { fixtures } from './fixtures';
import type { Mutation, Task } from '../lib/model';

const origin = 'http://localhost:3000';

test('FieldSync PostgreSQL integration', async (suite) => {
  const pool = openPool();
  const fixture = await fixtures(pool);
  let app = await createApi(pool, origin);
  suite.after(async () => { await app.close(); await pool.end(); });
  const login = (user: typeof fixture.alex, from = origin, password = user.password) => app.inject({
    method: 'POST', url: '/api/login', headers: { origin: from }, payload: { email: user.email, password },
  });
  const alex = await login(fixture.alex);
  const blair = await login(fixture.blair);
  const viewer = await login(fixture.viewer);
  const outsider = await login(fixture.outsider);
  function headers(response = alex, actor = fixture.alex) {
    return { origin, cookie: response.headers['set-cookie']?.toString().split(';')[0] ?? '', 'x-fieldsync-actor': actor.id };
  }
  const endpoint = '/api/workspaces/' + fixture.field;
  const read = (requestHeaders = headers(), ws = endpoint) => app.inject({ url: ws, headers: requestHeaders });
  const write = (op: Mutation, requestHeaders = headers(), ws = endpoint) =>
    app.inject({ method: 'POST', url: ws + '/mutations', headers: requestHeaders, payload: op });
  const project = { kind: 'project.create', id: randomUUID(), entityId: randomUUID(), title: 'North site' } as const;
  const task = { kind: 'task.create', id: randomUUID(), entityId: randomUUID(), projectId: project.entityId,
    title: 'Inspect fence', done: false, assigneeId: fixture.blair.id } as const;
  const edit = { kind: 'task.update', id: randomUUID(), entityId: task.entityId, version: 1,
    title: 'Fence secure', done: true, assigneeId: fixture.blair.id } as const;

  await suite.test('authentication, cookie policy, origin, input validation and logout', async () => {
    assert.equal(alex.statusCode, 200);
    assert.match(String(alex.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.equal((await login(fixture.alex, origin, 'wrong')).statusCode, 401);
    assert.equal((await login(fixture.alex, 'https://untrusted.example')).statusCode, 403);
    assert.equal((await app.inject({url: endpoint})).statusCode, 401);
    assert.equal((await read(headers(alex, fixture.blair))).statusCode, 401);
    assert.equal((await read(headers(), '/api/workspaces/not-a-uuid')).statusCode, 400);
    assert.equal((await write(project, {...headers(), origin: 'https://untrusted.example'})).statusCode, 403);
    assert.equal((await write({...project, title: ' '})).statusCode, 400);
    assert.equal((await write({...project, title: 'NUL\u0000'})).statusCode, 400);
    assert.equal((await write({...project, title: 'Invalid Unicode \ud800'})).statusCode, 400);
    const extra = await login(fixture.alex);
    assert.equal((await app.inject({method: 'POST', url: '/api/logout', headers: headers(extra)})).statusCode, 200);
    assert.equal((await read(headers(extra))).statusCode, 401);
    const expiring = await login(fixture.alex);
    const token = headers(expiring).cookie.split('=')[1];
    await pool.query('UPDATE sessions SET expires_at=now() WHERE digest=encode(sha256(convert_to($1,\'UTF8\')),\'hex\')', [token]);
    assert.equal((await read(headers(expiring))).statusCode, 401);
  });

  await suite.test('workspace isolation and viewer authorization', async () => {
    assert.equal((await read(headers(outsider, fixture.outsider))).statusCode, 403);
    assert.equal((await write(project, headers(outsider, fixture.outsider))).statusCode, 403);
    assert.equal((await read(headers(), '/api/workspaces/' + fixture.other)).statusCode, 403);
    assert.equal((await read(headers(viewer, fixture.viewer))).statusCode, 200);
    assert.equal((await write(project, headers(viewer, fixture.viewer))).statusCode, 403);
    assert.equal((await read()).json().revision, '0');
  });

  await suite.test('concurrent replay is exactly one change and altered replay is rejected', async () => {
    const replies = await Promise.all(Array.from({length: 8}, () => write(project)));
    for (const response of replies) assert.deepEqual(response.json(), {status: 'applied', revision: '1'});
    assert.equal((await write({...project, title: 'Different content'})).statusCode, 409);
    assert.equal((await write({...task, id: randomUUID(), assigneeId: fixture.outsider.id})).json().status, 'rejected');
    assert.equal((await write({...task, id: randomUUID(), projectId: randomUUID()})).json().status, 'rejected');
    assert.equal((await write(task)).json().revision, '2');
    assert.equal((await read()).json().activity.length, 2);
  });

  let loser: Extract<Mutation, {kind: 'task.update'}> = edit;
  let losingHeaders = headers();
  await suite.test('concurrent edits conflict, preserve both proposals and require fresh compare-and-swap', async () => {
    const another = {...edit, id: randomUUID(), title: 'Fence needs repair', done: false};
    const otherHeaders = headers(blair, fixture.blair);
    const replies = await Promise.all([write(edit), write(another, otherHeaders)]);
    const results = replies.map((response) => response.json());
    assert.deepEqual(results.map((result) => result.status).sort(), ['applied', 'conflict']);
    const index = results.findIndex((result) => result.status === 'conflict');
    loser = index === 0 ? edit : another;
    losingHeaders = index === 0 ? headers() : otherHeaders;
    const rejected: Task = results[index].current;
    assert.equal(rejected.version, 2);
    assert.notEqual(rejected.title, loser.title);
    assert.deepEqual((await write(loser, losingHeaders)).json(), results[index]);
    assert.equal((await write({...loser, id: randomUUID(), version: 2, resolves: randomUUID()}, losingHeaders)).json().status, 'rejected');
    assert.equal((await write({...loser, id: randomUUID(), version: 2, resolves: loser.id}, losingHeaders)).json().revision, '5');
    assert.equal((await read()).json().tasks[0].title, loser.title);
    assert.equal((await read()).json().activity[0].resolves, loser.id);
  });

  await suite.test('WebSocket origin, membership and live invalidation over a real TCP connection', {timeout: 8000}, async () => {
    const addr = await app.listen({host: '127.0.0.1', port: 0});
    const route = addr.replace('http:', 'ws:') + '/api/live/' + fixture.field;
    for (const [wsOrigin, auth, status] of [
      ['https://untrusted.example', headers().cookie, 403],
      [origin, headers(outsider, fixture.outsider).cookie, 403],
      [origin, '', 401],
    ] as const) {
      const client = new WebSocket(route, {origin: wsOrigin, headers: {cookie: auth}});
      await new Promise<void>((resolve, reject) => {
        client.once('unexpected-response', (_req, response) => {
          response.resume();
          if (response.statusCode === status) resolve();
          else reject(new Error('Unexpected status ' + response.statusCode));
        });
        client.once('error', reject);
      });
    }
    const client = new WebSocket(route, {origin, headers: {cookie: headers().cookie}});
    try {
      const [ready] = await once(client, 'message');
      assert.equal(ready.toString(), 'ready');
      const message = once(client, 'message');
      await write({...project, id: randomUUID(), entityId: randomUUID(), title: 'Another site'});
      const [changed] = await message;
      assert.equal(changed.toString(), 'changed');
    } finally {
      client.terminate();
    }
  });

  await suite.test('API recreation preserves session, data, history and mutation receipt', async () => {
    await app.close();
    app = await createApi(pool, origin);
    const state = (await read()).json();
    assert.equal(state.revision, '6');
    assert.equal(state.activity.length, 5);
    assert.equal(state.tasks[0].title, loser.title);
    assert.deepEqual((await write(project)).json(), {status: 'applied', revision: '1'});
    assert.equal((await read()).json().revision, '6');
  });

  await suite.test('HTTPS cookies, session rotation and stale-tab logout', async () => {
    const secureApi = await createApi(pool, 'https://field.example.test');
    try {
      const secure = await secureApi.inject({
        method: 'POST', url: '/api/login', headers: {origin: 'https://field.example.test'},
        payload: {email: fixture.alex.email, password: fixture.alex.password},
      });
      assert.equal(secure.statusCode, 200);
      assert.match(String(secure.headers['set-cookie']), /^__Host-fieldsync=.*; Path=\/.*; HttpOnly; Secure; SameSite=Strict/);
    } finally {
      await secureApi.close();
    }

    const old = await login(fixture.alex);
    const signedIn = await app.inject({
      method: 'POST', url: '/api/login', headers: headers(old),
      payload: {email: fixture.blair.email, password: fixture.blair.password},
    });
    assert.equal(signedIn.statusCode, 200);
    assert.equal((await read(headers(old))).statusCode, 401);
    assert.equal((await app.inject({method: 'POST', url: '/api/logout', headers: headers(signedIn)})).statusCode, 401);
    assert.equal((await read(headers(signedIn, fixture.blair))).statusCode, 200);
  });

  await suite.test('a mutation queued at the session lock cannot commit after revocation', {timeout: 7000}, async () => {
    const session = await login(fixture.alex);
    const token = headers(session).cookie.split('=')[1];
    const op = {...project, id: randomUUID(), entityId: randomUUID(), title: 'Revocation check'};
    const db = await pool.connect();
    let request: ReturnType<typeof write> | undefined;
    try {
      await db.query('BEGIN');
      await db.query('SELECT 1 FROM sessions WHERE digest=$1 FOR UPDATE', [digest(token)]);
      request = write(op, headers(session));
      const deadline = Date.now() + 4000;
      while (true) {
        const waiters = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
           AND query LIKE 'SELECT 1 FROM sessions WHERE digest=%clock_timestamp()%FOR SHARE'`,
        );
        if (waiters.rowCount) break;
        assert.ok(Date.now() < deadline, 'request did not reach authorization lock');
        await delay(30);
      }
      await db.query('DELETE FROM sessions WHERE digest=$1', [digest(token)]);
      await db.query('COMMIT');
      assert.equal((await request).statusCode, 401);
      assert.ok(!(await read()).json().projects.some((item: {id: string}) => item.id === op.entityId));
    } finally {
      await db.query('ROLLBACK');
      db.release();
      await request;
    }
  });

  await suite.test('a PostgreSQL receipt failure rolls back entity, activity and revision before retry', async () => {
    const op = {...project, id: randomUUID(), entityId: randomUUID(), title: 'Atomic rollback check'};
    const before = (await read()).json();
    await pool.query(`ALTER TABLE receipts ADD CONSTRAINT test_receipt_fault CHECK (id <> '${op.id}'::uuid)`);
    try {
      const failure = await write(op);
      assert.equal(failure.statusCode, 500);
      assert.deepEqual(failure.json(), {error: 'Service unavailable'});
      assert.deepEqual((await read()).json(), before);
      assert.equal((await pool.query('SELECT 1 FROM receipts WHERE id=$1', [op.id])).rowCount, 0);
    } finally {
      await pool.query('ALTER TABLE receipts DROP CONSTRAINT test_receipt_fault');
    }
    const retry = await write(op);
    assert.equal(retry.json().revision, String(BigInt(before.revision) + 1n));
    assert.deepEqual((await write(op)).json(), retry.json());
  });

  await suite.test('server retains private conflict proposals and allows only one resolution', async () => {
    const current = (await read()).json().tasks[0] as Task;
    const stale = {...edit, id: randomUUID(), title: 'Recoverable proposal', version: current.version - 1};
    const result = (await write(stale)).json();
    assert.equal(result.status, 'conflict');
    const owner = (await read()).json();
    assert.deepEqual(owner.conflicts, [{operation: stale, receipt: result}]);
    assert.deepEqual((await read(headers(blair, fixture.blair))).json().conflicts, []);
    const decision = {kind: 'conflict.keep', id: randomUUID(), entityId: stale.entityId,
      resolves: stale.id, title: stale.title} as const;
    assert.equal((await write(decision, headers(blair, fixture.blair))).json().status, 'rejected');
    const kept = (await write(decision)).json();
    assert.equal(kept.status, 'applied');
    assert.deepEqual((await write(decision)).json(), kept);
    assert.equal((await write({...stale, id: randomUUID(), version: current.version, resolves: stale.id})).json().status, 'rejected');
    assert.deepEqual((await read()).json().conflicts, []);
    assert.deepEqual((await read()).json().tasks[0], current);
  });

  await suite.test('an already connected browser socket is closed before a post-revocation invalidation', {timeout: 8000}, async () => {
    const addr = await app.listen({host: '127.0.0.1', port: 0});
    const route = addr.replace('http:', 'ws:') + '/api/live/' + fixture.field;
    const client = new WebSocket(route, {origin, headers: {cookie: headers(viewer, fixture.viewer).cookie}});
    try {
      const [ready] = await once(client, 'message');
      assert.equal(ready.toString(), 'ready');
      const messages: string[] = [];
      client.on('message', (message) => messages.push(message.toString()));
      const closed = once(client, 'close');
      await pool.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [fixture.field, fixture.viewer.id]);
      assert.equal((await read(headers(viewer, fixture.viewer))).statusCode, 403);
      const change = await write({...project, id: randomUUID(), entityId: randomUUID()});
      assert.equal(change.json().status, 'applied');
      const [code] = await closed;
      assert.equal(code, 1008);
      assert.deepEqual(messages, []);
    } finally {
      client.terminate();
    }
  });

});
