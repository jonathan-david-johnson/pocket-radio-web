// Real handlers + ephemeral PostgreSQL/WASM; never a deployed database.
// Run with pnpm run test:db; optional module overrides support isolated investigation.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const { PGlite } = await import(process.env.AUTH_PGLITE_MODULE
  ? pathToFileURL(process.env.AUTH_PGLITE_MODULE).href : "@electric-sql/pglite");
const compiled = await build({ entryPoints: [new URL("./database-entry.ts", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false });
const { createAuthHandlers, accessToken } = await import(process.env.AUTH_HANDLERS_MODULE
  ? pathToFileURL(process.env.AUTH_HANDLERS_MODULE).href
  : `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const migration = await readFile(new URL("../../../supabase/migrations/20261011000008_web_auth.sql", import.meta.url), "utf8");
const USER = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://radio.test";
const SESSION = "__Host-pr-session";
const hash = value => createHash("sha256").update(value).digest("hex");
const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const grant = (access = "fixture-access", refresh = "fixture-refresh") => json({
  uuid: USER, email: "test@example.invalid", access_token: access, refresh_token: refresh,
  token_type: "Bearer", expires_in: 3600,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

await test("handler/storage signout and rotation interleavings", async t => {
  const db = new PGlite();
  let clock = Date.UTC(2026, 9, 11);
  let serial = 100;
  const advance = (seconds = 1) => { clock += seconds * 1000; };
  const now = () => new Date(clock).toISOString();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    await db.exec(migration);
    await db.exec("set role service_role;");
    const rpc = async (name, args) => {
      assert.match(name, /^web_[a-z_]+$/);
      const params = Object.keys(args).map((key, i) => `${key} => $${i + 1}`).join(",");
      return (await db.query(`select public.${name}(${params}) as value`, Object.values(args))).rows[0].value;
    };
    const browser = () => {
      const jar = new Map();
      let network = async url => {
        if (url === "https://api.pocketcasts.com/device/authorize") {
          return json({ device_code: "fixture-device", user_code: "ABCD-EFGH", expires_in: 600, interval: 5 });
        }
        if (url === "https://api.pocketcasts.com/user/token") return grant();
        throw new Error("Unexpected network request");
      };
      const runtime = {
        now: () => clock, random: () => (++serial).toString(16).padStart(64, "0"),
        hash: async value => hash(value), rpc,
        fetch: async (url, init) => network(url, init),
      };
      const handlers = createAuthHandlers(runtime);
      const request = (path, method = "GET") => new Request(`${ORIGIN}/api/${path}`, {
        method, headers: { Origin: ORIGIN, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
      });
      const receive = response => {
        for (const item of response.headers.getSetCookie()) {
          const [name, value] = item.split(";")[0].split("=");
          if (item.includes("Max-Age=0")) jar.delete(name);
          else jar.set(name, value);
        }
        return response;
      };
      const start = async () => {
        const response = receive(await handlers.start(request("pair/start", "POST")));
        assert.equal(response.status, 200);
        assert.equal((await response.json()).userCode, "ABCD-EFGH");
      };
      const poll = () => handlers.poll(request("pair/poll"));
      const approve = async () => {
        advance(5);
        const response = receive(await poll());
        assert.deepEqual(await response.json(), { status: "approved" });
      };
      const signout = async (everywhere = false) => {
        const path = everywhere ? "signout/everywhere" : "signout";
        const response = receive(await handlers[everywhere ? "everywhere" : "signout"](request(path, "POST")));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { signedIn: false });
      };
      const session = async () => (await handlers.session(request("session"))).json();
      const sessionHash = () => hash(jar.get(SESSION));
      const pauseGrant = (value = () => grant()) => {
        const entered = deferred(); const gate = deferred();
        network = async url => {
          assert.equal(url, "https://api.pocketcasts.com/user/token");
          entered.resolve(); await gate.promise; return value();
        };
        return { entered: entered.promise, release: () => gate.resolve() };
      };
      return { runtime, start, poll, approve, signout, session, receive, sessionHash, pauseGrant };
    };
    const check = async (name, run) => t.test(name, async () => {
      await db.exec("truncate public.web_relays, public.web_pairings, public.web_sessions, public.pc_tokens, public.web_account_revocations cascade;");
      clock = Date.UTC(2026, 9, 11);
      await run();
    });

    for (const everywhere of [false, true]) {
      await check(`${everywhere ? "everywhere" : "single"} signout wins before consume without an existing session cookie`, async () => {
        const a = browser(); await a.start(); advance(5);
        const gate = a.pauseGrant(); const poll = a.poll(); await gate.entered;
        advance(); await a.signout(everywhere);
        gate.release(); const response = a.receive(await poll);
        assert.deepEqual(await response.json(), { status: "expired" });
        assert.equal(response.headers.getSetCookie().some(c => c.startsWith(`${SESSION}=`)), false);
        assert.deepEqual(await a.session(), { signedIn: false });
        assert.equal((await db.query("select count(*)::integer as n from public.web_sessions")).rows[0].n, 0);
      });
      await check(`${everywhere ? "everywhere" : "single"} signout revokes a consumed pairing before its cookie arrives`, async () => {
        const b = browser(); await b.start(); await b.approve();
        advance(); const a = browser(); await a.start(); advance(5);
        const delayed = await a.poll(); // Deliberately withhold Set-Cookie from A.
        assert.deepEqual(await delayed.clone().json(), { status: "approved" });
        advance(); await a.signout(everywhere);
        a.receive(delayed); // Network response order must not restore authorization.
        assert.deepEqual(await a.session(), { signedIn: false });
        assert.equal((await b.session()).signedIn, !everywhere);
        assert.equal(await rpc("web_session_check", { p_session_hash: a.sessionHash(), p_now: now() }), false);
      });
    }
    await check("everywhere fences another browser's approved old grant even after fresh pairing", async () => {
      const a = browser(); await a.start(); await a.approve();
      advance(); const old = browser(); await old.start(); advance(5);
      const gate = old.pauseGrant(); const pending = old.poll(); await gate.entered;
      advance(); await a.signout(true);
      advance(); const fresh = browser(); await fresh.start(); await fresh.approve();
      gate.release(); const response = old.receive(await pending);
      assert.deepEqual(await response.json(), { status: "expired" });
      assert.deepEqual(await old.session(), { signedIn: false });
      assert.equal((await fresh.session()).signedIn, true);
      assert.equal((await db.query("select count(*)::integer as n from public.web_account_revocations")).rows[0].n, 1);
      assert.equal((await db.query("select count(*)::integer as n from public.web_sessions")).rows[0].n, 1);
    });
    await check("A's in-flight rotation survives single signout for B but does not authorize A", async () => {
      const a = browser(); await a.start(); await a.approve();
      advance(); const b = browser(); await b.start(); await b.approve();
      await db.query("update public.pc_tokens set expires_at=$1", [now()]);
      const gate = a.pauseGrant(() => grant("fixture-rotated", "fixture-next"));
      const refresh = accessToken(a.runtime, a.sessionHash()); await gate.entered;
      advance(); await a.signout(); gate.release();
      assert.equal(await refresh, null);
      assert.deepEqual(await a.session(), { signedIn: false });
      assert.equal(await accessToken(b.runtime, b.sessionHash()) === "fixture-rotated", true);
      const saved = (await db.query("select refresh_token='fixture-next' as rotated, refresh_lease is null as released from public.pc_tokens")).rows[0];
      assert.deepEqual(saved, { rotated: true, released: true });
    });
    await check("everywhere plus fresh pairing rejects old rotation's CAS and leaves fresh credentials intact", async () => {
      const a = browser(); await a.start(); await a.approve();
      await db.query("update public.pc_tokens set expires_at=$1", [now()]);
      const gate = a.pauseGrant(() => grant("fixture-stale", "fixture-stale-refresh"));
      const refresh = accessToken(a.runtime, a.sessionHash()); await gate.entered;
      advance(); await a.signout(true);
      advance(); const fresh = browser(); await fresh.start(); await fresh.approve();
      gate.release(); assert.equal(await refresh, null);
      assert.equal(await accessToken(fresh.runtime, fresh.sessionHash()) === "fixture-access", true);
      assert.equal((await fresh.session()).signedIn, true);
      assert.equal((await db.query("select refresh_token='fixture-refresh' as unchanged from public.pc_tokens")).rows[0].unchanged, true);
    });
  } finally { await db.close(); }
});
