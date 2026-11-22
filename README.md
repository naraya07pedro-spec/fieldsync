# FieldSync

FieldSync is an Apache-2.0 offline-first collaboration platform for field crews. The vertical slice covers workspace sign-in, project checklists, assignments, activity, and explicit conflict resolution.

## Run locally

Use Node.js 22 or later, npm, Docker Compose, and OpenSSL. Commands below assume Bash and run from the repository root.

```bash
npm ci
umask 077
printf 'FIELDSYNC_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env
source .env
export DATABASE_URL="postgresql://fieldsync:${FIELDSYNC_DB_PASSWORD}@127.0.0.1:${FIELDSYNC_DB_PORT:-5432}/fieldsync"
docker compose up -d --wait
npm run db:migrate
```

Create a pair of accounts and a viewer in the same workspace. Repeat the block with unique emails and the desired name and role. The command receives the password through stdin, away from arguments and shell history.

```bash
read -r -s -p 'Account password (12–128 characters) ' fieldsync_password
printf '\n'
printf '%s\n' "$fieldsync_password" | npm run user:create -- "Field crew" alex@example.test Alex admin
unset fieldsync_password
```

For a production-build demo, run `npm run build` and start `npm run start:web` and `npm run start:api` in separate terminals. Export `DATABASE_URL` in the gateway terminal. Open **http://localhost:3000**. Use browser profiles or isolated browser contexts to sign in simultaneously. For hot reload, use `npm run dev`. Offline reload uses the service worker from the production build.

Set `PUBLIC_ORIGIN` to the exact browser origin when it differs from the default. Non-loopback origins require HTTPS. See the [architecture](docs/architecture.md) for the deployment boundary.

## Verify and demonstrate

Run these commands against a **disposable** database with the configuration above. Each suite creates isolated test accounts and workspaces. Port 3000 and port 3001 must be free for Playwright.

```bash
npm run check
npm run test:integration
npm run build
npx playwright install --with-deps chromium
FIELDSYNC_RESTART_DATABASE=1 npm run test:browser
```

The optional restart flag restarts the Compose PostgreSQL service during the browser run. Omit it when testing with a separately managed disposable database. Use `npx playwright show-report` to open the generated report. The [demo evidence](docs/demo.md) shows a completed run with synthetic accounts.

The [GitHub Actions workflow](.github/workflows/ci.yml) runs the type check, integration suite, production build, and Chromium scenario, and uploads a browser report. Stop the local database with `docker compose down`. Its named volume retains data.

## Project status

The current scope is one same-origin Fastify gateway, one Next.js process, and PostgreSQL. See [architecture and remaining acceptance gates](docs/architecture.md).

Licensed under the [Apache License 2.0](LICENSE).
