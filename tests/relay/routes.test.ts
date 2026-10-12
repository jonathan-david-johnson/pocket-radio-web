import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../functions/_lib/env";
import { requireSession } from "../../functions/_lib/auth/session";
import { accessRelay, startRelay } from "../../functions/_lib/relay/routes";
import { ownerCapability, RELAY_ID } from "../../functions/_lib/relay/security";
import type { RelayRpc } from "../../functions/_lib/relay/rpc";
import { RelayCore } from "../../workers/relay/core";
import { harness, ID, STREAM, UUID } from "./harness";

vi.mock("../../functions/_lib/auth/session", () => ({ requireSession: vi.fn() }));
const identity = { userUuid: "verified-server-user", sessionHash: "c".repeat(64) };
const rpc = vi.fn<RelayRpc>(async () => true);
const control = { rpc, now: () => 1000 };
const requireMock = vi.mocked(requireSession);
function browser(path: string, body?: unknown, headers?: Record<string, string>): Request {
  return new Request("https://page.test" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: "https://page.test", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function bindings() {
  const forwarded = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname === "/init") return new Response(null, { status: 201 });
    return new Response("forwarded", { headers: { "Cache-Control": "no-store, private" } });
  });
  const idFromName = vi.fn((name: string) => name);
  const env = {
    RELAY_HUB: { idFromName, get: () => ({ fetch: forwarded }) },
  } as unknown as Env;
  const lookup = vi.fn(async () => Response.json([{ stationuuid: UUID, url_resolved: STREAM }]));
  return { env, forwarded, idFromName, lookup };
}
beforeEach(() => { vi.clearAllMocks(); rpc.mockResolvedValue(true); requireMock.mockResolvedValue(identity); });

