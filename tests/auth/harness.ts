/// <reference types="node" />
import { createHash } from "node:crypto";
import { createAuthHandlers } from "../../functions/_lib/auth/handlers";
import type { AuthRuntime } from "../../functions/_lib/auth/runtime";

export const USER = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export const ORIGIN = "https://radio.test";
export const grant = () => ({ uuid: USER, email: "test@example.invalid", access_token: "fixture-access",
  refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
export const authResponse = () => ({ device_code: "fixture-device", user_code: "ABCD-EFGH", expires_in: 600, interval: 5 });
export const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export const cookies = {
  session: "1".repeat(64), pair: "2".repeat(64), browser: "3".repeat(64),
};
export function request(path: string, method = "GET", options: { headers?: Record<string, string>; body?: string } = {}) {
  return new Request(`${ORIGIN}/api/${path}`, { method, headers: {
    Origin: ORIGIN, Cookie: `__Host-pr-session=${cookies.session}; __Host-pr-pair=${cookies.pair}; __Host-pr-browser=${cookies.browser}`,
    ...options.headers,
  }, ...(options.body ? { body: options.body } : {}) });
}
export function harness() {
  let time = Date.UTC(2026, 9, 11);
  let serial = 10;
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let rpcImpl: AuthRuntime["rpc"] = async name => {
    if (name === "web_pair_claim") return { status: "poll", device_code: "fixture-device", interval: 5 };
    if (name === "web_session_roll") return { user_uuid: USER };
    if (name === "web_session_email") return "test@example.invalid";
    if (name === "web_token_claim") return { status: "ready", access_token: "fixture-access" };
    return true;
  };
  let fetchImpl: AuthRuntime["fetch"] = async () => { throw new Error("Unexpected network use"); };
  const runtime: AuthRuntime = {
    now: () => time, random: () => (++serial).toString(16).padStart(64, "0"),
    hash: async value => digest(value),
    rpc: async (name, args) => { rpcCalls.push({ name, args }); return rpcImpl(name, args); },
    fetch: async (url, init) => { fetchCalls.push({ url, init }); return fetchImpl(url, init); },
  };
  return { runtime, handlers: createAuthHandlers(runtime), rpcCalls, fetchCalls,
    rpc: (impl: AuthRuntime["rpc"]) => { rpcImpl = impl; },
    fetch: (impl: AuthRuntime["fetch"]) => { fetchImpl = impl; },
    advance: (ms: number) => { time += ms; },
  };
}
