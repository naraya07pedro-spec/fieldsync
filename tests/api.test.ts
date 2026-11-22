import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
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
    assert.equal((await write({...loser, id: randomUUID(), version: 2, resolves: loser.id}, losingHeaders)).json().revision, '4');
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
    assert.equal(state.revision, '5');
    assert.equal(state.activity.length, 5);
    assert.equal(state.tasks[0].title, loser.title);
    assert.deepEqual((await write(project)).json(), {status: 'applied', revision: '1'});
    assert.equal((await read()).json().revision, '5');
  });
});
