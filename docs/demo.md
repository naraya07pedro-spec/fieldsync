# FieldSync browser demonstration

These captures came from the Playwright scenario running against a production Next.js build, Fastify, and Docker PostgreSQL 17.12. Alex, Blair, and Casey are synthetic test accounts. Alex and Blair signed in through separate Chromium browser contexts with independent cookies and local storage.

| Evidence | What the test verified |
| --- | --- |
| [Live checklist](demo/01-live-checklist.png) | Blair received Alex's assigned task through the same-origin live connection. |
| [Offline queue after reload](demo/02-offline-queue-after-reload.png) | Blair reloaded without a network connection. The cached checklist and both queued edits survived. |
| [Conflict after reconnect](demo/03-conflict-after-reconnect.png) | Blair saw both proposals after Alex changed the same task. The independent offline task synchronized. |
| [Viewer rejection](demo/04-viewer-rejection.json) | A write from Casey's authenticated browser received HTTP 403. |
| [Persisted state after restart](demo/05-persisted-after-restart.png) | A fresh session recovered the checklist and activity after restarting the gateway and PostgreSQL. |

The same test exercised both conflict decisions, kept a form draft intact when a live update arrived, and dropped a successful mutation response to confirm the retry produced one task and one activity entry. The [Playwright scenario](../tests/field.spec.ts) and [local verification steps](../README.md#verify-and-demonstrate) reproduce these checks.
