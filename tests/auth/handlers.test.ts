import { describe, expect, it } from "vitest";
import { accessToken, pcRequest, pollGrant, verifyGrant } from "../../functions/_lib/auth/pocket-casts";
import { cookie, SESSION_COOKIE } from "../../functions/_lib/auth/http";
import { createSessionValidator } from "../../functions/_lib/auth/session";
import { authResponse, cookies, digest, grant, harness, ORIGIN, OTHER, request, response, USER } from "./harness";

function cookieNames(result: Response) {
  return result.headers.getSetCookie().map(s => s.split("=")[0]);
}
function secureCookies(result: Response) {
  return result.headers.getSetCookie().every(s => s.includes("Path=/;") && s.includes("Secure;") &&
    s.includes("HttpOnly;") && s.includes("SameSite=Lax") && !s.includes("Domain="));
}

describe("pairing", () => {
  it("returns only a user code and fork pairing link, never the device code", async () => {
    const h = harness(); h.fetch(async () => response(authResponse()));
    const result = await h.handlers.start(request("pair/start", "POST", {
      headers: { "x-user-uuid": OTHER }, body: JSON.stringify({ user_uuid: OTHER }),
    }));
    expect(await result.json()).toEqual({ userCode: "ABCD-EFGH", pairingUri: "pktc://pair?user_code=ABCD-EFGH", expiresIn: 600, interval: 5 });
    expect(cookieNames(result)).toEqual(["__Host-pr-pair", "__Host-pr-browser"]);
    expect(secureCookies(result)).toBe(true);
    expect(h.rpcCalls.map(c => c.name)).toEqual(["web_pair_reserve", "web_pair_activate"]);
    expect(h.rpcCalls[0]!.args.p_browser_hash === cookies.browser).toBe(false);
    expect(JSON.parse(String(h.fetchCalls[0]!.init!.body))).toEqual({ scope: "tv" });
    expect(h.fetchCalls[0]!.init!.redirect).toBe("manual");
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each(["device", "refresh"])("retains the TV device scope for the %s grant", async kind => {
    const h = harness(); h.fetch(async () => response(grant()));
    if (kind === "device") await pollGrant(h.runtime, "fixture-device");
    else {
      h.rpc(async name => name === "web_token_claim"
        ? { status: "refresh", user_uuid: USER, refresh_token: "fixture-refresh" } : true);
      expect(await accessToken(h.runtime, digest(cookies.session))).toBe("fixture-access");
    }
    expect(JSON.parse(String(h.fetchCalls[0]!.init!.body))).toMatchObject({ scope: "tv" });
  });
  it("reserves rate capacity before making upstream requests", async () => {
    const h = harness(); h.rpc(async () => false);
    expect((await h.handlers.start(request("pair/start", "POST"))).status).toBe(429);
    expect(h.fetchCalls.length).toBe(0);
  });
  it("cancels failed authorization and redacts upstream errors", async () => {
    const h = harness(); h.fetch(async () => { throw new Error("private upstream details"); });
    const result = await h.handlers.start(request("pair/start", "POST"));
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: "Pairing unavailable" });
    expect(result.headers.has("Set-Cookie")).toBe(false);
    expect(h.rpcCalls.at(-1)!.name).toBe("web_pair_cancel");
  });
  it("uses a fresh random browser binding when none is present", async () => {
    const h = harness(); h.fetch(async () => response(authResponse()));
    const result = await h.handlers.start(request("pair/start", "POST", { headers: { Cookie: "" } }));
    expect(result.status).toBe(200);
    expect(cookieNames(result).includes("__Host-pr-browser")).toBe(true);
    expect(h.rpcCalls[0]!.args.p_pairing_hash !== h.rpcCalls[0]!.args.p_browser_hash).toBe(true);
  });
  it.each([
    { expires_in: 0 }, { expires_in: -1 }, { interval: 0 }, { interval: 999 },
    { device_code: "" }, { user_code: "<script>" },
  ])("fails closed for malformed authorization %j", async patch => {
    const h = harness(); h.fetch(async () => response({ ...authResponse(), ...patch }));
    const result = await h.handlers.start(request("pair/start", "POST"));
    expect(result.status).toBe(502);
    expect(result.headers.has("Set-Cookie")).toBe(false);
  });
  it("bounds local pairing expiry and minimum interval", async () => {
    const h = harness(); h.fetch(async () => response({ ...authResponse(), expires_in: 3600, interval: 1 }));
    expect(await (await h.handlers.start(request("pair/start", "POST"))).json()).toMatchObject({ expiresIn: 900, interval: 5 });
  });
  it("never polls with a copied pairing cookie but absent browser binding", async () => {
    const h = harness();
    const result = await h.handlers.poll(request("pair/poll", "GET", { headers: { Cookie: `__Host-pr-pair=${cookies.pair}` } }));
    expect(await result.json()).toEqual({ status: "expired" });
    expect(h.rpcCalls.length).toBe(0); expect(h.fetchCalls.length).toBe(0);
  });
  it("passes both hashed bindings and exact origin to persistent claim", async () => {
    const h = harness(); h.rpc(async () => ({ status: "expired" }));
    expect(await (await h.handlers.poll(request("pair/poll"))).json()).toEqual({ status: "expired" });
    const args = h.rpcCalls[0]!.args;
    expect(args.p_browser_hash === digest(cookies.browser)).toBe(true);
    expect(args.p_pairing_hash === digest(cookies.pair)).toBe(true);
    expect(args.p_origin).toBe("https://radio.test");
    expect(h.fetchCalls.length).toBe(0);
  });
  it("honors shared throttling without an upstream call", async () => {
    const h = harness(); h.rpc(async () => ({ status: "pending", retry_in: 4 }));
    const result = await h.handlers.poll(request("pair/poll"));
    expect(await result.json()).toEqual({ status: "pending" });
    expect(result.headers.get("Retry-After")).toBe("4");
    expect(h.fetchCalls.length).toBe(0);
  });
  it.each(["authorization_pending", "slow_down", "expired_token", "access_denied"])("maps device grant error %s", async error => {
    const h = harness(); h.fetch(async () => response({ error, error_description: "private" }, 400));
    const result = await h.handlers.poll(request("pair/poll"));
    const expected = error === "expired_token" ? "expired" : error === "access_denied" ? "error" : "pending";
    expect(await result.json()).toEqual({ status: expected });
    expect(h.rpcCalls.at(-1)!.name).toBe("web_pair_finish");
    if (error === "slow_down") expect(result.headers.get("Retry-After")).toBe("10");
    expect(cookieNames(result).includes(SESSION_COOKIE)).toBe(false);
  });
  it("consumes a verified UUID once, ignoring forged headers, body and query", async () => {
    const h = harness(); h.fetch(async () => response(grant()));
    const result = await h.handlers.poll(request(`pair/poll?user_uuid=${OTHER}`, "GET", { headers: { "x-user-uuid": OTHER } }));
    expect(await result.json()).toEqual({ status: "approved" });
    const stored = h.rpcCalls.find(c => c.name === "web_pair_consume")!.args;
    expect(stored.p_user_uuid).toBe(USER);
    expect(typeof stored.p_session_hash === "string" && stored.p_session_hash.length === 64).toBe(true);
    expect(cookieNames(result).includes(SESSION_COOKIE)).toBe(true);
    expect(secureCookies(result)).toBe(true);
  });
  it.each(["consume-first", "signout-first"])("a delayed approval response never revives validity: %s", async order => {
    const h = harness(); let cancelled = false; let sessionHash: unknown = null;
    let entered!: () => void; const atConsume = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
    h.fetch(async () => response(grant()));
    h.rpc(async (name, args) => {
      if (name === "web_pair_claim") return { status: "poll", device_code: "fixture-device", interval: 5 };
      if (name === "web_pair_consume") {
        if (order === "consume-first") sessionHash = args.p_session_hash;
        entered(); await gate;
        if (order === "signout-first") return !cancelled;
        return true; // The committed result's HTTP response is delayed.
      }
      if (name === "web_signout") { cancelled = true; sessionHash = null; return true; }
      if (name === "web_session_roll") return sessionHash === args.p_session_hash ? { user_uuid: USER } : null;
      return true;
    });
    const approval = h.handlers.poll(request("pair/poll")); await atConsume;
    h.advance(1000);
    await h.handlers.signout(request("signout", "POST", { headers: {
      Cookie: `__Host-pr-pair=${cookies.pair}; __Host-pr-browser=${cookies.browser}`,
    } }));
    resume(); const result = await approval;
    expect(await result.json()).toEqual({ status: order === "consume-first" ? "approved" : "expired" });
    const sessionCookie = result.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`));
    if (sessionCookie) {
      const req = request("session", "GET", { headers: { Cookie: sessionCookie.split(";")[0]! } });
      expect(await createSessionValidator(h.runtime)(req)).toBeNull();
    } else expect(order).toBe("signout-first");
  });
  it("does not issue a session when atomic consume loses a race", async () => {
    const h = harness(); h.fetch(async () => response(grant()));
    h.rpc(async name => name === "web_pair_claim" ? { status: "poll", device_code: "fixture-device", interval: 5 } : false);
    const result = await h.handlers.poll(request("pair/poll"));
    expect(await result.json()).toEqual({ status: "expired" });
    expect(cookieNames(result).includes(SESSION_COOKIE)).toBe(false);
  });
  it.each([
    { uuid: undefined }, { uuid: "not-a-uuid" }, { uuid: "00000000-0000-0000-0000-000000000000" },
    { access_token: "" }, { refresh_token: "" }, { token_type: "Basic" }, { expires_in: 0 }, { expires_in: -100 },
    { email: undefined }, { email: "bad" }, { access_token: "bad\r\ntoken" },
    { accessToken: "conflicting" },
  ])("never consumes an unverified grant %j", async patch => {
    const h = harness(); h.fetch(async () => response({ ...grant(), ...patch }));
    const result = await h.handlers.poll(request("pair/poll"));
    expect(await result.json()).toEqual({ status: "error" });
    expect(h.rpcCalls.some(c => c.name === "web_pair_consume")).toBe(false);
    expect(cookieNames(result).includes(SESSION_COOKIE)).toBe(false);
  });
  it("reports a redacted poll error when storage is unavailable", async () => {
    const h = harness(); h.rpc(async () => { throw new Error("private storage details"); });
    const result = await h.handlers.poll(request("pair/poll"));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ status: "error" });
    expect(result.headers.has("Set-Cookie")).toBe(false);
  });
  it("recognizes only source-backed lowerCamelCase token aliases", () => {
    const g = grant();
    expect(verifyGrant({ uuid: g.uuid, email: g.email, accessToken: g.access_token,
      refreshToken: g.refresh_token, tokenType: g.token_type, expiresIn: "3600" }).userUuid).toBe(USER);
    expect(() => verifyGrant({ token: "unproven", user: { uuid: USER }, email: g.email })).toThrow();
  });
});

describe("sessions and sign-outs", () => {
  it("returns only the signed-in flag and verified email, and renews the 90-day cookie", async () => {
    const h = harness(); const result = await h.handlers.session(request("session"));
    expect(await result.json()).toEqual({ signedIn: true, email: "test@example.invalid" });
    expect(result.headers.getSetCookie().every(s => s.includes("Max-Age=7776000;"))).toBe(true);
    expect(secureCookies(result)).toBe(true);
  });
  it("returns signed-out without storage for a missing session", async () => {
    const h = harness(); const result = await h.handlers.session(request("session", "GET", { headers: { Cookie: "" } }));
    expect(await result.json()).toEqual({ signedIn: false }); expect(h.rpcCalls.length).toBe(0);
  });
  it.each([null, { user_uuid: "forged" }, { uuid: USER }, { user_uuid: "00000000-0000-0000-0000-000000000000" }])(
    "rejects missing, expired or invalid stored identity %j", async data => {
      const h = harness(); h.rpc(async () => data);
      expect(await createSessionValidator(h.runtime)(request("session"))).toBeNull();
    });
  it("fails closed on storage errors without returning raw errors", async () => {
    const h = harness(); h.rpc(async () => { throw new Error("private"); });
    expect(await (await h.handlers.session(request("session"))).json()).toEqual({ signedIn: false });
  });
  it("rejects duplicate or malformed cookie identifiers", async () => {
    const h = harness();
    for (const value of ["short", "%61".repeat(64), `${cookies.session}; __Host-pr-session=${cookies.session}`]) {
      expect(cookie(request("session", "GET", { headers: { Cookie: `__Host-pr-session=${value}` } }), SESSION_COOKIE)).toBeNull();
    }
    expect(h.rpcCalls.length).toBe(0);
  });
  it("signs out only the hashed browser session and cancels its pending pairing", async () => {
    const h = harness(); const result = await h.handlers.signout(request("signout", "POST"));
    expect(await result.json()).toEqual({ signedIn: false });
    expect(h.rpcCalls.map(c => c.name)).toEqual(["web_signout"]);
    expect(h.rpcCalls[0]!.args).toEqual({ p_session_hash: digest(cookies.session),
      p_pairing_hash: digest(cookies.pair), p_browser_hash: digest(cookies.browser),
      p_origin: ORIGIN, p_now: new Date(h.runtime.now()).toISOString(), p_everywhere: false });
    expect(result.headers.getSetCookie().every(s => s.includes("Max-Age=0;"))).toBe(true);
  });
  it("signs out everywhere using session-derived identity only", async () => {
    const h = harness(); const result = await h.handlers.everywhere(request("signout/everywhere", "POST", {
      body: JSON.stringify({ user_uuid: OTHER }), headers: { "x-user-uuid": OTHER },
    }));
    expect(await result.json()).toEqual({ signedIn: false });
    expect(h.rpcCalls.map(c => c.name)).toEqual(["web_signout"]);
    expect(h.rpcCalls[0]!.args.p_everywhere).toBe(true);
    expect(h.rpcCalls[0]!.args.p_session_hash).toBe(digest(cookies.session));
    expect(h.rpcCalls[0]!.args.p_user_uuid).toBeUndefined();
  });
});

describe("origin and methods", () => {
  it.each(["start", "poll", "signout", "everywhere", "probes"] as const)("rejects cross-origin %s before touching storage/network", async name => {
    const h = harness();
    const cases: Array<Record<string, string>> = [{ Origin: "https://evil.test" }, { Origin: "null" },
      { Origin: "https://radio.test", "Sec-Fetch-Site": "same-site" }, { Origin: "" }];
    for (const headers of cases) {
      const method = name === "poll" || name === "probes" ? "GET" : "POST";
      expect((await h.handlers[name](request(name, method, { headers }))).status).toBe(403);
    }
    expect(h.rpcCalls.length).toBe(0); expect(h.fetchCalls.length).toBe(0);
  });
  it("accepts GET poll with browser same-origin fetch metadata and no Origin", async () => {
    const h = harness(); h.rpc(async () => ({ status: "pending", retry_in: 5 }));
    const req = request("pair/poll"); req.headers.delete("Origin"); req.headers.set("Sec-Fetch-Site", "same-origin");
    expect((await h.handlers.poll(req)).status).toBe(200);
  });
  it("rejects poll without either origin evidence", async () => {
    const h = harness(); const req = request("pair/poll"); req.headers.delete("Origin");
    expect((await h.handlers.poll(req)).status).toBe(403); expect(h.rpcCalls.length).toBe(0);
  });
  it("rejects wrong methods without side effects", async () => {
    const h = harness();
    expect((await h.handlers.start(request("pair/start"))).status).toBe(405);
    expect((await h.handlers.poll(request("pair/poll", "POST"))).status).toBe(405);
    expect((await h.handlers.signout(request("signout"))).status).toBe(405);
    expect(h.rpcCalls.length).toBe(0);
  });
});

describe("read-only probes and refresh", () => {
  it("upstream helper rejects arbitrary paths and sync writes independently", async () => {
    const h = harness();
    for (const path of ["https://evil.test", "../user/token", "up_next/sync", "sync/update_episode"]) {
      await expect(pcRequest(h.runtime, path, {})).rejects.toThrow("Unsupported upstream operation");
    }
    expect(h.fetchCalls.length).toBe(0);
  });
  it("lists pending experiments without calling Pocket Casts", async () => {
    const h = harness(); const result = await h.handlers.probes(request("probes"));
    const data = await result.json() as { probes: Array<{ status: string }> };
    expect(data.probes.every(p => p.status === "pending")).toBe(true);
    expect(h.fetchCalls.length).toBe(0);
  });
  it.each(["up_next/sync", "sync/update_episode"])("reports %s manual without automatic writes", async path => {
    const h = harness();
    expect(await (await h.handlers.probes(request(`probes?endpoint=${path}`))).json()).toMatchObject({ status: "pending", mode: "manual" });
    expect(h.fetchCalls.length).toBe(0);
  });
  it.each(["endpoint=https://evil.test", "endpoint=user/token", "endpoint=user/podcast/list&path=user/token",
    "endpoint=user/podcast/list&endpoint=user/token", "endpoint=user/podcast/episodes&podcastUuid=bad"])("rejects arbitrary paths/input %s", async query => {
    const h = harness(); expect((await h.handlers.probes(request(`probes?${query}`))).status).toBe(400);
    expect(h.fetchCalls.length).toBe(0);
  });
  it("allows only the empty-settings named settings read and returns structural evidence", async () => {
    const h = harness(); h.fetch(async () => response({ token: "private", uuid: USER, email: "private@example.invalid", settings: {} }));
    const result = await h.handlers.probes(request("probes?endpoint=user/named_settings"));
    expect(h.fetchCalls[0]!.url).toBe("https://api.pocketcasts.com/user/named_settings/update");
    expect(JSON.parse(String(h.fetchCalls[0]!.init!.body))).toEqual({ m: "PocketRadio" });
    expect(await result.json()).toEqual({ endpoint: "user/named_settings", status: "observed", httpStatus: 200, format: "json-object" });
  });
  it("bounds probe work persistently", async () => {
    const h = harness(); h.rpc(async name => name === "web_session_roll" ? { user_uuid: USER } : false);
    expect((await h.handlers.probes(request("probes?endpoint=user/podcast/list"))).status).toBe(429);
    expect(h.fetchCalls.length).toBe(0);
  });
  it("reports non-JSON responses without exposing bytes", async () => {
    const h = harness(); h.fetch(async () => new Response(new Uint8Array([8, 1]), { headers: { "Content-Type": "application/octet-stream" } }));
    expect(await (await h.handlers.probes(request("probes?endpoint=user/playlist/list"))).json()).toMatchObject({ format: "non-json" });
  });
  it("refreshes only server-held tokens and CAS-stores a matching verified identity", async () => {
    const h = harness(); h.rpc(async name => name === "web_token_claim" ? { status: "refresh", user_uuid: USER, refresh_token: "fixture-refresh" } : true);
    h.fetch(async () => response(grant()));
    expect((await accessToken(h.runtime, digest(cookies.session))) !== null).toBe(true);
    expect(h.rpcCalls.at(-1)!.name).toBe("web_session_check");
    expect(h.rpcCalls.find(c => c.name === "web_token_finish")!.args.p_user_uuid).toBe(USER);
    expect(JSON.parse(String(h.fetchCalls[0]!.init!.body)).grant_type).toBe("refresh_token");
  });
  it("rejects refresh identity changes and releases the lease", async () => {
    const h = harness(); h.rpc(async name => name === "web_token_claim" ? { status: "refresh", user_uuid: USER, refresh_token: "fixture-refresh" } : true);
    h.fetch(async () => response({ ...grant(), uuid: OTHER }));
    expect(await accessToken(h.runtime, digest(cookies.session))).toBeNull();
    expect(h.rpcCalls.at(-1)!.name).toBe("web_token_release");
    expect(h.rpcCalls.some(c => c.name === "web_token_finish")).toBe(false);
  });
  it.each(["signout", "everywhere"] as const)("%s atomically cancels pairing without a preexisting session cookie", async name => {
    const h = harness();
    await h.handlers[name](request(name, "POST", { headers: {
      Cookie: `__Host-pr-pair=${cookies.pair}; __Host-pr-browser=${cookies.browser}`,
    } }));
    expect(h.rpcCalls.map(c => c.name)).toEqual(["web_signout"]);
    expect(h.rpcCalls[0]!.args.p_session_hash).toBeNull();
    expect(h.rpcCalls[0]!.args.p_pairing_hash).toBe(digest(cookies.pair));
  });
  it("stores B's rotation but denies A access if A signs out during upstream refresh", async () => {
    const h = harness(); let active = true;
    let fetched!: () => void; const started = new Promise<void>(resolve => { fetched = resolve; });
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    h.rpc(async name => {
      if (name === "web_token_claim") return { status: "refresh", user_uuid: USER, refresh_token: "fixture-refresh" };
      if (name === "web_signout") { active = false; return true; }
      if (name === "web_session_check") return active;
      return true;
    });
    h.fetch(async () => { fetched(); await gate; return response(grant()); });
    const refresh = accessToken(h.runtime, digest(cookies.session));
    await started; h.advance(1000); await h.handlers.signout(request("signout", "POST"));
    finish(); expect(await refresh).toBeNull();
    expect(h.rpcCalls.some(c => c.name === "web_token_finish")).toBe(true);
    expect(h.rpcCalls.at(-1)!.name).toBe("web_session_check");
  });
  it("does not return a stale refresh after CAS failure", async () => {
    const h = harness(); h.rpc(async name => name === "web_token_claim" ? { status: "refresh", user_uuid: USER, refresh_token: "fixture-refresh" } : false);
    h.fetch(async () => response(grant()));
    expect(await accessToken(h.runtime, digest(cookies.session))).toBeNull();
  });
});
