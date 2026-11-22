# FieldSync V1 audit evidence

The captures come from the Playwright scenario against a production Next.js build, Fastify, and Docker PostgreSQL 17.12. Alex, Blair, and Casey are synthetic fixture accounts. Alex and Blair signed in through separate Chromium browser contexts with independent cookies and storage. The outage uses Chromium's offline mode. Quota and database faults were injected in the test environment. Eviction was modeled by deleting IndexedDB from an isolated browser context.

| Evidence | What it shows |
| --- | --- |
| [Live checklist](demo/01-live-checklist.png) | An assigned task propagated between two signed-in browsers. |
| [Offline queue after reload](demo/02-offline-queue-after-reload.png) | The cached checklist and two queued edits survived a disconnected reload. |
| [Conflict after reconnect](demo/03-conflict-after-reconnect.png) | Both task versions were visible and an independent edit synchronized. |
| [Viewer rejection](demo/04-viewer-rejection.json) | An authenticated viewer's write received HTTP 403. |
| [Persisted state after restart](demo/05-persisted-after-restart.png) | A fresh session recovered checklist and activity after restarting the gateway and PostgreSQL. |
| [Conflict on a clean browser profile](demo/06-server-conflict-on-clean-profile.png) | The original proposal was recovered from PostgreSQL and resolved on the clean profile. |
| [Pending work after a dropped acknowledgement](demo/07-pending-after-interrupted-ack.png) | The outbox still held the operation after both services restarted. The subsequent retry produced one task and one activity entry. |
| [Quota error with the draft still visible](demo/08-quota-error-preserves-form.png) | An aborted outbox write surfaced an error and kept the form available for retry. |
| [Revoked workspace](demo/09-revoked-workspace-hidden.png) | Reconnect cleared the denied checklist from view. |
| [Checkpoint failure](demo/10-checkpoint-failure-retains-receipt.png) | A cache quota fault retained the outbox entry after PostgreSQL accepted the write. A later retry completed the checkpoint. |

The browser test also exercises both conflict decisions, multi-tab draft preservation, stale session recovery, corrupt record isolation, revalidation of an unconfirmed cached receipt, and IndexedDB deletion. The [API integration tests](../tests/api.test.ts) include an injected database receipt failure and session revocation while a write is waiting on a database lock. [Browser test](../tests/field.spec.ts) · [Run locally](../README.md#verify-and-demonstrate)

## Local verification

Node 22.23.5, Chromium 156.0.8078.79, and Docker PostgreSQL 17.12.

| Command | Result |
| --- | --- |
| `npm ci` | Passed with the locked dependencies. |
| `npm run db:migrate` | Passed against the existing database. Repeated successfully. |
| `npm run check` | Passed. |
| `npm run test:integration` | 12 reported passed, including 11 subtests. 0 failed or skipped. |
| `npm audit --audit-level=high` | 0 known vulnerabilities reported. |
| `npm run build` | Passed. |
| `FIELDSYNC_RESTART_DATABASE=1 npm run test:browser` | 1 scenario with 12 steps passed. 0 failed or skipped. |
