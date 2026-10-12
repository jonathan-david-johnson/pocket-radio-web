import { expect, it, vi } from "vitest";
import { RelayCore, SESSION_INTERVAL_MS, TOMBSTONE_TTL_MS } from "../../workers/relay/core";
import { RPC_TIMEOUT_MS, type RelayRpc } from "../../functions/_lib/relay/rpc";
import { harness, internal, OWNER, STREAM, SESSION_HASH, readText } from "./harness";

it("persists the authenticated session hash and releases its lease on end without rolling it", async () => {
  const h = harness();
  const rpc = vi.fn<RelayRpc>(async () => true);
  const core = new RelayCore({ ...h.deps, rpc });
  const request = internal("init", OWNER, { streamUrl: STREAM });
  request.headers.set("x-relay-session-hash", "c".repeat(64));
  expect((await core.fetch(request)).status).toBe(201);
  expect(h.record()).toHaveProperty("sessionHash", "c".repeat(64));
  await core.fetch(internal("stop"));
  expect(rpc).toHaveBeenCalledWith("web_relay_release", {
    p_session_hash: "c".repeat(64), p_relay_id: request.headers.get("x-relay-id"),
  }, expect.any(AbortSignal));
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(["web_session_check", "web_relay_release"]);
});

it("ends active audio and SSE on session revocation without new browser requests", async () => {
  const h = harness();
  await h.init();
  const audio = (await h.core.fetch(internal("audio"))).body!.getReader();
  const events = (await h.core.fetch(internal("events"))).body!.getReader();
  await readText(events);
  h.rpc.mockResolvedValue(false);
  await h.tick(SESSION_INTERVAL_MS);
  await expect(audio.read()).rejects.toThrow("Relay ended");
  expect(await readText(events)).toContain("event: stopped");
  expect((await events.read()).done).toBe(true);
  expect(h.rpc.mock.calls.map(() => true)).toHaveLength(3); // init, recheck, release
  expect(h.canceled).toHaveBeenCalledOnce();
  expect(h.timeouts.size).toBe(0);
  expect(h.heartbeat.size).toBe(0);
});

it("fails closed by 15s when the session check transport never settles or obeys abort", async () => {
  const h = harness();
  await h.init();
  const audio = (await h.core.fetch(internal("audio"))).body!.getReader();
  const events = (await h.core.fetch(internal("events"))).body!.getReader();
  await readText(events);
  let checkSignal!: AbortSignal;
  const rpc: RelayRpc = async (name, _parameters, signal) => {
    if (name === "web_relay_release") return true;
    checkSignal = signal;
    return new Promise<boolean>(() => {});
  };
  h.deps.rpc.mockImplementation(rpc);
  await h.tick(SESSION_INTERVAL_MS);
  expect(h.record()?.phase).toBe("playing");
  await h.tick(RPC_TIMEOUT_MS - 1);
  expect(h.record()?.phase).toBe("playing");
  await h.tick(1);
  expect(checkSignal.aborted).toBe(true);
  expect(h.record()?.phase).toBe("ended");
  await expect(audio.read()).rejects.toThrow("Relay ended");
  expect(await readText(events)).toContain("event: stopped");
  expect(h.timeouts.size).toBe(0);
});

it("uses nonrolling check for SSE-only handles and closes them on database error", async () => {
  const h = harness();
  await h.init();
  const events = (await h.core.fetch(internal("events"))).body!.getReader();
  await readText(events);
  h.rpc.mockRejectedValue(new Error("injected DB failure"));
  await h.tick(SESSION_INTERVAL_MS);
  expect(await readText(events)).toContain("event: stopped");
  expect(h.network).not.toHaveBeenCalled();
  // Release is bounded independently even when it fails.
  expect(h.record()?.phase).toBe("ended");
});

it("denies initialization if the admitted session was revoked before DO init", async () => {
  const h = harness();
  h.rpc.mockResolvedValue(false);
  expect((await h.init()).status).toBe(401);
  expect(h.record()?.phase).toBe("ended");
  expect(h.network).not.toHaveBeenCalled();
});

