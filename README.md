# PocketRadio Web

M1 feasibility page: Vite/React/TypeScript, same-origin Cloudflare Pages
Functions, and server-only Supabase storage. Audio plays **directly from an
HTTPS station to the browser**, not through our backend. No native helper is
required. See [ADR 0006](../docs/web/adr/0006-direct-https-playback-without-an-audio-relay.md).

The user verified local staging Pairing, email display/reload, both sign-outs
and three read-only 200 / JSON-object probes. The previous relay listening
check is historical. The user also reported direct playback after receiving
Radio Paradise Global's UUID; cleanup and timed listening remain unverified.
This is not the finished M2–M7 player or an installable PWA yet; installation
is planned for M3. Nothing has been deployed.

## Local setup

Use Node.js 24 and pnpm. Health and the page need no credentials.
`package.json` pins the pnpm version in `packageManager`; Corepack, which
ships with Node.js, installs that version.

1. Run `corepack enable` once per Node.js installation, then
   `pnpm install --frozen-lockfile`.
2. Run `make test typecheck build`. Tests use synthetic upstreams and ephemeral
   PostgreSQL/WASM storage; no live credentials or stations are used.
3. Run `make dev` and open `https://127.0.0.1:8788`. Accept the local development
   certificate. Secure session cookies require HTTPS.
4. Check `curl -k --fail https://127.0.0.1:8788/api/health`: `{"ok":true}`.

`make dev` starts Pages/Functions only, with no relay Worker or Durable Object.
Stop with Ctrl-C. Changes require rebuild/restart. `make dev-web` is browser-only
Vite hot reload without Functions.

## Commands and layout

- `make test`: unit/UI and SQL contracts, then a real offline Pages runtime
  checking synthetic Pairing, HTTPS station resolution, no server audio fetch,
  HTTP rejection and retired relay routes. Some unit fixtures cover retained
  legacy relay code; they are not evidence of an active relay.
- `make typecheck`: browser, Functions, retained legacy fixtures and tests.
- `make build`: browser and Functions bundles only. No Worker dry-run/deployment.
- `make deploy`: uploads Pages after checks; **requires separate approval**, a
  reviewed explicit target, private access and isolated secrets. Do not run it
  merely because local tests pass.

Browser code is in `src/`, public security headers in `public/_headers`, shared
initial-URL policy in `shared/direct-playback.ts`, and server helpers in
`functions/_lib/`. `workers/relay/` is retained legacy source, not part of normal
build/dev/deployment. No `RELAY_HUB` binding is configured.

## Pairing and secrets

For an approved authenticated local test, copy `.dev.vars.example` to ignored
`.dev.vars`. Pages needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only on the
server. Never put credentials, tokens or user UUIDs in `VITE_` variables.

The web-only migration `../supabase/migrations/20261011000008_web_auth.sql` was
applied to the linked PocketRadio project with approval on 2026-10-12. RLS and
client privilege denial were verified. Existing relay tables/RPCs remain in
that already-applied migration; no schema deletion or reapplication is needed
for direct playback. The active playback path does not call relay RPCs.

Authorization, polling and refresh use the TV device scope, `tv`. The server-only
`PC_API_ENVIRONMENT` selects `production` (default, `api.pocketcasts.com`) or
`staging` (`api.pocketcasts.net`). All Pocket Casts requests use the same choice.
The phone's `StagingDebug` build approves on `.net`; local `.dev.vars` therefore
uses staging. A `.com` code was rejected there as expired/invalid grant.

Secret tables are not environment-namespaced. Use separate databases for
simultaneous `.net` and `.com` tests. Do not copy the shared project's service key
into an untrusted preview, reset it, delete its sessions/tokens or switch its
upstream environment without approval. The user approved private Free-only
staging setup: a Pages project and a dedicated Free database, both named
`pocket-radio-web-m1-staging`, exist and are deployed behind Cloudflare Access.
No billing or existing database changes are authorized. Follow the [deployment guide](../docs/web/architecture/deployment.md),
not the root config's default deployment target.

## Direct playback experiment

1. Pair from the phone if the page is signed out.
2. Enter a **radio-browser station UUID**, not a URL, for a permitted HTTPS
   station. Click **Load HTTPS station**.
3. Press **Play** on the native audio control. Test stop, another station, and
   local sign-out. Titles and lyrics are intentionally unavailable.

`GET /api/playback?stationId=<UUID>` requires a same-origin authenticated request.
It queries the fixed radio-browser metadata endpoint with bounded time/body size
and rejects lookup redirects. It returns only the ID and validated public HTTPS
stream URL. It never GETs, HEADs or follows the audio stream. The browser validates
the URL again, then assigns it to `<audio controls preload="none">`, without a
CORS attribute, autoplay, ICY request or SSE subscription.

HTTP-only streams show an unsupported message; no silent HTTPS rewrite or relay
fallback occurs. Initial URLs with credentials, fragments, literal IPs,
local/reserved hostnames or nondefault ports are rejected. Current support is
public-looking DNS hosts on HTTPS/443, not all possible HTTPS station endpoints.
DNS and subsequent browser redirects are not pinned by our server. The browser
can still reject redirects, formats, codecs, network failures or station policy.

Audio bypasses our server, so the station sees your IP and the browser controls
third-party credentials. A no-referrer policy suppresses the app URL; no app
cookies, Pocket Casts tokens or database secrets are attached by our code.
Stop/error/switch/local sign-out/unmount pause and release the media source.
Sign-out everywhere revokes web sessions, not a public URL already loaded in
another browser. There is no relay lifetime or revocation timer to enforce.

Legacy `/api/relay/*` and `/api/relay-events/*` entry routes return **410 Gone**
without network or binding access. Do not redeploy the retired Worker. Direct
playback is not a waiver of station/client terms: SomaFM's published third-party
restrictions remain relevant, and no permission has been established here.

## Read-only probes and remaining evidence

Choose an endpoint and click **Run selected probe** once. Progress/errors/results
appear below the button; wait the displayed delay after a 429. Results reveal
format/status, not private subscriptions or playlists. Podcast episodes require
a podcast UUID. `up_next/sync` and `sync/update_episode` stay manual/pending
because they can change account state.

Open checks include direct-playback cleanup and browser coverage, a timed HTTPS run,
deployed Safari/Chrome cookies, account UUID comparison with iOS, live refresh,
remaining endpoint schemas/permissions, and approved cloud isolation/plan choice.
See [the active milestone](../docs/web/current_milestone.md) and
[AGENTS.md](AGENTS.md). Do not claim live behavior from mocked tests.
