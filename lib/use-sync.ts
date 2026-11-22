'use client';

import { useEffect, useRef, useState } from 'react';
import { mutation, receiptSchema, snapshotSchema, type Mutation, type Receipt, type CachedSnapshot } from './model';
import { checkpoint, enqueue, readLocal, updatePending, type Pending } from './local';

export type Connection = 'Connecting' | 'Live' | 'Online' | 'Offline' | 'Access denied' | 'Storage unavailable' | 'Sync unavailable';

export function useSync(user: string, workspace: string, onSessionExpired: () => void) {
  const scope = user + ':' + workspace;
  const [state, setState] = useState<CachedSnapshot>();
  const [pending, setPending] = useState<Pending[]>([]);
  const [damaged, setDamaged] = useState(0);
  const [damagedSnapshot, setDamagedSnapshot] = useState(false);
  const [connection, setConnection] = useState<Connection>('Connecting');
  const notify = useRef<() => void>(() => {});
  const expired = useRef(onSessionExpired);

  useEffect(() => { expired.current = onSessionExpired; }, [onSessionExpired]);
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const endpoint = '/api/workspaces/' + workspace;
    const headers = { 'X-FieldSync-Actor': user };
    const outboxChannel = new BroadcastChannel('fieldsync-outbox');
    let running = false;
    let again = false;
    let denied = false;
    let socket: WebSocket | undefined;
    let retry = 0;

    async function refresh() {
      const cached = await readLocal(scope);
      if (!signal.aborted && !denied) {
        setState(cached.state);
        setPending(cached.pending);
        setDamaged(cached.damaged);
        setDamagedSnapshot(cached.damagedSnapshot);
      }
      return cached;
    }

    function checkAccess(response: Response) {
      if (signal.aborted) return false;
      if (response.status === 401) {
        expired.current();
        return false;
      }
      if (response.status === 403) {
        denied = true;
        setState(undefined);
        setPending([]);
        setDamaged(0);
        setDamagedSnapshot(false);
        setConnection('Access denied');
        socket?.close();
        return false;
      }
      return true;
    }

    async function sync() {
      if (signal.aborted) return;
      if (running) { again = true; return; }
      running = true;
      try {
        if (!navigator.onLine) {
          await refresh();
          if (!denied) setConnection('Offline');
          return;
        }
        // Authorize the current session before transmitting locally queued data.
        const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
        const boot = await fetch(endpoint, { headers, signal: requestSignal() });
        if (!checkAccess(boot)) return;
        if (!boot.ok) throw new Error('Workspace sync failed');
        denied = false;
        const initial = snapshotSchema.parse(await boot.json());
        let cacheFailed = false;
        let receiptFailed = false;
        await checkpoint(scope, initial).catch(() => { cacheFailed = true; });
        const cached = await refresh();
        if (cacheFailed && !signal.aborted) setState(initial);

        const open = new Set(initial.conflicts.map(({ operation }) => operation.id));
        const confirmed = new Map<string, Receipt>();
        for (const item of cached.pending) {
          if (signal.aborted) return;
          if (item.receipt?.status === 'rejected') continue;
          if (item.receipt?.status === 'conflict' &&
            (item.receipt.revision === undefined || open.has(item.operation.id))) continue;
          const response = await fetch(endpoint + '/mutations', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(item.operation), signal: requestSignal(),
          });
          if (signal.aborted) return;
          if (response.status === 401) { expired.current(); return; }
          let receipt: Receipt;
          if ([400, 403, 409].includes(response.status)) {
            const { error } = await response.json();
            receipt = { status: 'rejected', reason: error };
          } else {
            if (!response.ok) throw new Error('Mutation sync failed');
            receipt = receiptSchema.parse(await response.json());
          }
          await updatePending(item, { ...item, receipt }).catch(() => { receiptFailed = true; });
          if (receipt.status !== 'rejected') confirmed.set(item.operation.id, receipt);
        }
        let current = initial;
        if (confirmed.size) {
          const response = await fetch(endpoint, { headers, signal: requestSignal() });
          if (!checkAccess(response)) return;
          if (!response.ok) throw new Error('Checkpoint failed');
          current = snapshotSchema.parse(await response.json());
          cacheFailed = await checkpoint(scope, current, confirmed).then(() => false, () => true);
        }
        await refresh();
        if (signal.aborted) return;
        if (cacheFailed || receiptFailed) {
          setState(current);
          setConnection('Storage unavailable');
        } else {
          setConnection(socket?.readyState === WebSocket.OPEN ? 'Live' : 'Online');
        }
      } catch {
        if (!signal.aborted) {
          await refresh().catch(() => {});
          setConnection(denied ? 'Access denied' : navigator.onLine ? 'Sync unavailable' : 'Offline');
        }
      } finally {
        running = false;
        if (again) { again = false; void sync(); }
      }
    }

    function connect() {
      if (signal.aborted || denied || !navigator.onLine || socket) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(protocol + '//' + location.host + '/api/live/' + workspace);
      socket.onmessage = () => void sync();
      socket.onclose = () => {
        socket = undefined;
        if (!signal.aborted && !denied) {
          void sync();
          retry = window.setTimeout(connect, 3000);
        }
      };
    }

    function online() { void sync().then(connect); }
    function offline() {
      socket?.close();
      if (!denied) setConnection('Offline');
    }

    notify.current = () => {
      void refresh().catch(() => {});
      outboxChannel.postMessage(scope);
      void sync();
    };
    outboxChannel.onmessage = (event) => { if (event.data === scope) void sync(); };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    const poll = window.setInterval(online, 10_000);
    online();
    return () => {
      controller.abort();
      socket?.close();
      outboxChannel.close();
      notify.current = () => {};
      window.clearInterval(poll);
      window.clearTimeout(retry);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [scope, user, workspace]);

  async function queue(op: Mutation) {
    await enqueue(scope, mutation.parse(op));
    notify.current();
  }

  async function decide(item: Pending, keep: boolean, restored: boolean) {
    if (item.receipt?.status === 'conflict' && item.operation.kind === 'task.update') {
      const id = crypto.randomUUID();
      const resolves = item.operation.id;
      const operation: Mutation = keep
        ? { ...item.operation, id, version: item.receipt.current.version, resolves }
        : { kind: 'conflict.keep', id, entityId: item.operation.entityId, resolves, title: item.operation.title };
      if (restored) await enqueue(scope, operation);
      else if (!await updatePending(item, { scope, operation })) throw new Error('Conflict already changed');
    } else {
      await updatePending(item);
    }
    notify.current();
  }

  return { state, pending, connection, damaged, damagedSnapshot, queue, decide };
}
