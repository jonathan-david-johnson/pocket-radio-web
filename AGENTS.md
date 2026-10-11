# PocketRadio Web

Browser player built with Vite, React, and TypeScript. Cloudflare Pages serves
both the page and Pages Functions on one origin. Supabase is the database, not
the web server.

Read `../AGENTS.md`, `../docs/web/current_milestone.md`, and
`../docs/web/CONTEXT.md` before working. The accepted decisions are in
`../docs/web/adr/`. The menubar app is the Pocket Casts API reference.

## Work and verification

- Bootstrap on `main`, then implement M1 on `feature/m1-spikes`. Keep the
  shell on `main`. See the milestone's location table and subagent plan.
- Each platform command lives in this repo's Makefile. Shell `web-*` targets
  only delegate. Run `make test`, `make typecheck`, and `make build` before
  committing. Test function behavior with injected upstream fetch/storage
  and deterministic clocks; never use live credentials in unit tests.
- Fetch current Context7 documentation before using third-party APIs. Keep
  browser and Worker dependencies separate. Do not add M2–M7 screens in M1.
- `CLAUDE.md` contains only `@AGENTS.md`. Run `make hooks` in the shell after
  bootstrap. Code may cite ADRs and contracts, never temporary working docs.
- Stage explicit paths and inspect the staged list before commits. Do not
  push, merge, deploy, or apply database migrations without explicit approval.

## Security boundaries

- Browser requests stay on our origin for Pocket Casts and Supabase data.
  Never bundle Pocket Casts tokens, Supabase keys, or `user_uuid` in the page.
- Issue a Secure, httpOnly, SameSite=Lax cookie. Store only hashed random
  session identifiers. Sessions roll for 90 days; implement both sign-outs.
- Derive identity only from server-verified Pocket Casts responses. Never
  trust `x-user-uuid`, request bodies, or QR payloads as identity assertions.
- Secret tables have RLS and no anon/authenticated policies. Only the Worker
  uses the service-role secret. Ignore `.dev.vars`, `.env*`, and local state;
  commit only placeholder examples. Never print tokens or cookie values.
- Pairing needs an expiring browser-bound opaque handle, not a device code
  exposed in a poll URL. Tokens remain server-side. Protect mutating routes
  against cross-origin requests, and bound polling and upstream work.
- Relay routes accept station IDs, never client-supplied URLs. Resolve URLs
  server-side. Reject private/local addresses, credentials, unsafe schemes,
  and unsafe redirects. Authenticate audio and title subscriptions.
- Titles must come from the listener's own relay connection. A second
  connection cannot supply title evidence. Do not assume in-memory state
  crosses Worker isolates; use an explicit deployment-supported channel.

## Evidence and external actions

Record M1 results under `../docs/web/experiments/`, with sanitized evidence.
Mocks and local runtime tests prove implementation behavior, not phone
approval, production cookie behavior, Cloudflare terms, or an hour of playback.
Keep unavailable checks explicitly pending. The user performs phone gestures
and listening checks; never mark those done from automated tests.