it("releases a lease even if terminal persistence fails, after closing audio and SSE", async () => {
  const h = harness();
  await h.init();
  const audio = (await h.core.fetch(internal("audio"))).body!.getReader();
  const events = (await h.core.fetch(internal("events"))).body!.getReader();
  await readText(events);
  h.deps.storage.put = async () => { throw new Error("injected storage failure"); };
  await expect(h.core.fetch(internal("stop"))).rejects.toThrow("injected storage failure");
  await expect(audio.read()).rejects.toThrow("Relay ended");
  expect(await readText(events)).toContain("event: stopped");
  expect(h.rpc).toHaveBeenCalledWith("web_relay_release", {
    p_session_hash: SESSION_HASH, p_relay_id: internal("stop").headers.get("x-relay-id"),
  }, expect.any(AbortSignal));
});

it("ends failed initialization and releases its lease if initial storage fails", async () => {
  const h = harness();
  h.deps.storage.put = async () => { throw new Error("injected storage failure"); };
  await expect(h.init()).rejects.toThrow("injected storage failure");
  expect(h.rpc).toHaveBeenCalledWith("web_relay_release", expect.any(Object), expect.any(AbortSignal));
  expect(h.network).not.toHaveBeenCalled();
  expect((await h.core.fetch(internal("audio"))).status).toBe(410);
});

it("deletes owner, session hash, URL and all storage after 24h; an old init cannot reopen it", async () => {
  const h = harness();
  await h.init();
  await h.core.fetch(internal("stop"));
  const expiresAt = h.record()!.expiresAt;
  h.advance(TOMBSTONE_TTL_MS - 1);
  await h.core.alarm();
  expect(h.record()?.sessionHash).toBe(SESSION_HASH);
  expect(h.alarms.at(-1)).toBe(expiresAt);
  h.advance(1);
  await h.core.alarm();
  expect(h.record()).toBeUndefined();
  expect((await h.init()).status).toBe(410);
  const restored = new RelayCore(h.deps);
  expect((await restored.fetch(internal("init", OWNER, { streamUrl: STREAM }))).status).toBe(410);
  expect(h.record()).toBeUndefined();
  expect(h.network).not.toHaveBeenCalled();
});

it("restart releases a nonterminal lease, retains its existing terminal expiry, and later purges it", async () => {
  const h = harness();
  await h.init();
  const recovered = new RelayCore(h.deps);
  expect((await recovered.fetch(internal("audio"))).status).toBe(410);
  const expiry = h.record()!.expiresAt;
  expect(h.rpc).toHaveBeenCalledTimes(2); // initial check + recovery release
  h.advance(TOMBSTONE_TTL_MS - 1);
  const recoveredAgain = new RelayCore(h.deps);
  expect((await recoveredAgain.fetch(internal("audio"))).status).toBe(410);
  expect(h.record()!.expiresAt).toBe(expiry);
  h.advance(1);
  await recoveredAgain.alarm();
  expect(h.record()).toBeUndefined();
});

it("rejects missing hashes, expired and future timestamp prefixes before storage or upstream", async () => {
  const missing = harness();
  const request = internal("init", OWNER, { streamUrl: STREAM });
  request.headers.delete("x-relay-session-hash");
  expect((await missing.core.fetch(request)).status).toBe(403);
  expect(missing.record()).toBeUndefined();
  const expired = harness();
  expired.advance(30_000);
  expect((await expired.init()).status).toBe(410);
  expect(expired.record()).toBeUndefined();
  const future = harness();
  const futureCore = new RelayCore({ ...future.deps, matchesId: () => true });
  const init = internal("init", OWNER, { streamUrl: STREAM });
  init.headers.set("x-relay-id", "0000000003e9" + "a".repeat(52));
  expect((await futureCore.fetch(init)).status).toBe(410);
  expect(future.record()).toBeUndefined();
});
