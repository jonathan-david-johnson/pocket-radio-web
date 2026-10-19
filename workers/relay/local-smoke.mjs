// Offline workerd validation. All outbound traffic is intercepted; no live audio.
// Run from the web repo: node workers/relay/local-smoke.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import miniflare from "miniflare";
const { Miniflare, convertV4MiniflareOptions, Response: RuntimeResponse } = miniflare;

const bundle = await build({
  entryPoints: [new URL("./index.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "neutral",
});
let connections = 0;
const rpcCalls = [];
const metadata = Buffer.alloc(32);
metadata.write("StreamTitle='Synthetic - Track';");
const icy = Buffer.concat([Buffer.from("abcd"), Buffer.from([2]), metadata, Buffer.from("efgh"), Buffer.from([0])]);
// V4 no longer exports createFetchMock. Its installed outboundService API
// replaces every fetch with this local function; there is no network fallback.
const outboundService = async request => {
  const url = new URL(request.url);
  if (url.origin === "https://database.test" && request.method === "POST" &&
      ["/rest/v1/rpc/web_session_check", "/rest/v1/rpc/web_relay_release"].includes(url.pathname)) {
    rpcCalls.push(url.pathname.split("/").at(-1));
    return new RuntimeResponse("true");
  }
  assert.equal(request.method, "GET");
  assert.equal(request.url, "http://ice1.somafm.com/synthetic");
  assert.equal(request.headers.get("icy-metadata"), "1");
  connections++;
  return new RuntimeResponse(icy, { headers: { "content-type": "audio/mpeg", "icy-metaint": "4" } });
};
// Current Miniflare uses the native v5 schema; convert the documented v4
// convenience options rather than silently dropping the outbound interceptor.
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-10-11", host: "127.0.0.1", port: 0,
  durableObjects: { RELAY_HUB: { className: "RelayHub", useSQLite: true } },
  durableObjectsPersist: false, outboundService,
  bindings: { SUPABASE_URL: "https://database.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key" },
}));
const timeout = setTimeout(() => { throw new Error("Local relay smoke deadline exceeded"); }, 20_000);
try {
  for (const operation of ["init", "audio", "events", "stop"]) {
    assert.equal((await runtime.dispatchFetch("http://localhost/" + operation)).status, 404);
  }
  const namespace = await runtime.getDurableObjectNamespace("RELAY_HUB");
  const relayId = Date.now().toString(16).padStart(12, "0") + randomBytes(26).toString("hex");
  const stub = namespace.get(namespace.idFromName(relayId));
  const call = (operation, owner = "b".repeat(64)) => stub.fetch("https://relay.internal/" + operation, {
    method: ["init", "stop"].includes(operation) ? "POST" : "GET",
    headers: { "x-relay-id": relayId, "x-relay-owner": owner, "x-relay-session-hash": "c".repeat(64) },
    ...(operation === "init" ? { body: JSON.stringify({ streamUrl: "http://ice1.somafm.com/synthetic" }) } : {}),
  });
  assert.equal((await call("init")).status, 201);
  for (const operation of ["audio", "events", "stop"]) assert.equal((await call(operation, "d".repeat(64))).status, 404);
  const events = await call("events");
  assert.equal(events.status, 200);
  const eventText = events.text(); // Drain concurrently; audio alone drives title parsing.
  const audio = await call("audio");
  assert.equal(audio.status, 200);
  assert.equal(await audio.text(), "abcdefgh");
  const text = await eventText;
  assert.match(text, /event: reset/);
  assert.match(text, /event: title/);
  assert.match(text, /"title":"Synthetic - Track"/);
  assert.match(text, /event: stopped/);
  assert.equal((await call("audio")).status, 410);
  assert.equal((await call("stop")).status, 204);
  assert.equal((await call("init")).status, 409);
  assert.equal(connections, 1);
  assert.deepEqual(rpcCalls, ["web_session_check", "web_relay_release"]);
  console.log("Local workerd: SQLite DO, denied ingress/other owner, one synthetic ICY connection, audio+SSE, EOF/replay cleanup passed (no live network).");
} finally {
  clearTimeout(timeout);
  await runtime.dispose();
}
