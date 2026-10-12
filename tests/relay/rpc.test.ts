import { expect, it, vi } from "vitest";
import { boundedRpc, createRelayRpc, RPC_TIMEOUT_MS, type RelayRpc } from "../../functions/_lib/relay/rpc";
import { randomRelayId, relayCreatedAt } from "../../functions/_lib/relay/security";

const env = { SUPABASE_URL: "https://database.test", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key" };

it("uses service-role-only POST RPC with no redirects or browser identity", async () => {
  const network = vi.fn(async () => new Response("true"));
  const rpc = createRelayRpc(env, network);
  const abort = new AbortController();
  expect(await rpc("web_session_check", { p_session_hash: "c".repeat(64), p_now: "1970-01-01T00:00:01.000Z" }, abort.signal)).toBe(true);
  expect(network.mock.calls[0]).toEqual(["https://database.test/rest/v1/rpc/web_session_check", {
    method: "POST", redirect: "manual", signal: abort.signal,
    headers: { "Content-Type": "application/json", apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY },
    body: JSON.stringify({ p_session_hash: "c".repeat(64), p_now: "1970-01-01T00:00:01.000Z" }),
  }]);
});

it.each(["{}", "[true]", "null", "\"true\"", "true".repeat(17)])("rejects nonboolean or oversized scalar RPC replies", async body => {
  const rpc = createRelayRpc(env, async () => new Response(body));
  await expect(rpc("web_session_check", {}, new AbortController().signal)).rejects.toThrow("response invalid");
});

it.each(["http://database.test", "https://user:password@database.test", "https://database.test/path", "https://database.test/?query=1"])("rejects unsafe DB configuration before network", async url => {
  const network = vi.fn();
  const rpc = createRelayRpc({ ...env, SUPABASE_URL: url }, network);
  await expect(rpc("web_session_check", {}, new AbortController().signal)).rejects.toThrow("configuration invalid");
  expect(network).not.toHaveBeenCalled();
});

it("bounds a never-settling response body to the 3s RPC deadline even if fetch ignores abort", async () => {
  const network = vi.fn(async () => new Response(new ReadableStream()));
  const rpc = createRelayRpc(env, network);
  let timeout!: () => void;
  const cancel = vi.fn();
  const after = vi.fn((callback: () => void) => { timeout = callback; return cancel; });
  const pending = boundedRpc(rpc, "web_session_check", {}, after);
  await Promise.resolve();
  const rejected = expect(pending).rejects.toThrow("Relay database timeout");
  timeout();
  await rejected;
  expect(after).toHaveBeenCalledWith(expect.any(Function), RPC_TIMEOUT_MS);
  expect(network.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) })]);
  expect(cancel).toHaveBeenCalledOnce();
});

it("does not extend a session when release or checks return false", async () => {
  const rpc: RelayRpc = createRelayRpc(env, async () => new Response("false"));
  expect(await boundedRpc(rpc, "web_relay_release", {})).toBe(false);
  expect(await boundedRpc(rpc, "web_session_check", {})).toBe(false);
});

it("encodes creation time and 208 random bits in a 64-character handle", () => {
  const ids = Array.from({ length: 32 }, () => randomRelayId(1000));
  expect(new Set(ids).size).toBe(32);
  for (const id of ids) {
    expect(id).toMatch(/^0000000003e8[a-f0-9]{52}$/);
    expect(relayCreatedAt(id)).toBe(1000);
  }
});
