'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { profileSchema, type Profile, type Snapshot, type Task } from '../lib/model';
import { cachedProfile, forgetProfile, remember, type Pending } from '../lib/local';
import { useSync } from '../lib/use-sync';

async function prepareOffline() {
  if (!('serviceWorker' in navigator) || process.env.NODE_ENV !== 'production') return false;
  await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
  const registration = await navigator.serviceWorker.ready;
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => { channel.port1.close(); resolve(false); }, 8000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data === true);
    };
    registration.active?.postMessage({ kind: 'prime' }, [channel.port2]);
  });
}

const profileMarker = 'fieldsync-offline-account';

function markAccount(account: string) {
  try { localStorage.setItem(profileMarker, account); } catch { /* Offline identity remains unavailable. */ }
}

export default function Board() {
  const [profile, setProfile] = useState<Profile>();
  const authGeneration = useRef(0);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [selected, setSelected] = useState('');
  const active = profile?.workspaces.find((item) => item.id === selected) ?? profile?.workspaces[0];

  useEffect(() => {
    const channel = new BroadcastChannel('fieldsync-auth');
    let current = true;
    async function initialize() {
      const generation = ++authGeneration.current;
      const active = () => current && generation === authGeneration.current;
      try {
        const response = await fetch('/api/me', { signal: AbortSignal.timeout(10_000) });
        if (!active()) return;
        if (response.status === 401) {
          markAccount('');
          setProfile(undefined);
          await forgetProfile().catch(() => {});
        } else if (response.ok) {
          const user = profileSchema.parse(await response.json());
          if (!active()) return;
          markAccount(user.id);
          setProfile(user);
          await remember(user).catch(() => {
            if (active()) setError('Offline profile storage is unavailable on this device.');
          });
        } else {
          throw new Error('Profile unavailable');
        }
      } catch {
        const cached = await cachedProfile().catch(() => undefined);
        const expected = (() => {
          try { return localStorage.getItem(profileMarker); } catch { return null; }
        })();
        if (active()) setProfile(expected && cached?.id === expected && Date.parse(cached.expiresAt) > Date.now()
          ? cached : undefined);
      } finally {
        if (active()) setChecked(true);
      }
    }
    channel.onmessage = () => { setProfile(undefined); void initialize(); };
    void initialize();
    const prime = () => void prepareOffline().then((ready) => {
      if (current && ready) setOfflineReady(true);
    }).catch(() => {});
    prime();
    window.addEventListener('online', prime);
    return () => {
      current = false;
      channel.close();
      window.removeEventListener('online', prime);
    };
  }, []);

  function notifyAuth() {
    const channel = new BroadcastChannel('fieldsync-auth');
    channel.postMessage('changed');
    channel.close();
  }

  const expired = useCallback(() => {
    const former = profile?.id;
    setProfile(undefined);
    setError('Sign in to resume synchronization. Queued changes are saved on this device.');
    if (former) {
      try { if (localStorage.getItem(profileMarker) === former) markAccount(''); } catch { /* Storage unavailable. */ }
      void forgetProfile(former).catch(() => {});
    }
  }, [profile?.id]);

  useEffect(() => {
    if (!profile) return;
    const timer = window.setTimeout(expired, Math.max(0, Date.parse(profile.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [profile, expired]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const generation = ++authGeneration.current;
    const data = new FormData(event.currentTarget);
    setWorking(true);
    setError('');
    try {
      const response = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.get('email'), password: data.get('password') }),
      });
      if (!response.ok) {
        setError(response.status === 429 ? 'Too many attempts. Try again in a minute.' : 'Check your email and password.');
        return;
      }
      const result = await fetch('/api/me');
      if (!result.ok) throw new Error();
      const user = profileSchema.parse(await result.json());
      if (generation !== authGeneration.current) return;
      markAccount(user.id);
      setProfile(user);
      notifyAuth();
      await remember(user).catch(() => setError('Offline profile storage is unavailable on this device.'));
    } catch {
      setError('Sign-in is unavailable. Check your connection and browser storage.');
    } finally {
      setWorking(false);
    }
  }

  async function logout() {
    if (!profile || working) return;
    setWorking(true);
    setError('');
    try {
      const response = await fetch('/api/logout', {
        method: 'POST', headers: { 'X-FieldSync-Actor': profile.id },
      });
      if (!response.ok && response.status !== 401) throw new Error();
      const generation = ++authGeneration.current;
      try { if (localStorage.getItem(profileMarker) === profile.id) markAccount(''); } catch { /* Storage unavailable. */ }
      setProfile(undefined);
      notifyAuth();
      await forgetProfile(profile.id).catch(() => {
        if (generation === authGeneration.current) setError('Signed out. Browser profile cleanup could not be completed.');
      });
    } catch {
      setError('Reconnect to sign out.');
    } finally {
      setWorking(false);
    }
  }

  return <>
    <header className="top">
      <div className="brand"><span aria-hidden="true" className="mark">F</span> FieldSync</div>
      {profile && <div className="identity"><span>{profile.name}</span><button className="secondary" onClick={logout} disabled={working}>Sign out</button></div>}
    </header>
    <main>
      {error && <p role="alert" className="notice">{error}</p>}
      {!checked && <p role="status">Opening FieldSync…</p>}
      {checked && !profile && <section className="login panel">
        <h1>Sign in</h1>
        <p className="muted">Open your field workspace.</p>
        <form onSubmit={login}>
          <label>Email<input name="email" type="email" autoComplete="username" required /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
          <button disabled={working}>Sign in</button>
        </form>
      </section>}
      {profile && !active && <p>No workspace access. Contact your workspace administrator.</p>}
      {profile && active && <>
        <div className="workspace-bar">
          {profile.workspaces.length > 1
            ? <label>Workspace<select value={active.id} onChange={(e) => setSelected(e.target.value)}>
                {profile.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
              </select></label>
            : <span>{active.name}</span>}
          {offlineReady && <span className="muted">Offline reload available</span>}
        </div>
        <Workspace key={profile.id + active.id} user={profile.id} workspace={active} onExpired={expired} />
      </>}
    </main>
  </>;
}

type WorkspaceProps = {user: string; workspace: Profile['workspaces'][number]; onExpired: () => void};

function Workspace({ user, workspace, onExpired }: WorkspaceProps) {
  const { state, pending, connection, damaged, damagedSnapshot, queue, decide } = useSync(user, workspace.id, onExpired);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState('');
  const editable = (state?.role ?? workspace.role) !== 'viewer' && connection !== 'Access denied';
  const projects = state?.projects ?? [];
  const project = projects.find((item) => item.id === selection) ?? projects[0];
  const tasks = state?.tasks.filter((task) => task.projectId === project?.id) ?? [];
  const newProject = pending.filter((item) => item.operation.kind === 'project.create' && !item.receipt);
  const newTask = pending.filter((item) => item.operation.kind === 'task.create'
    && item.operation.projectId === project?.id && !item.receipt);
  const blocked = new Set(pending.map((item) => item.operation.entityId));
  const tracked = new Set(pending.flatMap(({ operation }) => 'resolves' in operation && operation.resolves
    ? [operation.id, operation.resolves] : [operation.id]));
  const attention = [
    ...pending.filter((item) => item.receipt?.status === 'conflict' || item.receipt?.status === 'rejected')
      .map((item) => ({ item, restored: false })),
    ...(state?.conflicts ?? []).filter(({ operation }) => !tracked.has(operation.id))
      .map((entry) => ({ item: { ...entry, scope: user + ':' + workspace.id }, restored: true })),
  ];

  async function submit(work: () => Promise<void>) {
    setError('');
    try {
      await work();
      return true;
    } catch {
      setError('Could not save on this device. Check storage or an existing queued edit.');
      return false;
    }
  }

  return <>
    <div className="heading">
      <h1>Field operations</h1>
      <div className="sync-status" aria-live="polite">
        <span data-connection={connection}>{connection}</span>
        <span>{pending.length} unsynced</span>
        {state && <span>{state.role}</span>}
      </div>
    </div>
    {error && <p role="alert" className="notice">{error}</p>}
    {damaged > 0 && <p role="alert" className="notice">Unreadable queued changes: {damaged}. The original records remain on this device.</p>}
    {damagedSnapshot && <p role="alert" className="notice">The cached checklist is unreadable. Reconnect to refresh it.</p>}
    {attention.length > 0 && <section aria-label="Changes needing attention" className="panel attention">
      <h2>Changes needing attention</h2>
      {attention.map(({ item, restored }) => <Conflict key={item.operation.id} item={item} members={state?.members ?? []}
        onDecide={(keep) => void submit(() => decide(item, keep, restored))} editable={editable}
        busy={restored && blocked.has(item.operation.entityId)} />)}
    </section>}
    {state && <div className="columns">
      <nav className="panel projects" aria-label="Projects">
        <h2>Projects</h2>
        {projects.map((item) => <button key={item.id} type="button"
          aria-pressed={project?.id === item.id} className="project" onClick={() => setSelection(item.id)}>{item.title}</button>)}
        {newProject.map(({ operation }) => <p key={operation.id} className="muted">{operation.title} · queued</p>)}
        {editable && <form className="create" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const title = String(new FormData(form).get('title')).trim();
          if (title) void submit(async () => {
            await queue({ id: crypto.randomUUID(), kind: 'project.create', entityId: crypto.randomUUID(), title });
            form.reset();
          });
        }}>
          <label>Project name<input name="title" maxLength={160} required placeholder="e.g. North site inspection" /></label>
          <button>Add project</button>
        </form>}
      </nav>
      <section className="panel checklist" aria-label="Checklist">
        <h2>{project ? project.title : 'Checklist'}</h2>
        {!project && <p className="muted">Add a project to start a checklist.</p>}
        {project && tasks.length === 0 && newTask.length === 0 && <p className="muted">No tasks yet.</p>}
        {tasks.map((task) => {
          const item = pending.find((entry) => entry.operation.entityId === task.id);
          return <TaskRow key={task.id} task={task} pending={item} members={state.members}
            editable={editable} save={(version, title, done, assigneeId) => submit(() => queue({
              id: crypto.randomUUID(), kind: 'task.update', entityId: task.id, version, title, done, assigneeId,
            }))} />;
        })}
        {newTask.map(({ operation }) => <p key={operation.id} className="muted">{operation.title} · queued</p>)}
        {project && editable && <form key={project.id} className="create task-create" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const title = String(data.get('title')).trim();
          if (title) void submit(async () => {
            await queue({
              id: crypto.randomUUID(), kind: 'task.create', entityId: crypto.randomUUID(),
              projectId: project.id, title, done: false, assigneeId: String(data.get('assignee')) || null,
            });
            form.reset();
          });
        }}>
          <label>New task<input name="title" maxLength={160} required placeholder="e.g. Record pressure reading" /></label>
          <label>Assign to<Assignee members={state.members} /></label>
          <button>Add task</button>
        </form>}
      </section>
      <aside className="panel activity">
        <h2>Activity</h2>
        {state.activity.length === 0 && <p className="muted">No changes yet.</p>}
        <ol>{state.activity.map((entry) => <li key={entry.revision}>
          <strong>{entry.actor}</strong> {entry.resolves ? 'resolved a conflict on' : ({
            'project.create': 'created project', 'task.create': 'added task', 'task.update': 'updated task',
          }[entry.kind] ?? 'updated')} <strong>{entry.title}</strong>
          <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
        </li>)}</ol>
      </aside>
    </div>}
  </>;
}

