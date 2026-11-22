import { openDB, type DBSchema } from 'idb';
import type { Mutation, Profile, Receipt, Snapshot } from './model';

export type Pending = {
  scope: string;
  operation: Mutation;
  receipt?: Receipt;
};

interface LocalDB extends DBSchema {
  profile: { key: string; value: Profile };
  snapshots: { key: string; value: Snapshot };
  outbox: { key: [string, string]; value: Pending; indexes: { scope: string } };
}

const local = () => openDB<LocalDB>('fieldsync-v1', 1, {
  upgrade(db) {
    db.createObjectStore('profile');
    db.createObjectStore('snapshots');
    db.createObjectStore('outbox').createIndex('scope', 'scope');
  },
});

export async function cachedProfile() {
  return (await local()).get('profile', 'active');
}

export async function remember(profile?: Profile) {
  const db = await local();
  if (profile) await db.put('profile', profile, 'active');
  else await db.delete('profile', 'active');
}

export async function readLocal(scope: string) {
  const db = await local();
  const tx = db.transaction(['snapshots', 'outbox']);
  const [state, pending] = await Promise.all([
    tx.objectStore('snapshots').get(scope),
    tx.objectStore('outbox').index('scope').getAll(scope),
  ]);
  return { state, pending };
}

export async function enqueue(scope: string, operation: Mutation) {
  const db = await local();
  await db.add('outbox', { scope, operation }, [scope, operation.entityId]);
}

export async function updatePending(item: Pending, replacement?: Pending) {
  const db = await local();
  const tx = db.transaction('outbox', 'readwrite');
  const key: [string, string] = [item.scope, item.operation.entityId];
  const entry = await tx.store.get(key);
  if (entry?.operation.id === item.operation.id) {
    if (replacement) await tx.store.put(replacement, key);
    else await tx.store.delete(key);
  }
  await tx.done;
}

export async function checkpoint(scope: string, state: Snapshot) {
  const db = await local();
  const tx = db.transaction(['snapshots', 'outbox'], 'readwrite');
  const snapshots = tx.objectStore('snapshots');
  const former = await snapshots.get(scope);
  const revision = BigInt(state.revision);
  if (!former || BigInt(former.revision) <= revision) await snapshots.put(state, scope);
  const outbox = tx.objectStore('outbox');
  for (const item of await outbox.index('scope').getAll(scope)) {
    if (item.receipt?.status === 'applied' && BigInt(item.receipt.revision) <= revision) {
      await outbox.delete([scope, item.operation.entityId]);
    }
  }
  await tx.done;
}
