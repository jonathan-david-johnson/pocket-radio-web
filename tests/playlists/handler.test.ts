import { describe, expect, it } from "vitest";
import { createPlaylistsHandler } from "../../functions/_lib/playlists/handler";
import { harness, request } from "../auth/harness";

const utf8 = (s: string) => [...new TextEncoder().encode(s)];
const field = (n: number, body: number[]) => [(n << 3) | 2, body.length, ...body];
const playlist = (uuid: string, title: string, deleted?: boolean) =>
  field(1, [...field(1, utf8(uuid)), ...(deleted === undefined ? [] : field(2, deleted ? [0x08, 0x01] : [])), ...field(3, utf8(title))]);
const NEWS = "2f8e1c4a-6b1d-4c1e-9a77-3f0c2d1e4b5a";
const TECH = "7c3d9e10-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const GONE = "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
const protobuf = (bytes: number[], status = 200, type = "application/octet-stream") =>
  new Response(new Uint8Array(bytes), { status, headers: { "Content-Type": type } });

describe("GET /api/playlists", () => {
  it("returns the account's playlists in server order without deleted ones, read in protobuf", async () => {
    const h = harness();
    h.fetch(async () => protobuf([...playlist(TECH, "Tech"), ...playlist(GONE, "Old secret list", true), ...playlist(NEWS, "News", false)]));
    const result = await createPlaylistsHandler(h.runtime)(request("playlists"));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ playlists: [{ uuid: TECH, title: "Tech" }, { uuid: NEWS, title: "News" }] });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(h.fetchCalls).toHaveLength(1);
    const call = h.fetchCalls[0]!;
    expect(call.url).toBe("https://api.pocketcasts.com/user/playlist/list");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.headers).toMatchObject({
      "Content-Type": "application/octet-stream", Accept: "application/octet-stream", Authorization: "Bearer fixture-access",
    });
    expect([...new Uint8Array(call.init?.body as Uint8Array)]).toEqual([0x12, 0x06, ...utf8("mobile")]);
  });

  it("returns an empty list when the account has no playlists", async () => {
    const h = harness(); h.fetch(async () => protobuf([]));
    const result = await createPlaylistsHandler(h.runtime)(request("playlists"));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ playlists: [] });
  });

  it("returns 401 without a session cookie and touches neither the token store nor Pocket Casts", async () => {
    const h = harness();
    const bare = new Request("https://radio.test/api/playlists", { headers: { Origin: "https://radio.test" } });
    expect((await createPlaylistsHandler(h.runtime)(bare)).status).toBe(401);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.rpcCalls).toHaveLength(0);
  });

  it("returns 401 for a revoked or expired session", async () => {
    const h = harness(); h.rpc(async () => null);
    expect((await createPlaylistsHandler(h.runtime)(request("playlists"))).status).toBe(401);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("reports 502 without calling Pocket Casts when no access token is available", async () => {
    const h = harness();
    h.rpc(async name => (name === "web_session_roll" ? { user_uuid: "11111111-1111-4111-8111-111111111111" } : null));
    expect((await createPlaylistsHandler(h.runtime)(request("playlists"))).status).toBe(502);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it.each([
    ["an upstream error status", () => protobuf(utf8("secret upstream text"), 500)],
    ["an upstream 401", () => protobuf(utf8("secret upstream text"), 401)],
    ["a JSON body", () => new Response(JSON.stringify({ playlists: [] }), { headers: { "Content-Type": "application/json" } })],
    ["malformed protobuf", () => protobuf([0x0a, 0x05, 0x0a])],
    ["a body over the size limit", () => protobuf(new Array(4 * 1024 * 1024 + 1).fill(0))],
  ])("reports 502 without upstream details for %s", async (_name, upstream) => {
    const h = harness(); h.fetch(async () => upstream());
    const result = await createPlaylistsHandler(h.runtime)(request("playlists"));
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: "playlists_unavailable" });
  });

  it("allows only same-origin GET", async () => {
    const h = harness(); h.fetch(async () => protobuf([]));
    expect((await createPlaylistsHandler(h.runtime)(request("playlists", "POST"))).status).toBe(405);
    expect((await createPlaylistsHandler(h.runtime)(request("playlists", "GET", { headers: { Origin: "https://evil.test" } }))).status).toBe(403);
    expect(h.fetchCalls).toHaveLength(0);
  });
});
