# PocketRadio Web

An M1 feasibility page built with Vite, React, and TypeScript. Cloudflare Pages
serves the page and Functions on one origin. Supabase stores server-only secrets.
A separate Worker exports the SQLite Durable Object that joins each listener's
audio and title requests. See the [hosting decision](../docs/web/adr/0002-cloudflare-hosts-web-player-supabase-is-database.md).

Pairing, rolling sessions, both sign-outs, selected JSON probes, and a restricted
stream relay are implemented and tested locally. **Live Pocket Casts JSON support,
phone approval, production cookies, audio relay permission, and hour-long
playback are not established.** This is not the M2–M7 player UI.

## Local setup

Use Node.js 24 and npm. Health and the page need no credentials.

1. Run `npm ci`.
2. Run `make test typecheck build`. Tests use synthetic upstreams and an
   ephemeral PostgreSQL/WASM database; every runtime-test fetch is intercepted.
3. Run `make dev`. Open `https://127.0.0.1:8788` and accept the local development
   certificate. Secure session cookies require HTTPS; do not downgrade them.
4. Check `curl -k --fail https://127.0.0.1:8788/api/health`: `{"ok":true}`.
   Stop the server with Ctrl-C. Changes require a rebuild/restart.

`make dev-web` provides browser-only Vite hot reload, not Functions. `make dev`
starts Pages and the relay Worker together. Authenticated experiments additionally
need an approved database migration and server-only secrets; do not apply the
migration or use live credentials merely to run the test suite.

## Commands and layout

- `make test`: Vitest including UI regressions, isolated SQL contracts, offline
  workerd Worker smoke, and separate Pages/DO integration with synthetic approval.
- `make typecheck`: browser, Functions/Worker, configuration and UI tests.
- `make build`: browser bundle, Functions bundle, relay Worker **dry run only**.
  It uploads nothing. Outputs stay in ignored `dist/` and `.wrangler/`.
- `make deploy`: verifies then deploys **Pages only**. It requires separate
  approval and a previously deployed relay Worker. No deployment was performed.

Browser code is in `src/`; Pages routes are under `functions/api/`; shared
server helpers are in `functions/_lib/`. `workers/relay/` owns the separate
Worker. Tests load the additive SQL migration from the sibling shell checkout.
See [relay contracts and restrictions](workers/relay/README.md).

## Secrets and deployment prerequisites

Migration `../supabase/migrations/20261011000008_web_auth.sql` creates five
service-role-only secret tables and their RPCs. Isolated tests apply it only to
an ephemeral database. Production application is an explicit user checkpoint.

For approved authenticated local experiments, copy `.dev.vars.example` to
ignored `.dev.vars`, and `workers/relay/.dev.vars.example` to that Worker's
ignored `.dev.vars`. Both runtimes need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. The migration's client-role grants are revoked;
forged `x-user-uuid` requests should fail with permission denied, not expose rows.

Production and preview Pages configurations bind `RELAY_HUB` to the
`pocket-radio-relay` Worker, class `RelayHub`. After legal/rights/plan approval,
deploy that Worker separately with its `workers/relay/wrangler.toml`, then
configure server-only secrets in **both** the Worker and Pages project before
using `make deploy`. Preview shares the configured relay Worker; isolate its
namespace/credentials before untrusted preview access. Never run deployment
commands without approval. CPU, quotas, billing and hour-long behavior still
need production verification.

Never use `VITE_` variables for tokens, keys, session identifiers or `user_uuid`.
The browser sees only approval codes, opaque relay handles, email after verified
sign-in, and sanitized probe status. `.dev.vars*`, `.env*`, local Worker state,
`node_modules/`, and build outputs are ignored; examples contain no real keys.
Read [AGENTS.md](AGENTS.md) before changes.

## Experiment page

- Start Pairing only after session restoration finishes. Scan the QR or use
  the displayed code in the phone's approval screen. Cookie-renewing auth
  transitions are serialized; stale UI-generation checks alone cannot prevent
  a delayed `Set-Cookie` response.
- Start a relay using a radio-browser station UUID, then press the audio
  control's **Play** within 30 seconds. Only `ice1.somafm.com` and
  `ice2.somafm.com` pass the spike's host allowlist. No curated-ID schema or
  arbitrary Browse-host support is implemented. New playback needs a new handle.
- Titles come from the listener's own audio connection. Receipt timestamps do
  not measure alignment to the browser's audible buffer.
- Run one JSON probe at a time. Podcast episodes need a podcast UUID.
  `up_next/sync` and `sync/update_episode` stay manual/pending because they can
  change account state. Output contains status/format, not private upstream data.

Mocks prove contracts and security behavior, not the upstream's acceptance of
those contracts. Safari/Chrome, camera routing with both apps installed,
redistribution rights and uninterrupted listening require external evidence.
