# PocketRadio Web

A minimal Vite + React + TypeScript browser player scaffold. Cloudflare Pages
serves the browser bundle and Pages Functions on one origin. Supabase is the
database, not the web server. See the [hosting decision](../docs/web/adr/0002-cloudflare-hosts-web-player-supabase-is-database.md).

Only a placeholder page and `GET /api/health` exist. Health returns
`200` with `{"ok":true}` and `Cache-Control: no-store`; it does not check any
upstream service. Pairing, sessions, API probes, and the stream relay are not
implemented. Local tests do not prove deployment, phone approval, production
cookies, or playback.

## Local setup

Use Node.js 24 and npm. No credentials are required.

1. Run `npm ci` in this directory to install the locked dependencies.
2. Run `make test typecheck build` to verify the scaffold.
3. Run `make dev` to build and serve the page and Functions through Wrangler
   at `http://127.0.0.1:8788`.
4. Open the page and run `curl --fail http://127.0.0.1:8788/api/health`.
   Expect `{"ok":true}`. Stop the server with Ctrl-C.

`make dev` serves the built bundle in the local Workers runtime. After editing,
restart it to rebuild. `make dev-web` provides Vite hot reload for browser-only
work; it does **not** serve Pages Functions.

## Commands and layout

- `make test`: hermetic Vitest tests with fixed time and blocked network/storage.
- `make typecheck`: separately checks browser code, Functions plus tests, and
  Node-based build configuration. Browser DOM types and Worker runtime types
  have separate configurations.
- `make build`: bundles browser assets into `dist/` and compiles Functions into
  `.wrangler/functions/` without uploading anything.
- `make deploy`: runs tests, typechecks, builds, then uploads with Wrangler.
  **Run only with explicit deployment approval** and authorized Cloudflare
  access. It uses the Pages project name in `wrangler.jsonc`; confirm that name
  and the deployment branch before use. Deployment is not verified here.

`src/` contains only browser code. Root-level `functions/api/` uses Pages
file-based routing and runs server-side; it is not part of the browser bundle.
`wrangler.jsonc` pins the runtime compatibility date and Pages asset directory.
Keep server dependencies and secrets out of `src/`.

## Environment and secrets

The scaffold has no bindings or environment requirements. `.dev.vars.example`
contains **commented placeholders only** for future server integration. When
that integration exists, copy it to ignored `.dev.vars` and fill values locally.
Do not put real credentials into the example file.

Future Supabase values belong only in Pages Functions: `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Never use `VITE_` variables
for keys, Pocket Casts tokens, session identifiers, or `user_uuid`: Vite exposes
those variables to the browser. Production secrets belong in Cloudflare Pages
secret settings, not committed configuration. `.env*`, `.dev.vars*`, `secrets/`,
`.wrangler/`, `node_modules/`, and `dist/` are ignored, except placeholder examples.

Future identity must come from server-verified Pocket Casts responses, never
browser headers or bodies. No auth or identity assertions are implemented by
this scaffold. Read [repository instructions](AGENTS.md) before adding them.
