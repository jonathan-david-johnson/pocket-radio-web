import { describe, expect, it } from "vitest";
import { DirectStreamError, directStreamUrl } from "../../shared/direct-playback";
import { createPlaybackHandler } from "../../functions/_lib/playback/routes";
import { harness, request, response } from "../auth/harness";

const STATION = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const STREAM = "https://stream.example.org/live.mp3";
const path = `playback?stationId=${STATION}`;

describe("direct URL policy", () => {
  it("keeps a canonical public-looking HTTPS URL, including its public station query", () => {
    expect(directStreamUrl("https://STREAM.example.org:443/live.mp3?channel=1")).toBe("https://stream.example.org/live.mp3?channel=1");
  });
  it("reports HTTP-only without silently changing the scheme", () => {
    try { directStreamUrl("http://stream.example.org/live"); throw new Error("Expected rejection"); }
    catch (error) { expect(error instanceof DirectStreamError && error.code).toBe("https_required"); }
  });
  it.each([undefined, "", "//stream.example.org/live", "javascript:alert(1)", "data:audio/mpeg;base64,AAAA",
    "https://user:pass@stream.example.org/live", "https://stream.example.org:8443/live", "https://stream.example.org/live#fragment",
    "https://127.0.0.1/live", "https://2130706433/live", "https://10.1.1.1/live", "https://[::1]/live", "https://[2001:db8::1]/live",
    "https://stream.example.org/\\\\hidden", "https://localhost/live", "https://radio.local/live", "https://radio.internal/live", "https://radio.test/live", "https://host/live",
    "https://stream.example.org./live", "https://stream.example.org/ bad", "https://stream.example.org/\nprivate", "https://" + "x".repeat(64) + ".org/live",
  ])("rejects unsafe station address %s", value => { expect(() => directStreamUrl(value)).toThrow(); });
});

describe("authenticated station resolution", () => {
  it("returns only a station ID and HTTPS URL, without opening audio or forwarding credentials", async () => {
    const h = harness(); h.fetch(async () => response([{ stationuuid: STATION, url_resolved: STREAM, email: "private", token: "private" }]));
    const result = await createPlaybackHandler(h.runtime)(request(path));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ stationId: STATION, streamUrl: STREAM });
    expect(h.fetchCalls).toHaveLength(1);
    const lookup = h.fetchCalls[0]!;
    expect(lookup.url).toBe("https://de1.api.radio-browser.info/json/stations/byuuid/" + STATION);
    expect(lookup.init?.redirect).toBe("manual");
    expect(lookup.init?.headers).toEqual({ Accept: "application/json", "User-Agent": "PocketRadio-Web/0.1" });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
  it("does not query radio-browser for missing or revoked sessions", async () => {
    const h = harness(); h.rpc(async () => null);
    expect((await createPlaybackHandler(h.runtime)(request(path))).status).toBe(401);
    expect(h.fetchCalls).toHaveLength(0);
  });
  it.each(["playback", path + "&url=https://evil.example.org", path + "&stationId=" + STATION,
    "playback?stationId=https://evil.example.org", "playback?stationId=bad"])("rejects arbitrary or duplicate input %s before storage/network", async query => {
    const h = harness();
    expect((await createPlaybackHandler(h.runtime)(request(query))).status).toBe(400);
    expect(h.rpcCalls).toHaveLength(0); expect(h.fetchCalls).toHaveLength(0);
  });
  it("rejects cross-origin and unsupported methods without network", async () => {
    const h = harness(); const handler = createPlaybackHandler(h.runtime);
    expect((await handler(request(path, "POST"))).status).toBe(405);
    expect((await handler(request(path, "GET", { headers: { Origin: "https://evil.example.org" } }))).status).toBe(403);
    const missing = request(path); missing.headers.delete("Origin");
    expect((await handler(missing)).status).toBe(403);
    expect(h.rpcCalls).toHaveLength(0); expect(h.fetchCalls).toHaveLength(0);
  });
  it.each(["http://stream.example.org/live", "https://127.0.0.1/live", "https://user:pass@stream.example.org/live"])("rejects unsupported stream %s without fetching it", async stream => {
    const h = harness(); h.fetch(async () => response([{ stationuuid: STATION, url_resolved: stream }]));
    const result = await createPlaybackHandler(h.runtime)(request(path));
    expect(result.status).toBe(422);
    expect(h.fetchCalls).toHaveLength(1);
    expect(JSON.stringify(await result.json())).not.toContain(stream);
  });
  it.each([{ rows: [] }, { rows: [{ stationuuid: OTHER, url_resolved: STREAM }] }])("does not accept mismatched or missing station records", async ({ rows }) => {
    const h = harness(); h.fetch(async () => response(rows));
    expect((await createPlaybackHandler(h.runtime)(request(path))).status).toBe(404);
  });
  it("uses url only when url_resolved is absent, never an HTTPS guess for a resolved HTTP URL", async () => {
    const h = harness(); h.fetch(async () => response([{ stationuuid: STATION, url: STREAM }]));
    expect(await (await createPlaybackHandler(h.runtime)(request(path))).json()).toEqual({ stationId: STATION, streamUrl: STREAM });
    h.fetch(async () => response([{ stationuuid: STATION, url: STREAM, url_resolved: "http://stream.example.org/live" }]));
    expect((await createPlaybackHandler(h.runtime)(request(path))).status).toBe(422);
  });
  it.each([302, 500])("rejects lookup HTTP %s rather than following it", async status => {
    const h = harness(); h.fetch(async () => response({ private: "detail" }, status));
    const result = await createPlaybackHandler(h.runtime)(request(path));
    expect(result.status).toBe(502); expect(await result.json()).toEqual({ error: "station_lookup_unavailable" });
    expect(h.fetchCalls).toHaveLength(1);
  });
  it("bounds lookup body size and redacts storage/network failures", async () => {
    const h = harness(); h.fetch(async () => response([{ stationuuid: STATION, url_resolved: STREAM, junk: "x".repeat(70_000) }]));
    expect((await createPlaybackHandler(h.runtime)(request(path))).status).toBe(502);
    h.rpc(async () => { throw new Error("private storage error"); });
    expect((await createPlaybackHandler(h.runtime)(request(path))).status).toBe(401);
  });
});
