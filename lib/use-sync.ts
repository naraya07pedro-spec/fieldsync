'use client';

import { useEffect, useRef, useState } from 'react';
import type { Mutation, Receipt, Snapshot } from './model';
import { checkpoint, enqueue, readLocal, updatePending, type Pending } from './local';

export type Connection = 'Connecting' | 'Live' | 'Online' | 'Offline' | 'Access denied' | 'Sync unavailable';

export function useSync(user: string, workspace: string, onSessionExpired: () => void) {
  const scope = user + ':' + workspace;
  const [state, setState] = useState<Snapshot>();
  const [pending, setPending] = useState<Pending[]>([]);
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
      }
      return cached;
    }

    function checkAccess(response: Response) {
      if (response.status === 401) {
        expired.current();
        return false;
      }
      if (response.status === 403) {
        denied = true;
        setState(undefined);
        setPending([]);
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
        const cached = await refresh();
        if (!navigator.onLine) {
          if (!denied) setConnection('Offline');
          return;
        }
        // Authorize the current session before transmitting locally queued data.
        const boot = await fetch(endpoint, { headers, signal });
        if (!checkAccess(boot)) return;
        if (!boot.ok) throw new Error('Workspace sync failed');
        denied = false;
        await checkpoint(scope, await boot.json());

        let wrote = false;
        for (const item of cached.pending) {
          if (item.receipt || signal.aborted) continue;
          const response = await fetch(endpoint + '/mutations', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(item.operation), signal,
          });
          if (response.status === 401) { expired.current(); return; }
          let receipt: Receipt;
          if ([400, 403, 409].includes(response.status)) {
            const { error } = await response.json();
            receipt = { status: 'rejected', reason: error };
          } else {
            if (!response.ok) throw new Error('Mutation sync failed');
            receipt = await response.json() as Receipt;
          }
          await updatePending(item, { ...item, receipt });
          wrote ||= receipt.status === 'applied';
        }
        if (wrote) {
          const current = await fetch(endpoint, { headers, signal });
          if (!checkAccess(current)) return;
          if (!current.ok) throw new Error('Checkpoint failed');
          await checkpoint(scope, await current.json());
        }
        await refresh();
        if (!signal.aborted) setConnection(socket?.readyState === WebSocket.OPEN ? 'Live' : 'Online');
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
    await enqueue(scope, op);
    notify.current();
  }

  async function decide(item: Pending, keep: boolean) {
    if (keep && item.receipt?.status === 'conflict' && item.operation.kind === 'task.update') {
      const operation = {
        ...item.operation, id: crypto.randomUUID(), version: item.receipt.current.version, resolves: item.operation.id,
      };
      await updatePending(item, { scope, operation });
    } else {
      await updatePending(item);
    }
    notify.current();
  }

  return { state, pending, connection, queue, decide };
}
