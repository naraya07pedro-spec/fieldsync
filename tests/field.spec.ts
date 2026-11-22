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
      env: { ...process.env, PORT: '3000', PUBLIC_ORIGIN: origin },
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
      await conflict.getByRole('button', { name: 'Use my edit' }).click();
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
      await first.setOffline(false);
      await expect(alice.getByText('0 unsynced')).toBeVisible();
      await expect(alice.getByRole('article', { name: 'Verify gate latch' })).toHaveCount(1);
      await expect(alice.getByRole('listitem').filter({
        hasText: 'added task Verify gate latch',
      })).toHaveCount(1);
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
        await expect(page.getByRole('article', { name: 'Verify gate latch' })).toBeVisible();
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
