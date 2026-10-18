import { afterEach, expect, it, vi } from "vitest";
import { requireSession } from "../../functions/_lib/auth/session";
import { createRuntime, readJson } from "../../functions/_lib/auth/runtime";
import type { Env } from "../../functions/_lib/env";
import { accessToken, authorize, pcRequest, pollGrant } from "../../functions/_lib/auth/pocket-casts";
import { authResponse, cookies, digest, grant, request, response, USER } from "./harness";

const env: Env = { SUPABASE_URL: "https://database.test", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key" };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("the frozen requireSession seam POSTs a hash to Supabase REST with server credentials and deterministic time", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  let calls = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls++;
    expect(url).toBe("https://database.test/rest/v1/rpc/web_session_roll");
    expect(init.method).toBe("POST"); expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey === env.SUPABASE_SERVICE_ROLE_KEY).toBe(true);
    expect(headers.Authorization === `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`).toBe(true);
    expect(Object.keys(headers).includes("x-user-uuid")).toBe(false);
    const args = JSON.parse(String(init.body));
    expect(args.p_session_hash === digest(cookies.session)).toBe(true);
    expect(args.p_now).toBe("2026-10-11T00:00:00.000Z");
    expect(init.signal instanceof AbortSignal).toBe(true);
    return response({ user_uuid: USER });
  });
  const identity = await requireSession(request("session", "GET", { headers: { "x-user-uuid": "forged" } }), env);
  expect(identity?.userUuid).toBe(USER); expect(calls).toBe(1);
});
it("seam fails closed for unsuccessful REST responses without leaking details", async () => {
  vi.stubGlobal("fetch", async () => response({ error: "private" }, 500));
  expect(await requireSession(request("session"), env)).toBeNull();
});
it.each(["http://database.test", "https://database.test/unsafe", "https://database.test?unsafe=1"])(
  "rejects unsafe database configuration %s before forwarding the service key", async url => {
    let calls = 0; vi.stubGlobal("fetch", async () => { calls++; throw new Error("Unexpected network use"); });
    expect(await requireSession(request("session"), { ...env, SUPABASE_URL: url })).toBeNull();
    expect(calls).toBe(0);
  });
it("random handles are cryptographically generated opaque 256-bit identifiers and hashing is SHA-256", async () => {
  const runtime = createRuntime(env);
  const generated = runtime.random();
  expect(/^[0-9a-f]{64}$/.test(generated)).toBe(true);
  expect((await runtime.hash(generated)) === digest(generated)).toBe(true);
});
it.each([undefined, "production", "staging"])("uses the selected Pocket Casts environment %s for authorization, polling, refresh and probes", async selected => {
  const host = selected === "staging" ? "https://api.pocketcasts.net/" : "https://api.pocketcasts.com/";
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return response(url.endsWith("device/authorize") ? authResponse() : grant());
  });
  const runtime = createRuntime({ ...env, PC_API_ENVIRONMENT: selected });
  runtime.rpc = async name => name === "web_token_claim"
    ? { status: "refresh", user_uuid: USER, refresh_token: "fixture-refresh" } : true;
  await authorize(runtime);
  expect((await pollGrant(runtime, "fixture-device")).status).toBe("approved");
  expect(await accessToken(runtime, digest(cookies.session))).toBe("fixture-access");
  await pcRequest(runtime, "user/podcast/list", {}, "fixture-access");
  expect(calls).toEqual([host + "device/authorize", host + "user/token", host + "user/token", host + "user/podcast/list"]);
});
it.each(["", "preview", "https://evil.test/", "STAGING"])("rejects invalid Pocket Casts environment %s without network access", selected => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect(() => createRuntime({ ...env, PC_API_ENVIRONMENT: selected })).toThrow("Invalid Pocket Casts environment");
  expect(fetch).not.toHaveBeenCalled();
});
it("preserves caller cancellation as well as the runtime network deadline", async () => {
  const abort = new AbortController(); let forwarded: AbortSignal | undefined;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { forwarded = init.signal!; return response({}); });
  await createRuntime(env).fetch("https://stream.example.org/metadata", { signal: abort.signal });
  expect(forwarded?.aborted).toBe(false);
  abort.abort(); expect(forwarded?.aborted).toBe(true);
});
it("limits JSON response size rather than buffering arbitrary upstream data", async () => {
  const result = response({ long: "x".repeat(64) });
  await expect(readJson(result, 32)).rejects.toThrow("Response too large");
});
it("does not interpret non-JSON upstream bytes as identity", async () => {
  await expect(readJson(new Response("private", { headers: { "Content-Type": "text/plain" } }))).rejects.toThrow("Expected JSON");
});
