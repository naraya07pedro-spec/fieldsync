import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { openPool } from '../server/db';
import { fixtures } from './fixtures';

const origin = 'http://127.0.0.1:3000';

async function signIn(page: Page, user: {email: string; password: string}) {
  await page.goto('/');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Field operations' })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  // Clear the password from the DOM on successful sign-in before evidence capture.
  await expect(page.getByLabel('Password')).toHaveCount(0);
}

async function stopGateway(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await done; } finally { clearTimeout(timeout); }
}

test('two browser sessions reconcile offline changes and retain data after restart', async ({ browser }, info) => {
  const pool = openPool();
  const f = await fixtures(pool).finally(() => pool.end());
  let gateway: ChildProcess | undefined;
  async function startGateway() {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: '3000', PUBLIC_ORIGIN: origin, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gateway = child;
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(output);
      return fetch(origin + '/api/health').then((result) => result.status).catch(() => 0);
    }, { timeout: 20_000 }).toBe(200);
  }
  async function evidence(page: Page, name: string) {
    const path = info.outputPath(name + '.png');
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
  }

  const first = await browser.newContext({ baseURL: origin });
  const second = await browser.newContext({ baseURL: origin, viewport: { width: 430, height: 900 } });
  const restricted = await browser.newContext({ baseURL: origin });
  const alice = await first.newPage();
  const bob = await second.newPage();
  try {
    await startGateway();
    await test.step('Independent browser contexts see a project and assigned task live', async () => {
      await Promise.all([signIn(alice, f.alex), signIn(bob, f.blair)]);
      await alice.getByLabel('Project name').fill('North site inspection');
      await alice.getByRole('button', { name: 'Add project' }).click();
      await expect(bob.getByRole('heading', { name: 'North site inspection' })).toBeVisible({ timeout: 5000 });
      await alice.getByLabel('New task').fill('Inspect fence');
      await alice.getByLabel('Assign to').selectOption({ label: 'Blair' });
      await alice.getByRole('button', { name: 'Add task' }).click();
      await expect(bob.getByRole('article', { name: 'Inspect fence' })).toContainText('Blair', { timeout: 5000 });
      await evidence(alice, '01-live-checklist');
    });

    await test.step('Blair reloads offline, edits a stale task and queues another task', async () => {
      await expect(bob.getByText('Offline reload available')).toBeVisible();
      await second.setOffline(true);
      await bob.reload();
      await expect(bob.getByText('Offline', { exact: true })).toBeVisible();
      const row = bob.getByRole('article', { name: 'Inspect fence' });
      await row.getByRole('button', { name: 'Edit' }).click();
      await row.getByLabel('Task name').fill('Fence needs repair');
      await row.getByRole('button', { name: 'Save task' }).click();
      await bob.getByLabel('New task').fill('Photograph west gate');
      await bob.getByRole('button', { name: 'Add task' }).click();
      await expect(bob.getByText('2 unsynced')).toBeVisible();
      await bob.reload();
      await expect(bob.getByText('2 unsynced')).toBeVisible();
      await expect(bob.getByText('Fence needs repair')).toBeVisible();
      await evidence(bob, '02-offline-queue-after-reload');
    });

    await test.step('Alex edits the same task, then Blair reconnects and resolves the conflict', async () => {
      const row = alice.getByRole('article', { name: 'Inspect fence' });
      await row.getByRole('button', { name: 'Edit' }).click();
      await row.getByLabel('Task name').fill('Fence secure');
      await row.getByLabel('Complete').check();
      await row.getByRole('button', { name: 'Save task' }).click();
      await expect(alice.getByRole('article', { name: 'Fence secure' })).toBeVisible();
      await second.setOffline(false);
      const conflict = bob.getByRole('region', { name: 'Changes needing attention' });
      await expect(conflict).toContainText('Fence needs repair');
      await expect(conflict).toContainText('Fence secure');
      await expect(alice.getByRole('article', { name: 'Photograph west gate' })).toBeVisible();
      await bob.reload();
      await expect(conflict).toContainText('Fence needs repair');
      await evidence(bob, '03-conflict-after-reconnect');
      const restored = await browser.newContext({ baseURL: origin });
      try {
        const device = await restored.newPage();
        await signIn(device, f.blair);
        const recovered = device.getByRole('region', { name: 'Changes needing attention' });
        await expect(recovered).toContainText('Fence needs repair');
        await expect(recovered).toContainText('Fence secure');
        await evidence(device, '06-server-conflict-on-clean-profile');
        await recovered.getByRole('button', { name: 'Use my edit' }).click();
        await expect(recovered).toHaveCount(0);
        await expect(device.getByText('0 unsynced')).toBeVisible();
      } finally {
        await restored.close();
      }
      await expect(conflict).toHaveCount(0);
      await expect(alice.getByRole('article', { name: 'Fence needs repair' })).toBeVisible({ timeout: 5000 });
      await expect(alice.getByText('resolved a conflict on', { exact: false })).toBeVisible();
    });

    await test.step('A live update preserves an open form and keep-server discards explicitly', async () => {
      const draft = bob.getByRole('article', { name: 'Photograph west gate' });
      await draft.getByRole('button', { name: 'Edit' }).click();
      await draft.getByLabel('Task name').fill('Local gate photo');

      const original = alice.getByRole('article', { name: 'Photograph west gate' });
      await original.getByRole('button', { name: 'Edit' }).click();
      await original.getByLabel('Complete').check();
      await original.getByRole('button', { name: 'Save task' }).click();
      await expect(draft.getByText('✓')).toBeVisible({ timeout: 5000 });
      await expect(draft.getByLabel('Task name')).toHaveValue('Local gate photo');
      await draft.getByRole('button', { name: 'Save task' }).click();
      const conflict = bob.getByRole('region', { name: 'Changes needing attention' });
      await expect(conflict).toContainText('Local gate photo');
      await conflict.getByRole('button', { name: 'Keep server version' }).click();
      await expect(conflict).toHaveCount(0);
      await expect(bob.getByText('0 unsynced')).toBeVisible();
      await expect(draft.getByText('✓')).toBeVisible();
    });

    await test.step('A lost acknowledgement is retried without duplicating the write', async () => {
      const path = '**/api/workspaces/*/mutations';
      let responseLost = false;
      await alice.route(path, async (route) => {
        const response = await route.fetch();
        responseLost = response.ok();
        await first.setOffline(true);
        await route.abort();
      }, { times: 1 });
      await alice.getByLabel('New task').fill('Verify gate latch');
      await alice.getByRole('button', { name: 'Add task' }).click();
      await expect.poll(() => responseLost).toBe(true);
      await expect(alice.getByText('1 unsynced')).toBeVisible();
      await expect(bob.getByRole('article', { name: 'Verify gate latch' })).toBeVisible();
      await expect(alice.getByText('Offline reload available')).toBeVisible();
      await stopGateway(gateway);
      if (process.env.FIELDSYNC_RESTART_DATABASE === '1') {
        execFileSync('docker', ['compose', 'restart', 'db'], { timeout: 30_000 });
      }
      await alice.reload();
      await expect(alice.getByText('1 unsynced')).toBeVisible();
      await evidence(alice, '07-pending-after-interrupted-ack');
      await startGateway();
      await first.setOffline(false);
      await expect(alice.getByText('0 unsynced')).toBeVisible();
      await expect(alice.getByRole('article', { name: 'Verify gate latch' })).toHaveCount(1);
      await expect(alice.getByRole('listitem').filter({
        hasText: 'added task Verify gate latch',
      })).toHaveCount(1);
    });

    await test.step('Two tabs cannot replace each other’s queued or open task draft', async () => {
      const sibling = await first.newPage();
      try {
        await sibling.goto('/');
        const label = 'Verify gate latch';
        const row = alice.getByRole('article', { name: label });
        const other = sibling.getByRole('article', { name: label });
        await row.getByRole('button', { name: 'Edit' }).click();
        await row.getByLabel('Task name').fill('First tab draft kept');
        await other.getByRole('button', { name: 'Edit' }).click();
        await other.getByLabel('Complete').check();
        await first.setOffline(true);
        await other.getByRole('button', { name: 'Save task' }).click();
        await expect(alice.getByText('1 unsynced')).toBeVisible();
        await first.setOffline(false);
        await expect(alice.getByText('0 unsynced')).toBeVisible();
        await expect(row.getByLabel('Task name')).toHaveValue('First tab draft kept');
        await row.getByRole('button', { name: 'Save task' }).click();
        const conflict = alice.getByRole('region', { name: 'Changes needing attention' });
        await expect(conflict).toContainText('First tab draft kept');
        await expect(conflict).toContainText(label);
        await conflict.getByRole('button', { name: 'Keep server version' }).click();
        await expect(alice.getByText('0 unsynced')).toBeVisible();
      } finally {
        await sibling.close();
      }
    });

    await test.step('A quota failure keeps the open draft and malformed records do not block healthy work', async () => {
      const row = alice.getByRole('article', { name: 'Verify gate latch' });
      await row.getByRole('button', { name: 'Edit' }).click();
      await row.getByLabel('Task name').fill('Latch proof recorded');
      await alice.evaluate(() => {
        const original = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey) {
          if (this.name !== 'outbox') return original.call(this, value, key);
          IDBObjectStore.prototype.add = original;
          this.transaction.abort();
          throw new DOMException('Test-injected storage quota failure', 'QuotaExceededError');
        };
      });
      await row.getByRole('button', { name: 'Save task' }).click();
      await expect(alice.getByRole('alert').filter({ hasText: 'Could not save on this device' })).toBeVisible();
      await expect(row.getByLabel('Task name')).toHaveValue('Latch proof recorded');
      await expect(alice.getByText('0 unsynced')).toBeVisible();
      await evidence(alice, '08-quota-error-preserves-form');
      await row.getByRole('button', { name: 'Save task' }).click();
      await expect(alice.getByRole('article', { name: 'Latch proof recorded' })).toBeVisible();
      await expect(alice.getByText('0 unsynced')).toBeVisible();

      await first.setOffline(true);
      await alice.getByLabel('New task').fill('Replay unverified receipt');
      await alice.getByRole('button', { name: 'Add task' }).click();
      await expect(alice.getByText('1 unsynced')).toBeVisible();
      const key = f.alex.id + ':' + f.field;
      const corruptedRecord = randomUUID();
      await alice.evaluate(async ({ key, corruptedRecord }) => {
        const request = indexedDB.open('fieldsync-v1');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const done = new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['outbox', 'snapshots'], 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
          const outbox = tx.objectStore('outbox');
          const pending = outbox.getAll(IDBKeyRange.bound([key], [key, []]));
          pending.onsuccess = () => {
            const queued = pending.result[0];
            outbox.put({ ...queued, receipt: { status: 'applied', revision: '0' } }, [key, queued.operation.entityId]);
            outbox.put({ operation: null }, [key, corruptedRecord]);
          };
          tx.objectStore('snapshots').put({ revision: 'invalid' }, key);
        });
        await done;
        db.close();
      }, { key, corruptedRecord });
      await alice.reload();
      await expect(alice.getByText('Unreadable queued changes: 1.', { exact: false })).toBeVisible();
      await expect(alice.getByText('The cached checklist is unreadable.', { exact: false })).toBeVisible();
      await first.setOffline(false);
      await expect(alice.getByRole('article', { name: 'Latch proof recorded' })).toBeVisible();
      await expect(alice.getByText('The cached checklist is unreadable.', { exact: false })).toHaveCount(0);
      await expect(bob.getByRole('article', { name: 'Replay unverified receipt' })).toBeVisible();
      await alice.getByLabel('New task').fill('Healthy follow-up');
      await alice.getByRole('button', { name: 'Add task' }).click();
      await expect(bob.getByRole('article', { name: 'Healthy follow-up' })).toBeVisible();
      await expect(alice.getByText('Unreadable queued changes: 1.', { exact: false })).toBeVisible();
    });

    await test.step('Snapshot quota failure still sends queued work and prevents premature cleanup', async () => {
      await first.setOffline(true);
      await alice.getByLabel('New task').fill('Deliver despite cache quota');
      await alice.getByRole('button', { name: 'Add task' }).click();
      await expect(alice.getByText('1 unsynced')).toBeVisible();
      await alice.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
          if (this.name !== 'snapshots') return original.call(this, value, key);
          this.transaction.abort();
          throw new DOMException('Test-injected snapshot quota failure', 'QuotaExceededError');
        };
      });
      await first.setOffline(false);
      await expect(bob.getByRole('article', { name: 'Deliver despite cache quota' })).toBeVisible();
      await expect(alice.getByText('Storage unavailable', { exact: true })).toBeVisible();
      await expect(alice.getByText('1 unsynced')).toBeVisible();
      await evidence(alice, '10-checkpoint-failure-retains-receipt');
      await alice.reload();
      await expect(alice.getByText('0 unsynced')).toBeVisible();
      await expect(alice.getByRole('article', { name: 'Deliver despite cache quota' })).toHaveCount(1);
      await expect(alice.getByRole('listitem').filter({ hasText: 'added task Deliver despite cache quota' })).toHaveCount(1);
    });

    await test.step('An expired session cannot send a queued edit until the same actor signs in', async () => {
      await second.setOffline(true);
      await bob.getByLabel('New task').fill('Resume after reauthentication');
      await bob.getByRole('button', { name: 'Add task' }).click();
      await expect(bob.getByText('1 unsynced')).toBeVisible();
      const db = openPool();
      try {
        await db.query('UPDATE sessions SET expires_at=now() WHERE user_id=$1', [f.blair.id]);
      } finally {
        await db.end();
      }
      await second.setOffline(false);
      await expect(bob.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await expect(alice.getByRole('article', { name: 'Resume after reauthentication' })).toHaveCount(0);
      await signIn(bob, f.blair);
      await expect(alice.getByRole('article', { name: 'Resume after reauthentication' })).toBeVisible();
      await expect(bob.getByText('0 unsynced')).toBeVisible();
    });

    await test.step('A viewer can read but the server rejects a write from their browser', async () => {
      const viewer = await restricted.newPage();
      await signIn(viewer, f.viewer);
      await expect(viewer.getByRole('article', { name: 'Fence needs repair' })).toBeVisible();
      await expect(viewer.getByRole('button', { name: 'Add task' })).toHaveCount(0);
      const outcome = await viewer.evaluate(async ({ field, actor, id }) => {
        const response = await fetch('/api/workspaces/' + field + '/mutations', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FieldSync-Actor': actor },
          body: JSON.stringify({ kind: 'project.create', title: 'Unauthorized', id, entityId: id }),
        });
        return { status: response.status, body: await response.json() };
      }, { field: f.field, actor: f.viewer.id, id: randomUUID() });
      expect(outcome).toEqual({ status: 403, body: { error: 'Workspace write denied' } });
      const path = info.outputPath('04-viewer-rejection.json');
      await writeFile(path, JSON.stringify(outcome, null, 2) + '\n');
      await info.attach('04-viewer-rejection', { path, contentType: 'application/json' });
      await restricted.setOffline(true);
      const db = openPool();
      try {
        await db.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [f.field, f.viewer.id]);
      } finally {
        await db.end();
      }
      await restricted.setOffline(false);
      await expect(viewer.getByText('Access denied', { exact: true })).toBeVisible();
      await expect(viewer.getByRole('article', { name: 'Fence needs repair' })).toHaveCount(0);
      await evidence(viewer, '09-revoked-workspace-hidden');
    });

    await test.step('Deleting browser storage loses an unsent edit and leaves server work intact', async () => {
      const isolated = await browser.newContext({ baseURL: origin });
      try {
        const device = await isolated.newPage();
        await signIn(device, f.alex);
        await expect(device.getByText('Offline reload available')).toBeVisible();
        const cachedRequests = await device.evaluate(async () => {
          const cache = await caches.open('fieldsync-shell-v1');
          return (await cache.keys()).map((request) => new URL(request.url).pathname);
        });
        expect(cachedRequests).toContain('/');
        expect(cachedRequests.some((path) => path.startsWith('/_next/static/'))).toBe(true);
        expect(cachedRequests.every((path) => path === '/' || path.startsWith('/_next/static/'))).toBe(true);

        await isolated.setOffline(true);
        await device.getByLabel('New task').fill('Unsent before storage eviction');
        await device.getByRole('button', { name: 'Add task' }).click();
        await expect(device.getByText('1 unsynced')).toBeVisible();
        await device.evaluate(() => new Promise<void>((resolve, reject) => {
          const deletion = indexedDB.deleteDatabase('fieldsync-v1');
          deletion.onsuccess = () => resolve();
          deletion.onerror = () => reject(deletion.error);
          deletion.onblocked = () => reject(new Error('An IndexedDB connection blocked eviction'));
        }));
        await device.reload();
        await expect(device.getByRole('heading', { name: 'Sign in' })).toBeVisible();
        await isolated.setOffline(false);
        await device.reload();
        await expect(device.getByRole('article', { name: 'Healthy follow-up' })).toBeVisible();
        await expect(device.getByText('0 unsynced')).toBeVisible();
        await expect(device.getByRole('article', { name: 'Unsent before storage eviction' })).toHaveCount(0);
        await expect(alice.getByRole('article', { name: 'Unsent before storage eviction' })).toHaveCount(0);
      } finally {
        await isolated.close();
      }
    });

    await test.step('A fresh session reads the checklist and history after restarting services', async () => {
      await Promise.all([first.close(), second.close(), restricted.close()]);
      await stopGateway(gateway);
      if (process.env.FIELDSYNC_RESTART_DATABASE === '1') {
        execFileSync('docker', ['compose', 'restart', 'db'], { timeout: 30_000 });
      }
      await startGateway();
      const fresh = await browser.newContext({ baseURL: origin });
      try {
        const page = await fresh.newPage();
        await signIn(page, f.alex);
        await expect(page.getByRole('article', { name: 'Fence needs repair' })).toBeVisible();
        await expect(page.getByRole('article', { name: 'Photograph west gate' })).toBeVisible();
        await expect(page.getByRole('article', { name: 'Latch proof recorded' })).toBeVisible();
        await expect(page.getByText('resolved a conflict on', { exact: false })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Unauthorized' })).toHaveCount(0);
        await evidence(page, '05-persisted-after-restart');
      } finally {
        await fresh.close();
      }
    });
  } finally {
    await Promise.all([first.close(), second.close(), restricted.close()]);
    await stopGateway(gateway);
  }
});
