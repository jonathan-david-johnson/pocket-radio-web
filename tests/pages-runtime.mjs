// Real Pages + separate SQLite DO Worker with ephemeral SQL and synthetic upstreams.
// Every outbound fetch is intercepted. This cannot establish live service behavior.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { PGlite } from "@electric-sql/pglite";
import miniflare from "miniflare";
const { Miniflare, convertV4MiniflareOptions, Response: RuntimeResponse } = miniflare;

execFileSync("node_modules/.bin/wrangler", ["pages", "functions", "build", "--outdir", ".wrangler/functions"], {
  stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
const db = new PGlite();
await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
await db.exec(await readFile(new URL("../../supabase/migrations/20261011000008_web_auth.sql", import.meta.url), "utf8"));
await db.exec("set role service_role;");
const user = "11111111-1111-4111-8111-111111111111";
const station = "22222222-2222-4222-8222-222222222222";
let audioConnections = 0;
const metadata = Buffer.alloc(32);
metadata.write("StreamTitle='Synthetic - Track';");
const icy = Buffer.concat([Buffer.from("abcd"), Buffer.from([2]), metadata, Buffer.from("efgh"), Buffer.from([0])]);
const json = data => new RuntimeResponse(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const outboundService = async request => {
  const url = new URL(request.url);
  if (url.origin === "https://database.test" && request.method === "POST") {
    assert.equal(request.headers.get("apikey"), "synthetic-service-key");
    const name = url.pathname.split("/").at(-1);
    assert.match(name, /^web_[a-z_]+$/);
    const args = await request.json();
    const params = Object.keys(args).map((key, i) => {
      assert.match(key, /^p_[a-z_]+$/); return `${key} => $${i + 1}`;
    }).join(",");
    return json((await db.query(`select public.${name}(${params}) as value`, Object.values(args))).rows[0].value);
  }
  if (url.href === "https://api.pocketcasts.com/device/authorize") {
    assert.equal(request.method, "POST");
    assert.deepEqual(await request.json(), { scope: "mobile" });
    return json({ device_code: "synthetic-device", user_code: "ABCDEF", expires_in: 600, interval: 5 });
  }
  if (url.href === "https://api.pocketcasts.com/user/token") {
    const body = await request.json();
    assert.equal(body.device_code, "synthetic-device");
    return json({ uuid: user, email: "test@example.invalid", token_type: "Bearer", access_token: "synthetic-access",
      refresh_token: "synthetic-refresh", expires_in: 3600 });
  }
  if (url.href === `https://de1.api.radio-browser.info/json/stations/byuuid/${station}`) {
    return json([{ stationuuid: station, url_resolved: "http://ice1.somafm.com/synthetic" }]);
  }
  assert.equal(request.url, "http://ice1.somafm.com/synthetic", "Unexpected outbound request: network forbidden");
  assert.equal(request.headers.get("icy-metadata"), "1");
  audioConnections++;
  return new RuntimeResponse(icy, { headers: { "Content-Type": "audio/mpeg", "icy-metaint": "4" } });
};
const bindings = { SUPABASE_URL: "https://database.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key" };
const relay = await build({ entryPoints: ["workers/relay/index.ts"], bundle: true, write: false, format: "esm", platform: "neutral" });
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: "127.0.0.1", port: 0, durableObjectsPersist: false,
  workers: [
    { name: "web", modules: true, script: await readFile(".wrangler/functions/index.js", "utf8"),
      compatibilityDate: "2026-10-11", bindings, outboundService,
      durableObjects: { RELAY_HUB: { className: "RelayHub", scriptName: "pocket-radio-relay", useSQLite: true } } },
    { name: "pocket-radio-relay", modules: true, script: relay.outputFiles[0].text,
      compatibilityDate: "2026-10-11", bindings, outboundService,
      durableObjects: { RELAY_HUB: { className: "RelayHub", useSQLite: true } } },
  ],
}));
const cookies = new Map();
const origin = "https://web.test";
async function call(path, method = "GET", body) {
  const response = await runtime.dispatchFetch(origin + path, {
    method, headers: { Origin: origin, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const header of response.headers.getSetCookie()) {
    const [key, value] = header.split(";")[0].split("=");
    if (value) cookies.set(key, value); else cookies.delete(key);
  }
  return response;
}
const deadline = setTimeout(() => { throw new Error("Pages runtime smoke deadline exceeded"); }, 20_000);
try {
  assert.deepEqual(await (await call("/api/health")).json(), { ok: true });
  assert.deepEqual(await (await call("/api/session")).json(), { signedIn: false });
  assert.equal((await call("/api/relay/start", "POST", { stationId: station })).status, 401);
  const start = await call("/api/pair/start", "POST");
  assert.equal(start.status, 200);
  assert.deepEqual(await start.json(), { userCode: "ABCDEF", pairingUri: "pktc://pair?user_code=ABCDEF", expiresIn: 600, interval: 5 });
  assert.equal(cookies.has("__Host-pr-pair"), true);
  assert.deepEqual(await (await call("/api/pair/poll")).json(), { status: "pending" });
  // Advance the test-only database gate, not the production clock or grant lifetime.
  await db.exec("update public.web_pairings set next_poll_at = now() - interval '1 second';");
  assert.deepEqual(await (await call("/api/pair/poll")).json(), { status: "approved" });
  assert.equal(cookies.has("__Host-pr-session"), true);
  assert.deepEqual(await (await call("/api/session")).json(), { signedIn: true, email: "test@example.invalid" });
  assert.equal((await call("/api/relay/start", "POST", { stationId: station, url: "http://localhost" })).status, 400);
  const started = await call("/api/relay/start", "POST", { stationId: station });
  assert.equal(started.status, 201);
  const handle = await started.json();
  const events = await call(handle.eventsUrl);
  assert.equal(events.status, 200);
  const eventText = events.text();
  const audio = await call(handle.audioUrl);
  assert.equal(audio.status, 200);
  assert.equal(await audio.text(), "abcdefgh");
  assert.match(await eventText, /"title":"Synthetic - Track"/);
  assert.equal(audioConnections, 1);
  assert.equal((await call(`/api/relay/${handle.relayId}/stop`, "POST")).status, 204);
  assert.equal((await call("/api/signout/everywhere", "POST")).status, 200);
  assert.deepEqual(await (await call("/api/session")).json(), { signedIn: false });
  assert.equal((await call(handle.audioUrl)).status, 401);
  assert.equal((await db.query("select count(*)::int as n from public.pc_tokens")).rows[0].n, 0);
  console.log("Local Pages+separate SQLite DO: synthetic pairing, cookie reload, authenticated audio/SSE, single upstream, URL rejection and signout passed; no live network.");
} finally {
  clearTimeout(deadline);
  await runtime.dispose();
  await db.close();
}
