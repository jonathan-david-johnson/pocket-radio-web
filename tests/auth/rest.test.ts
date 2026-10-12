import { afterEach, expect, it, vi } from "vitest";
import { requireSession } from "../../functions/_lib/auth/session";
import { createRuntime, readJson } from "../../functions/_lib/auth/runtime";
import type { Env } from "../../functions/_lib/env";
import { cookies, digest, request, response, USER } from "./harness";

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
it("limits JSON response size rather than buffering arbitrary upstream data", async () => {
  const result = response({ long: "x".repeat(64) });
  await expect(readJson(result, 32)).rejects.toThrow("Response too large");
});
it("does not interpret non-JSON upstream bytes as identity", async () => {
  await expect(readJson(new Response("private", { headers: { "Content-Type": "text/plain" } }))).rejects.toThrow("Expected JSON");
});
