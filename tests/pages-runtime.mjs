// Real Pages runtime with ephemeral SQL and synthetic upstreams; no relay Worker.
// Every outbound fetch is intercepted. This cannot establish browser media playback.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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
const stream = "https://stream.example.org/synthetic.mp3";
let resolvedStream = stream;
let stationLookups = 0;
let outboundCalls = 0;
const json = data => new RuntimeResponse(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const outboundService = async request => {
  outboundCalls++;
  const url = new URL(request.url);
  if (url.origin === "https://database.test" && request.method === "POST") {
    assert.equal(request.headers.get("apikey"), "synthetic-service-key");
    const name = url.pathname.split("/").at(-1);
    assert.match(name, /^web_[a-z_]+$/);
    assert.equal(name.startsWith("web_relay_"), false, "Active application must not use legacy relay RPCs");
    const args = await request.json();
    const params = Object.keys(args).map((key, i) => {
      assert.match(key, /^p_[a-z_]+$/); return `${key} => $${i + 1}`;
    }).join(",");
    return json((await db.query(`select public.${name}(${params}) as value`, Object.values(args))).rows[0].value);
  }
  if (url.href === "https://api.pocketcasts.com/device/authorize") {
    assert.equal(request.method, "POST"); assert.deepEqual(await request.json(), { scope: "tv" });
    return json({ device_code: "synthetic-device", user_code: "ABCDEF", expires_in: 600, interval: 5 });
  }
  if (url.href === "https://api.pocketcasts.com/user/token") {
    const body = await request.json();
    assert.equal(body.device_code, "synthetic-device"); assert.equal(body.scope, "tv");
    return json({ uuid: user, email: "test@example.invalid", token_type: "Bearer", access_token: "synthetic-access",
      refresh_token: "synthetic-refresh", expires_in: 3600 });
  }
  if (url.href === `https://de1.api.radio-browser.info/json/stations/byuuid/${station}`) {
    assert.equal(request.method, "GET");
    for (const header of ["authorization", "cookie", "apikey", "x-user-uuid", "icy-metadata"]) {
      assert.equal(request.headers.has(header), false, "Station lookup must not receive credentials or request ICY");
    }
    stationLookups++;
    return json([{ stationuuid: station, url_resolved: resolvedStream, name: "Synthetic station" }]);
  }
  throw new Error("Unexpected outbound request: audio and live network are forbidden");
};
const bindings = { SUPABASE_URL: "https://database.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key", SUPABASE_ANON_KEY: "synthetic-anon-key" };
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: "127.0.0.1", port: 0,
  workers: [{ name: "web", modules: true, script: await readFile(".wrangler/functions/index.js", "utf8"),
    compatibilityDate: "2026-10-11", bindings, outboundService }],
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
  assert.equal((await call(`/api/playback?stationId=${station}`)).status, 401);
  assert.equal(stationLookups, 0);
  const signedOut = outboundCalls;
  for (const path of ["/api/layout", "/api/stations/curated"]) assert.equal((await call(path)).status, 401);
  assert.equal(outboundCalls, signedOut, "Signed-out shared-table routes must not reach the database");
  const start = await call("/api/pair/start", "POST");
  assert.equal(start.status, 200);
  assert.deepEqual(await start.json(), { userCode: "ABCDEF", pairingUri: "pktc://pair?user_code=ABCDEF", expiresIn: 600, interval: 5 });
  assert.equal(cookies.has("__Host-pr-pair"), true);
  assert.deepEqual(await (await call("/api/pair/poll")).json(), { status: "pending" });
  await db.exec("update public.web_pairings set next_poll_at = now() - interval '1 second';");
  assert.deepEqual(await (await call("/api/pair/poll")).json(), { status: "approved" });
  assert.equal(cookies.has("__Host-pr-session"), true);
  assert.deepEqual(await (await call("/api/session")).json(), { signedIn: true, email: "test@example.invalid" });
  const playback = await call(`/api/playback?stationId=${station}`);
  assert.equal(playback.status, 200);
  assert.deepEqual(await playback.json(), { stationId: station, streamUrl: stream });
  assert.equal(stationLookups, 1);
  assert.equal((await call(`/api/playback?stationId=${station}&url=https://evil.example.org`)).status, 400);
  resolvedStream = "http://stream.example.org/synthetic.mp3";
  const unsupported = await call(`/api/playback?stationId=${station}`);
  assert.equal(unsupported.status, 422);
  assert.deepEqual(await unsupported.json(), { error: "https_required" });
  const before = outboundCalls;
  for (const [path, method] of [["/api/relay/start", "POST"], ["/api/relay/old", "GET"],
    ["/api/relay/old/stop", "POST"], ["/api/relay-events/old", "GET"]]) {
    assert.equal((await call(path, method)).status, 410);
  }
  assert.equal(outboundCalls, before, "Retired routes must perform no network/database work");
  assert.equal((await call("/api/signout/everywhere", "POST")).status, 200);
  assert.deepEqual(await (await call("/api/session")).json(), { signedIn: false });
  assert.equal((await call(`/api/playback?stationId=${station}`)).status, 401);
  const signedOutAgain = outboundCalls;
  for (const path of ["/api/layout", "/api/stations/curated"]) assert.equal((await call(path)).status, 401);
  assert.equal(outboundCalls, signedOutAgain, "Signed-out shared-table routes must not reach the database");
  assert.equal((await db.query("select count(*)::int as n from public.pc_tokens")).rows[0].n, 0);
  console.log("Local Pages: synthetic pairing/reload/signout, HTTPS-only station resolution, no audio fetch/DO binding, input rejection, signed-out 401 on shared-table routes and 410 relay tombstones passed; no live network or browser playback.");
} finally {
  clearTimeout(deadline);
  await runtime.dispose();
  await db.close();
}
