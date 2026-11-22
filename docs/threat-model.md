# FieldSync V1 threat model

## Assets and trust boundaries

The gateway protects workspace checklists, assignments, user identities, session credentials, conflict proposals, and activity. It treats incoming HTTP, WebSocket messages, mutation input, and browser-cached state as untrusted. PostgreSQL and the gateway are trusted services. A trusted TLS terminator fronts the gateway in deployment, and PostgreSQL and Next.js should stay on private interfaces. The operator provisions the initial accounts.

| Threat | Control and evidence |
| --- | --- |
| A request uses a stale session or the wrong account | Opaque random cookies, digest-only server storage, session rotation on login, a 12-hour expiry, and actor binding on workspace requests and logout. Transactional session checks prevent a queued write from committing after a completed revocation. |
| A browser sends cross-site writes or opens an authenticated socket from another origin | Exact Origin checks, SameSite=Strict and HttpOnly cookies, and Secure host-only cookies over HTTPS. API and WebSocket tests exercise rejected authentication, origins, and workspace access. |
| A workspace member accesses another workspace or another actor's conflict | Workspace-scoped SQL and foreign keys, role checks, actor-scoped receipts and proposals, and authorized WebSocket subscriptions. Already connected sockets are checked before a new notification. |
| Retries, races, or interruptions apply a write twice or lose a competing edit | Workspace serialization, compare-and-swap task versions, atomic receipts, one server decision per conflict, and independent browser queue keys. Fault tests cover database rollback, acknowledgement loss, service restarts, and multiple tabs. |
| Browser storage returns stale or corrupted data | The client validates record shapes, rechecks acknowledgements with the server, and preserves unreadable records. The service worker caches only the application shell and its assets. Known expiry limits offline identity reuse. |
| Secrets are accidentally included in dev or CI output | Demo accounts and database passwords are generated per run. Provisioning uses stdin. CI masks database credentials. Tracing is disabled for sign-in runs. Published evidence uses synthetic records and excludes cookies, credentials, and raw storage dumps. |

## Residual risk

- Someone with control of the browser profile or host can inspect or change local data. Offline workspaces cannot observe remote revocation until network access returns. Local expiry depends on the device clock. Use separate browser or OS profiles for separate users.
- Lost storage cannot recover edits that never reached PostgreSQL. A clean browser can recover server state and conflicts the server accepted. Automatic browser eviction, disk exhaustion, and operator storage deletion have different triggers even though they can have the same data-loss outcome.
- The in-process login limiter, single-instance WebSocket fanout, unbounded receipt retention, and full snapshots need operational sizing before a public deployment. There is no production reverse-proxy or abuse-control verification in the audit.
- The dependency audit covers known registry advisories at run time. The audit does not establish the absence of supply-chain defects. GitHub Actions are pinned to commits and PostgreSQL is pinned to an image digest.
