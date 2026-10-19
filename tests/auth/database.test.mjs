// Standalone, ephemeral PostgreSQL/WASM contract checks; no live database.
// Run with npm run test:db. AUTH_PGLITE_MODULE optionally selects another installation.
// Companion interleavings.test.mjs runs the actual auth handlers against this
// same SQL draft. Its header documents a temporary esbuild bundle; no project
// dependency/config changes or live database connection are required.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const modulePath = process.env.AUTH_PGLITE_MODULE;
const { PGlite } = await import(modulePath ? pathToFileURL(modulePath).href : "@electric-sql/pglite");
const migration = await readFile(new URL("../../../supabase/migrations/20261011000008_web_auth.sql", import.meta.url), "utf8");
const BASE = Date.UTC(2026, 9, 11);
const time = (seconds = 0) => new Date(BASE + seconds * 1000).toISOString();
const hash = n => n.toString(16).padStart(64, "0");
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const origin = "https://radio.test";
const secretTables = [...migration.matchAll(/create table public\.(\w+)/g)].map(m => m[1]);
const rpcNames = [...migration.matchAll(/create function public\.(\w+)/g)].map(m => m[1]);

await test("isolated PostgreSQL auth storage contracts", async t => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    await db.exec(migration);
    await db.exec("set role service_role;");
    const rpc = async (name, args) => {
      const params = Object.keys(args).map((key, i) => `${key} => $${i + 1}`).join(",");
      return (await db.query(`select public.${name}(${params}) as value`, Object.values(args))).rows[0].value;
    };
    const binding = (n = 1, browser = 2) => ({ p_pairing_hash: hash(n), p_browser_hash: hash(browser), p_origin: origin });
    const pair = async (n = 1, browser = 2, at = 0, expires = 600) => {
      const b = binding(n, browser);
      assert.equal(await rpc("web_pair_reserve", { ...b, p_now: time(at) }), true);
      assert.equal(await rpc("web_pair_activate", { ...b, p_now: time(at), p_device_code: "fixture-device", p_expires_in: expires, p_interval: 5 }), true);
      return b;
    };
    const claim = (b, at = 5, lease = 3) => rpc("web_pair_claim", { ...b, p_now: time(at), p_lease: hash(lease) });
    const consume = (b, session = 4, at = 6, lease = 3, user = USER) => rpc("web_pair_consume", {
      ...b, p_now: time(at), p_lease: hash(lease), p_session_hash: hash(session), p_user_uuid: user,
      p_email: "test@example.invalid", p_access_token: "fixture-access", p_refresh_token: "fixture-refresh", p_expires_in: 3600,
    });
    const signed = async () => { const b = await pair(); await claim(b); assert.equal(await consume(b), true); return b; };
    const admit = (id, at = 7, session = 4) => rpc("web_relay_admit", {
      p_session_hash: hash(session), p_relay_id: id, p_now: time(at),
    });
    const release = (id, session = 4) => rpc("web_relay_release", { p_session_hash: hash(session), p_relay_id: id });
    const relayCount = async () => (await db.query("select count(*)::integer as n from public.web_relays")).rows[0].n;
    const check = async (name, run) => {
      await t.test(name, async () => {
        await db.exec(`truncate ${secretTables.map(name => `public.${name}`).join(",")} cascade;`);
        await run();
      });
    };

    await check("all secret tables have RLS, no policies, and no anon/auth grants", async () => {
      const tables = (await db.query("select relname, relrowsecurity from pg_class where relname = any($1)", [secretTables])).rows;
      assert.equal(tables.length, secretTables.length); assert.equal(tables.every(r => r.relrowsecurity), true);
      assert.equal((await db.query("select count(*)::integer as n from pg_policies where tablename = any($1)", [secretTables])).rows[0].n, 0);
      assert.deepEqual([...secretTables].sort(), ["pc_tokens", "web_account_revocations", "web_pairings", "web_relays", "web_sessions"]);
      assert.deepEqual([...rpcNames].sort(), ["web_pair_reserve", "web_pair_activate", "web_pair_cancel", "web_pair_claim",
        "web_pair_finish", "web_pair_consume", "web_session_roll", "web_session_email", "web_session_signout",
        "web_session_signout_everywhere", "web_probe_claim", "web_token_claim", "web_token_finish", "web_token_release",
        "web_signout", "web_session_check", "web_relay_admit", "web_relay_release"].sort());
      const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
      for (const role of ["anon", "authenticated"]) {
        for (const table of secretTables) {
          for (const privilege of privileges) {
            assert.equal((await db.query("select has_table_privilege($1,$2,$3) as allowed", [role, table, privilege])).rows[0].allowed, false);
          }
        }
        const funcs = (await db.query("select has_function_privilege($1,oid,'EXECUTE') as allowed from pg_proc where pronamespace = 'public'::regnamespace and proname like 'web_%'", [role])).rows;
        assert.equal(funcs.length, rpcNames.length); assert.equal(funcs.some(r => r.allowed), false);
      }
      assert.equal((await db.query("select count(*)::integer as n from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a where p.pronamespace='public'::regnamespace and p.proname like 'web_%' and a.grantee=0")).rows[0].n, 0);
      assert.equal((await db.query("select count(*)::integer as n from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r',c.relowner))) a where c.relname=any($1) and a.grantee=0", [secretTables])).rows[0].n, 0);
      const service = (await db.query("select proname, prosecdef, proconfig, has_function_privilege('service_role',oid,'EXECUTE') as allowed from pg_proc where pronamespace = 'public'::regnamespace and proname like 'web_%'")).rows;
      assert.deepEqual(service.map(r => r.proname).sort(), [...rpcNames].sort());
      assert.equal(service.every(r => r.allowed && !r.prosecdef && r.proconfig.includes("search_path=pg_catalog, public")), true);
      for (const table of secretTables) {
        for (const privilege of privileges) {
          assert.equal((await db.query("select has_table_privilege('service_role',$1,$2) as allowed", [table, privilege])).rows[0].allowed, true);
        }
      }
    });
    await check("forged x-user-uuid cannot grant either client role any secret read or RPC execution", async () => {
      await signed();
      const calls = (await db.query("select proname, (select string_agg('null::' || format_type(typ,null), ',') from unnest(proargtypes::oid[]) typ) as args from pg_proc where pronamespace='public'::regnamespace and proname like 'web_%'")).rows;
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`reset role; set role ${role};`);
        try {
          await db.query("select set_config('request.headers', $1, false)", [JSON.stringify({ "x-user-uuid": USER })]);
          for (const table of secretTables) await assert.rejects(db.query(`select * from public.${table}`), e => e.code === "42501");
          for (const call of calls) await assert.rejects(db.query(`select public.${call.proname}(${call.args})`), e => e.code === "42501");
        } finally { await db.exec("reset role; set role service_role;"); }
      }
    });
    await check("browser binding, origin, and poll interval gate persistent claims", async () => {
      const b = await pair();
      assert.equal((await claim({ ...b, p_browser_hash: hash(99) })).status, "expired");
      assert.equal((await claim({ ...b, p_origin: "https://evil.test" })).status, "expired");
      assert.equal((await claim(b, 4)).status, "pending");
      assert.equal((await claim(b, 5)).status, "poll");
      assert.equal((await claim(b, 6, 99)).status, "pending");
    });
    await check("competing serialized claims produce one lease and one atomic consume", async () => {
      const b = await pair();
      const claims = await Promise.all([claim(b), claim(b, 5, 99)]);
      assert.deepEqual(claims.map(r => r.status), ["poll", "pending"]);
      const results = await Promise.all([consume(b, 4), consume(b, 5)]);
      assert.deepEqual(results, [true, false]);
      assert.equal((await db.query("select count(*)::integer as n from public.web_sessions")).rows[0].n, 1);
      const row = (await db.query("select status, device_code, poll_lease from public.web_pairings")).rows[0];
      assert.equal(row.status, "consumed"); assert.equal(row.device_code, null); assert.equal(row.poll_lease, null);
    });
    await check("expired leases reject late approval and new lease rejects stale consumer", async () => {
      const b = await pair(); await claim(b);
      assert.equal(await consume(b, 4, 35), false);
      assert.equal((await claim(b, 35, 99)).status, "poll");
      assert.equal(await consume(b, 4, 36, 3), false);
      assert.equal(await consume(b, 4, 36, 99), true);
    });
    await check("pairing expires at its exact deadline and erases the device code", async () => {
      const b = await pair(1, 2, 0, 10); await claim(b, 9);
      assert.equal(await consume(b, 4, 10), false);
      assert.equal((await claim(b, 10)).status, "expired");
      assert.equal((await db.query("select device_code is null as erased from public.web_pairings")).rows[0].erased, true);
    });
    await check("slow_down increases the persistent interval before another poll", async () => {
      const b = await pair(); await claim(b);
      assert.equal(await rpc("web_pair_finish", { ...b, p_lease: hash(3), p_now: time(6), p_status: "slow_down" }), true);
      assert.equal((await claim(b, 15)).status, "pending");
      const claimed = await claim(b, 16); assert.equal(claimed.status, "poll"); assert.equal(claimed.interval, 10);
    });
    await check("restarting pairing invalidates its previous lease and generation", async () => {
      const old = await pair(); await claim(old);
      await pair(10, 2, 6);
      assert.equal(await consume(old, 4, 7), false);
    });
    await check("start rate is persistent even when authorization fails", async () => {
      for (let n = 1; n <= 3; n++) {
        const b = binding(n);
        assert.equal(await rpc("web_pair_reserve", { ...b, p_now: time(n) }), true);
        await rpc("web_pair_cancel", b);
      }
      assert.equal(await rpc("web_pair_reserve", { ...binding(4), p_now: time(4) }), false);
      assert.equal(await rpc("web_pair_reserve", { ...binding(5), p_now: time(64) }), true);
    });
    await check("global code generation rate bounds resetting browser bindings", async () => {
      for (let n = 1; n <= 100; n++) assert.equal(await rpc("web_pair_reserve", { ...binding(n, n + 1000), p_now: time() }), true);
      assert.equal(await rpc("web_pair_reserve", { ...binding(101, 2000), p_now: time() }), false);
    });
    await check("abandoned pairing rows and codes are bounded and cleaned on a later reservation", async () => {
      for (let n = 1; n <= 100; n++) assert.equal(await rpc("web_pair_reserve", { ...binding(n, n + 1000), p_now: time() }), true);
      assert.equal(await rpc("web_pair_reserve", { ...binding(101, 2000), p_now: time(900) }), true);
      assert.equal((await db.query("select count(*)::integer as n from public.web_pairings where status='authorizing'")).rows[0].n, 1);
      assert.equal(await rpc("web_pair_reserve", { ...binding(102, 2001), p_now: time(4501) }), true);
      assert.equal((await db.query("select count(*)::integer as n from public.web_pairings")).rows[0].n, 2);
    });
    await check("poll work stops at the persistent count bound", async () => {
      const b = await pair();
      await db.query("update public.web_pairings set poll_count=179");
      assert.equal((await claim(b)).status, "poll");
      assert.equal(await rpc("web_pair_finish", { ...b, p_lease: hash(3), p_now: time(6), p_status: "pending" }), true);
      assert.equal((await claim(b, 11)).status, "expired");
      const row = (await db.query("select poll_count, device_code, poll_lease from public.web_pairings")).rows[0];
      assert.deepEqual(row, { poll_count: 180, device_code: null, poll_lease: null });
    });
    await check("rolling sessions last 90 days from the visit and never revive expired rows", async () => {
      await signed();
      const visit = 86400;
      assert.equal((await rpc("web_session_roll", { p_session_hash: hash(4), p_now: time(visit) })).user_uuid, USER);
      const expiry = (await db.query("select expires_at from public.web_sessions")).rows[0].expires_at;
      assert.equal(new Date(expiry).getTime(), BASE + (visit + 90 * 86400) * 1000);
      assert.equal(await rpc("web_session_roll", { p_session_hash: hash(4), p_now: time(visit + 90 * 86400) }), null);
    });
    await check("single sign-out preserves other web sessions; everywhere deletes account tokens and all sessions", async () => {
      await signed(); const b = await pair(10, 20, 7); await claim(b, 12); assert.equal(await consume(b, 5, 13), true);
      assert.equal(await rpc("web_session_signout", { p_session_hash: hash(4) }), true);
      assert.equal(await rpc("web_session_roll", { p_session_hash: hash(4), p_now: time(14) }), null);
      assert.equal((await rpc("web_session_roll", { p_session_hash: hash(5), p_now: time(14) })).user_uuid, USER);
      assert.equal(await rpc("web_session_signout_everywhere", { p_session_hash: hash(5), p_now: time(15) }), true);
      assert.equal((await db.query("select count(*)::integer as n from public.web_sessions")).rows[0].n, 0);
      assert.equal((await db.query("select count(*)::integer as n from public.pc_tokens")).rows[0].n, 0);
    });
    await check("failed consume rolls back token upsert and leaves pairing unconsumed", async () => {
      await signed(); const b = await pair(10, 20, 7); await claim(b, 12);
      await assert.rejects(consume(b, 4, 13, 3, OTHER), e => e.code === "23505");
      const r = (await db.query("select status from public.web_pairings where pairing_hash=$1", [hash(10)])).rows[0];
      assert.equal(r.status, "pending");
      assert.equal((await db.query("select count(*)::integer as n from public.pc_tokens")).rows[0].n, 1);
    });
    await check("older pairing cannot overwrite a newer grant", async () => {
      const old = await pair(); const newer = await pair(10, 20, 1);
      await claim(newer, 6); assert.equal(await consume(newer, 4, 7), true);
      await db.query("update public.pc_tokens set access_token='fixture-newer'");
      await claim(old, 8); assert.equal(await consume(old, 5, 9), true);
      assert.equal((await db.query("select access_token='fixture-newer' as unchanged from public.pc_tokens")).rows[0].unchanged, true);
    });
    await check("probe gate and token refresh lease are cross-isolate and sign-out prevents late refresh", async () => {
      await signed();
      assert.equal(await rpc("web_probe_claim", { p_session_hash: hash(4), p_now: time(7) }), true);
      assert.equal(await rpc("web_probe_claim", { p_session_hash: hash(4), p_now: time(8) }), false);
      await db.query("update public.pc_tokens set expires_at=$1", [time(7)]);
      const args = { p_session_hash: hash(4), p_lease: hash(50), p_now: time(8) };
      assert.equal((await rpc("web_token_claim", args)).status, "refresh");
      assert.equal((await rpc("web_token_claim", { ...args, p_lease: hash(51) })).status, "busy");
      assert.equal(await rpc("web_session_signout_everywhere", { p_session_hash: hash(4), p_now: time(9) }), true);
      assert.equal(await rpc("web_token_finish", { ...args, p_now: time(10), p_user_uuid: USER,
        p_email: "test@example.invalid", p_access_token: "fixture-refreshed", p_refresh_token: "fixture-next", p_expires_in: 3600 }), false);
    });
    await check("cancel after consume revokes the minted session even without a session cookie", async () => {
      const b = await signed();
      assert.equal(await rpc("web_pair_cancel", b), true);
      assert.equal(await rpc("web_session_roll", { p_session_hash: hash(4), p_now: time(7) }), null);
      assert.equal(await consume(b, 5, 8), false);
    });
    await check("cancel before consume and forged cancellation cannot revive or revoke a minted session", async () => {
      const b = await pair(); await claim(b);
      assert.equal(await rpc("web_pair_cancel", b), true);
      assert.equal(await consume(b), false);
      const next = await pair(10, 20, 7); await claim(next, 12); await consume(next, 5, 13);
      assert.equal(await rpc("web_pair_cancel", { ...next, p_browser_hash: hash(99) }), false);
      assert.equal(await rpc("web_pair_cancel", { ...next, p_origin: "https://evil.test" }), false);
      assert.equal(await rpc("web_session_check", { p_session_hash: hash(5), p_now: time(14) }), true);
    });
    await check("atomic signout covers both consume/signout serial orders without a session cookie", async () => {
      const b = await pair(); await claim(b);
      const args = { ...b, p_session_hash: null, p_now: time(7), p_everywhere: false };
      assert.equal(await rpc("web_signout", args), true);
      assert.equal(await consume(b, 4, 8), false);
      const next = await pair(10, 20, 9); await claim(next, 14);
      assert.equal(await consume(next, 5, 15), true);
      assert.equal(await rpc("web_signout", { ...args, ...next, p_now: time(16) }), true);
      assert.equal(await rpc("web_session_roll", { p_session_hash: hash(5), p_now: time(17) }), null);
    });
    await check("everywhere fences old and equal-start approvals persistently but allows fresh pairing", async () => {
      await signed();
      const old = await pair(10, 20, 7); await claim(old, 12);
      const equal = await pair(11, 21, 13);
      assert.equal(await rpc("web_session_signout_everywhere", { p_session_hash: hash(4), p_now: time(13) }), true);
      assert.equal(await consume(old, 5, 14), false);
      await claim(equal, 18); assert.equal(await consume(equal, 6, 19), false);
      const fresh = await pair(12, 22, 14); await claim(fresh, 19);
      assert.equal(await consume(fresh, 7, 20), true);
      await claim(old, 21); assert.equal(await consume(old, 8, 22), false);
      assert.equal((await db.query("select count(*)::integer as n from public.web_sessions")).rows[0].n, 1);
    });
    await check("consume winner before everywhere is deleted, late other-browser approval cannot recreate tokens", async () => {
      await signed(); const b = await pair(10, 20, 7); await claim(b, 12);
      assert.equal(await consume(b, 5, 13), true);
      assert.equal(await rpc("web_signout", { ...b, p_session_hash: null, p_now: time(14), p_everywhere: true }), true);
      assert.equal(await rpc("web_session_roll", { p_session_hash: hash(4), p_now: time(15) }), null);
      assert.equal(await rpc("web_session_roll", { p_session_hash: hash(5), p_now: time(15) }), null);
    });
    await check("rotated refresh from revoked A saves B's generation but A cannot claim credentials", async () => {
      await signed(); const b = await pair(10, 20, 7); await claim(b, 12); await consume(b, 5, 13);
      await db.query("update public.pc_tokens set expires_at=$1", [time(14)]);
      const args = { p_session_hash: hash(4), p_lease: hash(50), p_now: time(15) };
      assert.equal((await rpc("web_token_claim", args)).status, "refresh");
      await rpc("web_session_signout", { p_session_hash: hash(4) });
      assert.equal(await rpc("web_token_finish", { ...args, p_now: time(16), p_user_uuid: USER,
        p_email: "test@example.invalid", p_access_token: "fixture-rotated", p_refresh_token: "fixture-next", p_expires_in: 3600 }), true);
      assert.equal(await rpc("web_token_claim", { ...args, p_now: time(17) }), null);
      assert.equal((await rpc("web_token_claim", { ...args, p_session_hash: hash(5), p_now: time(17) })).status, "ready");
    });
    await check("non-rolling session checks use the exact expiry and observe both revocations", async () => {
      await signed(); const b = await pair(10, 20, 7); await claim(b, 12); await consume(b, 5, 13);
      const before = (await db.query("select expires_at from public.web_sessions where session_hash=$1", [hash(4)])).rows[0].expires_at;
      assert.equal(await rpc("web_session_check", { p_session_hash: hash(4), p_now: time(86400) }), true);
      assert.equal((await db.query("select expires_at from public.web_sessions where session_hash=$1", [hash(4)])).rows[0].expires_at.getTime(), before.getTime());
      assert.equal(await rpc("web_session_check", { p_session_hash: hash(4), p_now: before.toISOString() }), false);
      assert.equal(await rpc("web_session_check", { p_session_hash: hash(99), p_now: time(14) }), false);
      await rpc("web_session_signout", { p_session_hash: hash(4) });
      assert.equal(await rpc("web_session_check", { p_session_hash: hash(4), p_now: time(14) }), false);
      assert.equal(await rpc("web_session_check", { p_session_hash: hash(5), p_now: time(14) }), true);
      await rpc("web_session_signout_everywhere", { p_session_hash: hash(5), p_now: time(15) });
      assert.equal(await rpc("web_session_check", { p_session_hash: hash(5), p_now: time(16) }), false);
    });
    await check("relay admission rejects invalid IDs and missing or exactly expired sessions", async () => {
      await signed();
      for (const id of [null, "", "a".repeat(129), "../station", "with space"]) assert.equal(await admit(id), false);
      assert.equal(await admit("missing", 7, 99), false);
      assert.equal(await relayCount(), 0);
      await db.query("update public.web_sessions set expires_at=$1", [time(8)]);
      assert.equal(await admit("allowed", 7), true);
      const row = (await db.query("select started_at, expires_at from public.web_relays")).rows[0];
      assert.equal(row.expires_at.getTime() - row.started_at.getTime(), 66 * 60 * 1000);
      assert.equal(await admit("expired", 8), false);
      assert.equal(await relayCount(), 1); // Retained for the minute-rate gate.
    });
    await check("relay live capacity is account-wide, independent across accounts, and release is session-bound", async () => {
      await signed(); const b = await pair(10, 20, 7); await claim(b, 12); await consume(b, 5, 13);
      const other = await pair(11, 21, 8); await claim(other, 13); await consume(other, 6, 14, 3, OTHER);
      assert.deepEqual(await Promise.all([admit("one", 15), admit("two", 15, 5), admit("three", 15)]), [true, true, false]);
      assert.equal(await admit("other", 15, 6), true);
      assert.equal(await release("one", 5), false);
      assert.equal(await admit("still-full", 16), false);
      assert.equal(await release("one"), true);
      assert.equal(await admit("three", 16, 5), true);
      assert.equal(await admit("one", 16), false); // No reuse of retained IDs.
      assert.equal(await release("absent"), false);
    });
    await check("relay start rate retains releases and resets exactly at the trailing-minute boundary", async () => {
      await signed();
      for (let n = 0; n < 5; n++) { assert.equal(await admit(`rate-${n}`, 7 + n), true); assert.equal(await release(`rate-${n}`), true); }
      assert.equal(await admit("sixth", 66), false);
      assert.equal(await admit("boundary", 67), true);
      assert.equal(await relayCount(), 5);
      assert.equal(await release("boundary"), true);
      assert.equal(await admit("next-too-soon", 67), false);
      assert.equal(await admit("next-boundary", 68), true);
    });
    await check("signout frees live capacity but cannot reset account start rate through a new session", async () => {
      await signed();
      for (let n = 0; n < 5; n++) { await admit(`revoked-${n}`, 7 + n); await release(`revoked-${n}`); }
      await rpc("web_session_signout_everywhere", { p_session_hash: hash(4), p_now: time(12) });
      const b = await pair(10, 20, 13); await claim(b, 18); await consume(b, 5, 19);
      assert.equal(await admit("new-session", 20, 5), false);
      assert.equal(await relayCount(), 5);
      assert.equal(await admit("after-minute", 67, 5), true);
      assert.equal(await admit("old-session", 68), false);
    });
    await check("exact relay lease deadline admits replacement and removes expired rows without rolling sessions", async () => {
      await signed();
      assert.equal(await admit("old-one"), true); assert.equal(await admit("old-two"), true);
      assert.equal(await admit("too-early", 7 + 66 * 60 - 1), false);
      assert.equal(await admit("replacement", 7 + 66 * 60), true);
      assert.equal(await relayCount(), 1);
      assert.equal((await db.query("select expires_at from public.web_sessions")).rows[0].expires_at.getTime(), BASE + (6 + 90 * 86400) * 1000);
    });
    await check("relay retained rows stay within seven per account during repeated admission/release and stale cleanup", async () => {
      await signed();
      for (let n = 0; n < 120; n++) {
        const at = 7 + n * 12;
        assert.equal(await admit(`bounded-${n}`, at), true);
        assert.equal(await release(`bounded-${n}`), true);
        assert.equal(await relayCount() <= 7, true);
      }
      await rpc("web_session_signout", { p_session_hash: hash(4) });
      assert.equal(await admit("cannot-start", 7 + 120 * 12), false);
      assert.equal(await relayCount() <= 4, true);
      assert.equal(await admit("cleanup", 7 + 125 * 12), false);
      assert.equal(await relayCount(), 0);
    });
    await check("failed refresh from signed-out A releases only its CAS lease and backs off surviving B", async () => {
      await signed(); const b = await pair(10, 20, 7); await claim(b, 12); await consume(b, 5, 13);
      await db.query("update public.pc_tokens set expires_at=$1", [time(14)]);
      const args = { p_session_hash: hash(4), p_lease: hash(50), p_now: time(15) };
      assert.equal((await rpc("web_token_claim", args)).status, "refresh");
      await rpc("web_session_signout", { p_session_hash: hash(4) });
      assert.equal(await rpc("web_token_release", { ...args, p_session_hash: hash(5), p_now: time(16) }), false);
      assert.equal(await rpc("web_token_release", { ...args, p_now: time(16) }), true);
      const cleared = (await db.query("select refresh_lease, refresh_session_hash, refresh_until from public.pc_tokens")).rows[0];
      assert.deepEqual(cleared, { refresh_lease: null, refresh_session_hash: null, refresh_until: null });
      const surviving = { ...args, p_session_hash: hash(5), p_lease: hash(51) };
      assert.equal((await rpc("web_token_claim", { ...surviving, p_now: time(45) })).status, "busy");
      assert.equal((await rpc("web_token_claim", { ...surviving, p_now: time(46) })).status, "refresh");
      assert.equal(await rpc("web_token_release", { ...args, p_now: time(47) }), false);
      assert.equal(await rpc("web_token_finish", { ...args, p_now: time(47), p_user_uuid: USER,
        p_email: "test@example.invalid", p_access_token: "fixture-stale", p_refresh_token: "fixture-stale", p_expires_in: 3600 }), false);
    });
    await check("a newer pairing invalidates an in-flight refresh CAS", async () => {
      await signed(); await db.query("update public.pc_tokens set expires_at=$1", [time(7)]);
      const args = { p_session_hash: hash(4), p_lease: hash(50), p_now: time(8) };
      assert.equal((await rpc("web_token_claim", args)).status, "refresh");
      const b = await pair(10, 20, 9); await claim(b, 14); assert.equal(await consume(b, 5, 15), true);
      assert.equal(await rpc("web_token_finish", { ...args, p_now: time(16), p_user_uuid: USER,
        p_email: "test@example.invalid", p_access_token: "fixture-refreshed", p_refresh_token: "fixture-next", p_expires_in: 3600 }), false);
    });
  } finally { await db.close(); }
});
