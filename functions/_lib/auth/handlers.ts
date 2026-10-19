import {
  BROWSER_COOKIE, PAIR_COOKIE, SESSION_COOKIE, SESSION_SECONDS, clearCookie,
  cookie, json, sameOrigin, setCookie,
} from "./http";
import { accessToken, authorize, pcRequest, pollGrant } from "./pocket-casts";
import { email, object, readJson, seconds, token, uuid, type AuthRuntime } from "./runtime";
import { createSessionValidator } from "./session";

const PROBES = {
  "user/podcast/list": "read-only",
  "user/podcast/episodes": "read-only",
  "user/playlist/list": "read-only",
  "user/named_settings": "read-only",
  "up_next/sync": "manual",
  "sync/update_episode": "manual",
} as const;

export function createAuthHandlers(runtime: AuthRuntime) {
  const validate = createSessionValidator(runtime);
  const now = () => new Date(runtime.now()).toISOString();
  const guard = (request: Request, method: string, mutation: boolean): Response | null => {
    if (request.method !== method) {
      const response = json({ error: "Method not allowed" }, 405);
      response.headers.set("Allow", method);
      return response;
    }
    return sameOrigin(request, mutation) ? null : json({ error: "Same-origin request required" }, 403);
  };
  const wrap = (handler: (request: Request) => Promise<Response>, errorBody: unknown = { error: "Authentication service unavailable" }) =>
    async (request: Request): Promise<Response> => {
      try { return await handler(request); }
      catch { return json(errorBody, 503); }
    };
  const refreshCookie = (request: Request, response: Response) => {
    const value = cookie(request, SESSION_COOKIE);
    if (value) setCookie(response, SESSION_COOKIE, value, SESSION_SECONDS);
  };

  const signout = (everywhere: boolean) => wrap(async (request: Request) => {
    const rejected = guard(request, "POST", true);
    if (rejected) return rejected;
    const handle = cookie(request, SESSION_COOKIE);
    const pairing = cookie(request, PAIR_COOKIE);
    const browser = cookie(request, BROWSER_COOKIE);
    // One transaction cancels the pairing and revokes its minted session even
    // when approval's Set-Cookie response has not reached this browser yet.
    await runtime.rpc("web_signout", {
      p_session_hash: handle ? await runtime.hash(handle) : null,
      p_pairing_hash: pairing && browser ? await runtime.hash(pairing) : null,
      p_browser_hash: pairing && browser ? await runtime.hash(browser) : null,
      p_origin: new URL(request.url).origin, p_now: now(), p_everywhere: everywhere,
    });
    const response = json({ signedIn: false });
    clearCookie(response, SESSION_COOKIE); clearCookie(response, PAIR_COOKIE);
    return response;
  });

  return {
    start: wrap(async request => {
      const rejected = guard(request, "POST", true);
      if (rejected) return rejected;
      const browser = cookie(request, BROWSER_COOKIE) ?? runtime.random();
      const pairing = runtime.random();
      const browserHash = await runtime.hash(browser);
      const pairingHash = await runtime.hash(pairing);
      const origin = new URL(request.url).origin;
      const reserved = await runtime.rpc("web_pair_reserve", {
        p_pairing_hash: pairingHash, p_browser_hash: browserHash, p_origin: origin, p_now: now(),
      });
      if (reserved !== true) return json({ error: "Pairing rate limit" }, 429);
      try {
        const data = await authorize(runtime);
        const activated = await runtime.rpc("web_pair_activate", {
          p_pairing_hash: pairingHash, p_browser_hash: browserHash, p_origin: origin, p_now: now(),
          p_device_code: data.deviceCode, p_expires_in: data.expiresIn, p_interval: data.interval,
        });
        if (activated !== true) throw new Error("Pairing unavailable");
        const response = json({ userCode: data.userCode, pairingUri: `pktc://pair?user_code=${encodeURIComponent(data.userCode)}`,
          expiresIn: data.expiresIn, interval: data.interval });
        setCookie(response, PAIR_COOKIE, pairing, data.expiresIn);
        setCookie(response, BROWSER_COOKIE, browser, SESSION_SECONDS);
        return response;
      } catch {
        await runtime.rpc("web_pair_cancel", { p_pairing_hash: pairingHash, p_browser_hash: browserHash, p_origin: origin });
        return json({ error: "Pairing unavailable" }, 502);
      }
    }),
    poll: wrap(async request => {
      const rejected = guard(request, "GET", true);
      if (rejected) return rejected;
      const pairing = cookie(request, PAIR_COOKIE);
      const browser = cookie(request, BROWSER_COOKIE);
      if (!pairing || !browser) return json({ status: "expired" });
      const binding = {
        p_pairing_hash: await runtime.hash(pairing), p_browser_hash: await runtime.hash(browser),
        p_origin: new URL(request.url).origin,
      };
      const lease = runtime.random();
      const claimed = object(await runtime.rpc("web_pair_claim", { ...binding, p_lease: lease, p_now: now() }));
      if (claimed.status !== "poll") {
        const status = claimed.status === "pending" ? "pending" : "expired";
        const response = json({ status });
        if (status === "pending") response.headers.set("Retry-After", String(seconds(claimed.retry_in, 900)));
        else clearCookie(response, PAIR_COOKIE);
        return response;
      }
      if (!token(claimed.device_code)) throw new Error("Invalid state");
      const interval = seconds(claimed.interval, 60);
      let result;
      try { result = await pollGrant(runtime, claimed.device_code); }
      catch { result = { status: "error" } as const; }
      if (result.status !== "approved") {
        const status = result.status === "slow_down" ? "pending" : result.status;
        const finished = await runtime.rpc("web_pair_finish", {
          ...binding, p_lease: lease, p_now: now(), p_status: result.status,
        });
        const response = json({ status: finished === true ? status : "expired" });
        if (finished === true && status === "pending") {
          response.headers.set("Retry-After", String(result.status === "slow_down" ? Math.min(60, interval + 5) : interval));
        } else clearCookie(response, PAIR_COOKIE);
        return response;
      }
      const handle = runtime.random();
      const grant = result.grant;
      const consumed = await runtime.rpc("web_pair_consume", {
        ...binding, p_lease: lease, p_now: now(), p_session_hash: await runtime.hash(handle),
        p_user_uuid: grant.userUuid, p_email: grant.email, p_access_token: grant.accessToken,
        p_refresh_token: grant.refreshToken, p_expires_in: grant.expiresIn,
      });
      const response = json({ status: consumed === true ? "approved" : "expired" });
      clearCookie(response, PAIR_COOKIE);
      if (consumed === true) setCookie(response, SESSION_COOKIE, handle, SESSION_SECONDS);
      return response;
    }, { status: "error" }),
    session: wrap(async request => {
      const rejected = guard(request, "GET", false);
      if (rejected) return rejected;
      const identity = await validate(request);
      if (!identity) return json({ signedIn: false });
      const data = await runtime.rpc("web_session_email", { p_session_hash: identity.sessionHash, p_now: now() });
      if (!email(data)) return json({ signedIn: false });
      const response = json({ signedIn: true, email: data });
      refreshCookie(request, response);
      return response;
    }),
    signout: signout(false),
    everywhere: signout(true),
    probes: wrap(async request => {
      const rejected = guard(request, "GET", true);
      if (rejected) return rejected;
      const identity = await validate(request);
      if (!identity) return json({ error: "Sign in required" }, 401);
      const url = new URL(request.url);
      const endpoint = url.searchParams.get("endpoint");
      for (const key of url.searchParams.keys()) {
        if (key !== "endpoint" && key !== "podcastUuid") return json({ error: "Unsupported probe parameter" }, 400);
        if (url.searchParams.getAll(key).length !== 1) return json({ error: "Duplicate probe parameter" }, 400);
      }
      if (endpoint === null) return json({ probes: Object.entries(PROBES).map(([name, mode]) => ({
        endpoint: name, status: "pending", mode,
      })) });
      if (!Object.hasOwn(PROBES, endpoint)) return json({ error: "Unsupported probe" }, 400);
      if (PROBES[endpoint as keyof typeof PROBES] === "manual") return json({
        endpoint, status: "pending", mode: "manual", reason: "Write-capable endpoint; not called automatically",
      });
      let body: Record<string, unknown> = { v: "2", m: "mobile" };
      let path = endpoint;
      if (endpoint === "user/podcast/episodes") {
        const podcastUuid = url.searchParams.get("podcastUuid");
        if (!uuid(podcastUuid)) return json({ error: "Valid podcastUuid required" }, 400);
        body.uuid = podcastUuid;
      } else if (url.searchParams.has("podcastUuid")) return json({ error: "Unsupported probe parameter" }, 400);
      if (endpoint === "user/named_settings") { path = "user/named_settings/update"; body = { m: "PocketRadio" }; }
      const allowed = await runtime.rpc("web_probe_claim", { p_session_hash: identity.sessionHash, p_now: now() });
      if (allowed !== true) {
        const response = json({ error: "Probe rate limit" }, 429); response.headers.set("Retry-After", "30"); return response;
      }
      const access = await accessToken(runtime, identity.sessionHash);
      if (!access) return json({ endpoint, status: "error", reason: "Token unavailable" }, 502);
      const response = await pcRequest(runtime, path, body, access);
      const status = response.status;
      let format = "non-json";
      try {
        const data = await readJson(response, 1_048_576);
        // Return structural evidence only. Never pass upstream bodies, keys,
        // emails, UUIDs, errors, tokens or response headers to the browser.
        if (data !== null && typeof data === "object") format = Array.isArray(data) ? "json-array" : "json-object";
        else format = "json-scalar";
      } catch { /* Raw bytes and errors are deliberately not returned. */ }
      const result = json({ endpoint, status: response.ok ? "observed" : "error", httpStatus: status, format });
      refreshCookie(request, result);
      return result;
    }),
  };
}