function Assignee({ members, value = '', onChange }: {
  members: Snapshot['members']; value?: string; onChange?: (value: string) => void;
}) {
  return <select name="assignee" value={onChange ? value : undefined} defaultValue={onChange ? undefined : value}
    onChange={onChange ? (event) => onChange(event.target.value) : undefined}>
    <option value="">Unassigned</option>
    {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
  </select>;
}

function TaskRow({ task, pending, members, editable, save }: {
  task: Task; pending?: Pending; members: Snapshot['members']; editable: boolean;
  save: (version: number, title: string, done: boolean, assigneeId: string | null) => Promise<boolean>;
}) {
  const [draftBase, setDraftBase] = useState<Task>();
  const [draft, setDraft] = useState(task);
  const optimistic = pending?.operation.kind === 'task.update' && (!pending.receipt || pending.receipt.status === 'applied')
    ? pending.operation : task;
  const assignee = members.find((item) => item.id === optimistic.assigneeId)?.name ?? 'Unassigned';
  return <article className="task" aria-label={task.title}>
    <div className="task-title"><span className="check-icon" aria-label={optimistic.done ? 'Complete' : 'Open'}>{optimistic.done ? '✓' : '○'}</span>
      <div><strong>{optimistic.title}</strong><span className="muted">{assignee}{pending ? ' · unsynced' : ''}</span></div>
      {editable && !pending && <button className="secondary" onClick={() => {
        if (!draftBase) setDraft(task);
        setDraftBase(draftBase ? undefined : task);
      }}>{draftBase ? 'Cancel' : 'Edit'}</button>}
    </div>
    {draftBase && editable && !pending && <form className="task-edit" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const title = String(data.get('title')).trim();
      if (title) void save(draftBase.version, title, data.get('done') === 'on', String(data.get('assignee')) || null)
        .then((saved) => { if (saved) setDraftBase(undefined); });
    }}>
      <label>Task name<input name="title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={160} required /></label>
      <label>Assign to<Assignee members={members} value={draft.assigneeId ?? ''}
        onChange={(assigneeId) => setDraft({ ...draft, assigneeId: assigneeId || null })} /></label>
      <label className="checkbox"><input type="checkbox" name="done" checked={draft.done} onChange={(event) => setDraft({ ...draft, done: event.target.checked })} /> Complete</label>
      <button>Save task</button>
    </form>}
  </article>;
}