describe("Pages authenticated relay routes", () => {
  it("POST start accepts stationId only and returns a random opaque handle and same-origin paths", async () => {
    const h = bindings();
    const response = await startRelay(browser("/api/relay/start", { stationId: UUID }), h.env, h.lookup, control);
    expect(response.status).toBe(201);
    const body = await response.json() as { relayId: string; audioUrl: string; eventsUrl: string };
    expect(RELAY_ID.test(body.relayId)).toBe(true);
    expect(body.relayId).not.toContain(UUID);
    expect(body.audioUrl).toBe("/api/relay/" + body.relayId);
    expect(body.eventsUrl).toBe("/api/relay-events/" + body.relayId);
    expect(JSON.stringify(body)).not.toContain(identity.userUuid);
    expect(JSON.stringify(body)).not.toContain(identity.sessionHash);
    expect(h.lookup).toHaveBeenCalledOnce();
    expect(h.forwarded).toHaveBeenCalledOnce();
    const internal = h.forwarded.mock.calls[0]![0];
    expect(new URL(internal.url).pathname).toBe("/init");
    expect(await internal.json()).toEqual({ streamUrl: STREAM });
    expect(internal.headers.get("x-relay-owner")).toBe(await ownerCapability(identity.sessionHash, body.relayId));
    expect(internal.headers.get("x-relay-session-hash")).toBe(identity.sessionHash);
    expect(rpc).toHaveBeenCalledWith("web_relay_admit", {
      p_session_hash: identity.sessionHash, p_relay_id: body.relayId, p_now: new Date(1000).toISOString(),
    }, expect.any(AbortSignal));
    const second = await startRelay(browser("/api/relay/start", { stationId: UUID }), h.env, h.lookup, control);
    expect((await second.json() as { relayId: string }).relayId).not.toBe(body.relayId);
  });

  it.each([false, new Error("injected lost admission reply")])("denies admission before DO allocation and releases uncertain leases", async result => {
    const h = bindings();
    rpc.mockImplementation(async name => {
      if (name === "web_relay_release") return true;
      if (result instanceof Error) throw result;
      return result;
    });
    const response = await startRelay(browser("/api/relay/start", { stationId: UUID }), h.env, h.lookup, control);
    expect(response.status).toBe(result === false ? 429 : 502);
    expect(h.idFromName).not.toHaveBeenCalled();
    expect(h.forwarded).not.toHaveBeenCalled();
    const admit = rpc.mock.calls[0]!;
    expect(admit[0]).toBe("web_relay_admit");
    expect(rpc.mock.calls[1]).toEqual(["web_relay_release", {
      p_session_hash: admit[1].p_session_hash, p_relay_id: admit[1].p_relay_id,
    }, expect.any(AbortSignal)]);
  });

  it.each([401, 502])("releases admission after DO init failure %s", async status => {
    const h = bindings();
    h.forwarded.mockResolvedValue(new Response(null, { status }));
    expect((await startRelay(browser("/api/relay/start", { stationId: UUID }), h.env, h.lookup, control)).status).toBe(502);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["web_relay_admit", "web_relay_release"]);
    expect(rpc.mock.calls[0]![1].p_relay_id).toBe(rpc.mock.calls[1]![1].p_relay_id);
  });

  it.each([
    { stationId: UUID, url: STREAM }, { stationId: UUID, streamUrl: STREAM },
    { stationId: STREAM }, { url: STREAM }, { stationId: UUID, unexpected: true },
    { stationId: 4 }, [UUID], null,
  ])("rejects invalid station-only body without station fetch or DO init", async body => {
    const h = bindings();
    expect((await startRelay(browser("/api/relay/start", body), h.env, h.lookup)).status).toBe(400);
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.forwarded).not.toHaveBeenCalled();
  });

  it("requires auth and exact same-origin mutation; forged identity headers do not bypass auth", async () => {
    const h = bindings();
    requireMock.mockResolvedValue(null);
    expect((await startRelay(browser("/api/relay/start", { stationId: UUID }, { "x-user-uuid": "forged" }), h.env, h.lookup)).status).toBe(401);
    for (const operation of ["audio", "events", "stop"] as const) {
      expect((await accessRelay(browser("/api/relay/" + ID, operation === "stop" ? {} : undefined), h.env, ID, operation)).status).toBe(401);
    }
    requireMock.mockResolvedValue(identity);
    for (const origin of ["https://evil.test", "null"]) {
      expect((await startRelay(browser("/api/relay/start", { stationId: UUID }, { origin }), h.env, h.lookup)).status).toBe(403);
    }
    const noOrigin = browser("/api/relay/start", { stationId: UUID });
    noOrigin.headers.delete("origin");
    expect((await startRelay(noOrigin, h.env, h.lookup)).status).toBe(403);
    expect(h.forwarded).not.toHaveBeenCalled();
  });

  it("binds audio and events to the verified session, discarding browser internal / auth headers", async () => {
    const h = bindings();
    for (const operation of ["audio", "events", "stop"] as const) {
      const request = browser("/api/relay/" + ID, operation === "stop" ? {} : undefined, {
        "x-relay-owner": "forged", "x-user-uuid": "forged", "authorization": "fixture-only",
      });
      expect((await accessRelay(request, h.env, ID, operation)).status).toBe(200);
      const forwarded = h.forwarded.mock.calls.at(-1)![0];
      expect(forwarded.headers.get("x-relay-owner")).toBe(await ownerCapability(identity.sessionHash, ID));
      expect(forwarded.headers.get("authorization")).toBeNull();
      expect(forwarded.headers.get("x-user-uuid")).toBeNull();
      expect(new URL(forwarded.url).pathname).toBe("/" + operation);
    }
    const owner = h.forwarded.mock.calls[0]![0].headers.get("x-relay-owner");
    requireMock.mockResolvedValue({ ...identity, sessionHash: "different-session-same-user" });
    await accessRelay(browser("/api/relay/" + ID), h.env, ID, "audio");
    expect(h.forwarded.mock.calls.at(-1)![0].headers.get("x-relay-owner")).not.toBe(owner);
  });

  it("composes Pages authentication with one DO: same user in another session cannot play, subscribe or stop", async () => {
    const h = harness();
    let mappedId = "";
    const core = new RelayCore({ ...h.deps, matchesId: id => id === mappedId });
    const env = {
      RELAY_HUB: {
        idFromName: (name: string) => { mappedId = name; return name; },
        get: () => ({ fetch: (request: Request) => core.fetch(request) }),
      },
    } as unknown as Env;
    const lookup = async () => Response.json([{ stationuuid: UUID, url_resolved: STREAM }]);
    const start = await startRelay(browser("/api/relay/start", { stationId: UUID }), env, lookup, control);
    const { relayId } = await start.json() as { relayId: string };
    requireMock.mockResolvedValue({ ...identity, sessionHash: "other-session" });
    for (const operation of ["audio", "events", "stop"] as const) {
      expect((await accessRelay(browser("/api/relay/" + relayId, operation === "stop" ? {} : undefined), env, relayId, operation)).status).toBe(404);
    }
    expect(h.network).not.toHaveBeenCalled();
    requireMock.mockResolvedValue(identity);
    const audio = (await accessRelay(browser("/api/relay/" + relayId), env, relayId, "audio")).body!.getReader();
    expect(h.network).toHaveBeenCalledOnce();
    await audio.cancel();
  });

  it("rejects cross-site reads, unexpected query, malformed handles and wrong methods before forwarding", async () => {
    const h = bindings();
    expect((await accessRelay(browser("/api/relay/" + ID, undefined, { "sec-fetch-site": "cross-site" }), h.env, ID, "audio")).status).toBe(403);
    expect((await accessRelay(browser("/api/relay/" + ID + "?url=" + STREAM), h.env, ID, "audio")).status).toBe(400);
    expect((await accessRelay(browser("/api/relay/" + UUID), h.env, UUID, "events")).status).toBe(400);
    expect((await accessRelay(browser("/api/relay/" + ID, {}), h.env, ID, "audio")).status).toBe(405);
    expect((await startRelay(browser("/api/relay/start"), h.env, h.lookup)).status).toBe(405);
    expect(h.forwarded).not.toHaveBeenCalled();
  });

  it("reports missing binding, oversized/malformed bodies and unsafe station without init", async () => {
    const h = bindings();
    expect((await startRelay(browser("/api/relay/start", { stationId: UUID }), {} as Env, h.lookup)).status).toBe(503);
    expect((await startRelay(browser("/api/relay/start", { stationId: "x".repeat(2000) }), h.env, h.lookup)).status).toBe(400);
    const malformed = new Request("https://page.test/api/relay/start", { method: "POST", headers: { origin: "https://page.test", "content-type": "application/json" }, body: "{" });
    expect((await startRelay(malformed, h.env, h.lookup)).status).toBe(400);
    const unsafe = async () => Response.json([{ stationuuid: UUID, url_resolved: "http://localhost/audio" }]);
    expect((await startRelay(browser("/api/relay/start", { stationId: UUID }), h.env, unsafe)).status).toBe(403);
    expect(h.forwarded).not.toHaveBeenCalled();
  });
});
