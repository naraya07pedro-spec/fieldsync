import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { mutation, profileSchema, receiptSchema, snapshotCacheSchema, type Mutation, type Profile, type Receipt, type Snapshot } from './model';

export type Pending = {
  scope: string;
  operation: Mutation;
  receipt?: Receipt;
};

interface LocalDB extends DBSchema {
  profile: { key: string; value: unknown };
  snapshots: { key: string; value: unknown };
  outbox: { key: [string, string]; value: unknown; indexes: { scope: string } };
}

const durable = { durability: 'strict' } as const;
let connection: Promise<IDBPDatabase<LocalDB>> | undefined;

function local() {
  connection ??= openDB<LocalDB>('fieldsync-v1', 1, {
    upgrade(db) {
      db.createObjectStore('profile');
      db.createObjectStore('snapshots');
      db.createObjectStore('outbox').createIndex('scope', 'scope');
    },
    blocking(_version, _next, event) {
      (event.target as IDBDatabase).close();
      connection = undefined;
    },
    terminated() { connection = undefined; },
  }).catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return connection;
}
const bounds = (scope: string) => IDBKeyRange.bound([scope], [scope, []], false, true);

function pendingValue(raw: unknown, scope: string, entity: string): Pending | undefined {
  if (!raw || typeof raw !== 'object' || !('operation' in raw)) return;
  const operation = mutation.safeParse(raw.operation);
  if (!operation.success || operation.data.entityId !== entity) return;
  const parsed = receiptSchema.safeParse('receipt' in raw ? raw.receipt : undefined);
  const receipt = parsed.data;
  return {
    scope, operation: operation.data,
    receipt: receipt?.status === 'conflict' && receipt.current.id !== entity ? undefined : receipt,
  };
}

export async function cachedProfile() {
  return profileSchema.safeParse(await (await local()).get('profile', 'active')).data;
}

export async function remember(profile: Profile) {
  await (await local()).put('profile', profile, 'active');
}

export async function forgetProfile(expected?: string) {
  const tx = (await local()).transaction('profile', 'readwrite', durable);
  const old = profileSchema.safeParse(await tx.store.get('active')).data;
  if (!expected || expected === old?.id) await tx.store.delete('active');
  await tx.done;
}

export async function readLocal(scope: string) {
  const tx = (await local()).transaction(['snapshots', 'outbox']);
  const raw = await tx.objectStore('snapshots').get(scope);
  const pending: Pending[] = [];
  let damaged = 0;
  const store = tx.objectStore('outbox');
  for (let cursor = await store.openCursor(bounds(scope)); cursor; cursor = await cursor.continue()) {
    const item = pendingValue(cursor.value, scope, cursor.key[1]);
    if (item) pending.push(item);
    else damaged++;
  }
  const state = snapshotCacheSchema.safeParse(raw);
  return { state: state.data, pending, damaged, damagedSnapshot: raw !== undefined && !state.success };
}

export async function enqueue(scope: string, operation: Mutation) {
  const tx = (await local()).transaction('outbox', 'readwrite', durable);
  await Promise.all([tx.done, Promise.resolve().then(() => tx.store.add({ scope, operation }, [scope, operation.entityId]))]);
}

export async function updatePending(item: Pending, replacement?: Pending) {
  const tx = (await local()).transaction('outbox', 'readwrite', durable);
  const key: [string, string] = [item.scope, item.operation.entityId];
  const entry = pendingValue(await tx.store.get(key), ...key);
  const matched = entry?.operation.id === item.operation.id;
  if (matched) {
    await Promise.all([replacement ? tx.store.put(replacement, key) : tx.store.delete(key), tx.done]);
  } else {
    await tx.done;
  }
  return matched;
}

export async function checkpoint(scope: string, state: Snapshot, confirmed = new Map<string, Receipt>()) {
  const tx = (await local()).transaction(['snapshots', 'outbox'], 'readwrite', durable);
  // Attach the rejection handler before any request so quota and abort failures reach the caller.
  await Promise.all([tx.done, (async () => {
    const snapshots = tx.objectStore('snapshots');
    const former = snapshotCacheSchema.safeParse(await snapshots.get(scope)).data;
    const revision = BigInt(state.revision);
    if (former && BigInt(former.revision) > revision) return;
    await snapshots.put(state, scope);
    const open = new Set(state.conflicts.map((item) => item.operation.id));
    const outbox = tx.objectStore('outbox');
    for (let cursor = await outbox.openCursor(bounds(scope)); cursor; cursor = await cursor.continue()) {
      const item = pendingValue(cursor.value, scope, cursor.key[1]);
      if (!item) continue;
      const receipt = confirmed.get(item.operation.id);
      if (!receipt || receipt.status === 'rejected' || receipt.revision === undefined) continue;
      if (BigInt(receipt.revision) > revision) continue;
      if (receipt.status === 'applied' || !open.has(item.operation.id)) await cursor.delete();
    }
  })()]);
}