function Conflict({ item, members, editable, busy, onDecide }: {
  item: Pending; members: Snapshot['members']; editable: boolean; busy: boolean; onDecide: (keep: boolean) => void;
}) {
  const { operation, receipt } = item;
  function details(value: { done: boolean; assigneeId: string | null }) {
    const assignee = members.find((member) => member.id === value.assigneeId)?.name ?? 'Unassigned';
    return (value.done ? 'Complete' : 'Open') + ' · ' + assignee;
  }
  if (receipt?.status === 'conflict' && operation.kind === 'task.update') {
    return <div className="conflict">
      <div className="versions">
        <div><h3>Your edit</h3><strong>{operation.title}</strong><p>{details(operation)}</p></div>
        <div><h3>Server version {receipt.current.version}</h3><strong>{receipt.current.title}</strong><p>{details(receipt.current)}</p></div>
      </div>
      <div className="actions">
        {editable && <button disabled={busy} onClick={() => onDecide(true)}>Use my edit</button>}
        <button className="secondary" disabled={busy} onClick={() => onDecide(false)}>Keep server version</button>
      </div>
    </div>;
  }
  return <div className="conflict">
    <strong>{operation.title}</strong>
    <p>{receipt?.status === 'rejected' ? receipt.reason : 'Change could not be applied'}</p>
    <button className="secondary" onClick={() => onDecide(false)}>Discard local edit</button>
  </div>;
}
