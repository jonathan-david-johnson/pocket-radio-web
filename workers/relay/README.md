# Restricted relay Worker

This implements a local test of [Web ADR 0004](../../../docs/web/adr/0004-every-station-plays-through-the-stream-relay.md), not permission to redistribute audio. Pages authenticates browser requests and forwards them through `RELAY_HUB` to this Worker's SQLite Durable Object. Default public Worker ingress returns 404.

## Browser contract

| Route | Behavior |
|---|---|
| `POST /api/relay/start` | Same-origin authenticated JSON `{stationId:<radio-browser UUID>}` only, at most 1024 bytes. Resolves server-side and initializes one listener's object; does not open upstream audio. Returns `{relayId,audioUrl,eventsUrl}` with same-origin paths. |
| `GET /api/relay/<relayId>` | Authenticated one-shot audio. Opens exactly one upstream with `Icy-MetaData: 1` and strips metadata bytes. Concurrent/replayed audio fails. |
| `GET /api/relay-events/<relayId>` | Authenticated SSE from that same connection. Sends `reset`, current latest `title`, subsequent titles, and `stopped`. Never opens another audio connection. |
| `POST /api/relay/<relayId>/stop` | Same-origin authenticated stop; terminates audio/SSE, 204 for the retained owner's object. |

A handle contains a creation-time prefix and **208 cryptographically random bits**, encoded as 64 lowercase hex characters. It contains no user UUID. Ownership is bound to the initiating session, not merely the account. Missing/revoked session: 401; wrong owner: 404; missing binding: 503; unapproved host: 403. Responses are private/no-store. Browser cookies, identity headers, bearer tokens and Range headers are not forwarded upstream.

SSE data is `{generation,sequence,kind,receivedAt,title?}`, with event ID `generation:sequence`. Receipt time is not audible playback time. Render titles as text. Each subscription resets before replaying the current generation's latest title. Clear titles on reset/stop/error. A terminated handle cannot resume; create a new one.

## Restricted URL resolution

The UUID is a lookup key, not SSRF protection. The resolver verifies the returned `stationuuid` at radio-browser's fixed by-UUID endpoint, then prefers `url_resolved` over `url`. Lookup response size is bounded to 64 KiB with an eight-second timeout. Redirects on lookup are rejected.

Initial stream URLs and every redirect must use HTTP/S, default ports, no credentials/fragment, and **exactly** `ice1.somafm.com` or `ice2.somafm.com`. Other hosts, literal/private IPs, localhost and suffix matches fail closed. At most three redirects are followed, with discarded bodies canceled. Workers fetch supports manual redirect handling, not `redirect: "error"`.

This trusts operator DNS not to rebind into private destinations. It does not implement general DNS answer validation/IP pinning. Do not broaden the host list without an approved egress defense. No `curated_stations` schema exists here, so curated-ID resolution and arbitrary Browse-host playback remain unimplemented. An approved host is not evidence of redistribution rights or current ICY availability.

## Coordination and lifecycle

Pages generates a session-bound capability and sends internal `x-relay-id`, `x-relay-owner`, and server-derived `x-relay-session-hash` through the namespace binding. The object verifies its ID and retained owner. **The binding is the trust boundary**: never expose a public forwarder or bind this namespace to untrusted code. No module-global request map is used.

- Persistent SQL admission limits an account to two active relays and five starts per trailing minute across sessions/isolates. Failed initialization and teardown release the lease. Database expiry is the release fallback.
- Initialization lasts 30 seconds; audio lasts at most 65 minutes after setup. A restored active object ends its generation rather than reopening upstream.
- A nonrolling session check runs every 12 seconds with a three-second database timeout. Failure/revocation closes audio and SSE. Deterministic tests bound continued delivery to 15 seconds; deployed timer/abort behavior remains unmeasured.
- Cancel, abort, EOF/error, stop and expiry tear down the generation before persistence/network awaits. Ended state has a 24-hour cleanup alarm. A timestamp freshness check rejects old initialization even after state deletion.
- At most two SSE subscribers have four-event queues and 15-second heartbeats. Slow subscribers disconnect without backpressuring audio. Audio demand drives reads with no application read-ahead; parsing bounds each upstream chunk to 64 KiB and metadata to 4080 bytes. Larger chunks, invalid intervals, unsupported content types and compressed bodies fail closed.

These are per-account/application safety bounds, not a global traffic/cost guarantee. Native chunk sizes, runtime interruptions, cancellation across production bindings, CPU and 60+ minute continuous listening remain external checks.

## Configuration and verification

`wrangler.toml` exports class `RelayHub` with `new_sqlite_classes`. Pages' root configuration binds it with `script_name: "pocket-radio-relay"` for production and preview. Both runtimes need server-only `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`; copy the placeholder examples only for approved local account tests.

From the web repo:

```sh
make test typecheck build
make dev
```

The test suite intercepts all outbound fetches. It checks byte fidelity, arbitrary ICY boundaries, single-upstream provenance, ownership, rate/revocation/timeout/retention behavior, and both a real workerd Worker and separate Pages-to-DO integration using ephemeral SQL and synthetic approval/audio. `make dev` starts local HTTPS Pages and the relay Worker together. Production deployment is separate and was not performed.

No live approval, camera behavior, production cookies, Cloudflare permission, station rights, plan/cost choice, audible continuity or hour-long stream is claimed verified.
