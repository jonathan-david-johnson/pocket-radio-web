import { describe, expect, it } from "vitest";
import { createCuratedStationsHandler } from "../../functions/_lib/stations/curated";
import { harness, OTHER, request, response } from "../auth/harness";

const DB = { url: "https://db.example.test", anonKey: "fixture-anon-key" };
const KEXP = {
  id: "kexp", name: "KEXP", description: "Where the music matters", logo_asset: "kexp_logo",
  tracklist_url: "https://api.kexp.org/v2/plays/?limit=10",
  radio_browser_uuids: ["445cbb3a-1c4e-49aa-a268-f5b6acfa8f2e", "399ca326-0f67-4015-a51b-d7ba2bd4ebbe"],
  default_seed_uuid: "445cbb3a-1c4e-49aa-a268-f5b6acfa8f2e", seed_as_favorite: true,
};
const NPR = {
  id: "npr_hourly", name: "NPR Hourly Newscast", description: "Live news updates every hour", logo_asset: "npr_logo",
  tracklist_url: null, radio_browser_uuids: ["a5314180-7573-4b46-aafc-51ed2d5b9e71"],
  default_seed_uuid: "a5314180-7573-4b46-aafc-51ed2d5b9e71", seed_as_favorite: true,
};

describe("GET /api/stations/curated", () => {
  it("returns the seeded rows in display order, read with the anon key and no user id", async () => {
    const h = harness(); h.fetch(async () => response([KEXP, NPR]));
    const result = await createCuratedStationsHandler(h.runtime, DB)(request("stations/curated", "GET", { headers: { "x-user-uuid": OTHER } }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ stations: [KEXP, NPR] });
    expect(h.fetchCalls).toHaveLength(1);
    const call = h.fetchCalls[0]!;
    expect(call.url).toBe(`${DB.url}/rest/v1/curated_stations?select=id%2Cname%2Cdescription%2Clogo_asset%2Ctracklist_url%2Cradio_browser_uuids%2Cdefault_seed_uuid%2Cseed_as_favorite&order=position.asc`);
    expect(call.init?.method).toBe("GET");
    expect(call.init?.headers).toMatchObject({ apikey: DB.anonKey, Authorization: `Bearer ${DB.anonKey}` });
    // The rows are the same for everyone, so the user's id is not sent at all.
    expect(Object.keys(call.init?.headers ?? {}).map(k => k.toLowerCase())).not.toContain("x-user-uuid");
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns an empty list when there are no rows", async () => {
    const h = harness(); h.fetch(async () => response([]));
    const result = await createCuratedStationsHandler(h.runtime, DB)(request("stations/curated"));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ stations: [] });
  });

  it("returns 401 without a session cookie and does not touch the database", async () => {
    const h = harness();
    const bare = new Request("https://radio.test/api/stations/curated", { headers: { Origin: "https://radio.test" } });
    expect((await createCuratedStationsHandler(h.runtime, DB)(bare)).status).toBe(401);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("returns 401 for a revoked or expired session and does not touch the database", async () => {
    const h = harness(); h.rpc(async () => null);
    expect((await createCuratedStationsHandler(h.runtime, DB)(request("stations/curated"))).status).toBe(401);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it.each([
    ["not an array", { stations: [KEXP] }],
    ["a missing name", [{ ...KEXP, name: undefined }]],
    ["a non-string stream id", [{ ...KEXP, radio_browser_uuids: [7] }]],
    ["no stream ids", [{ ...KEXP, radio_browser_uuids: [] }]],
    ["a non-HTTPS tracklist URL", [{ ...KEXP, tracklist_url: "http://api.kexp.org/" }]],
    ["a non-boolean favorite flag", [{ ...KEXP, seed_as_favorite: "yes" }]],
  ])("reports 502, not the data, when the response has %s", async (_name, body) => {
    const h = harness(); h.fetch(async () => response(body));
    const result = await createCuratedStationsHandler(h.runtime, DB)(request("stations/curated"));
    expect(result.status).toBe(502);
    expect(JSON.stringify(await result.json())).not.toContain("kexp");
  });

  it("reports 502 without leaking upstream details when the database fails", async () => {
    const h = harness(); h.fetch(async () => new Response("secret upstream text", { status: 500 }));
    const result = await createCuratedStationsHandler(h.runtime, DB)(request("stations/curated"));
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("secret");
  });

  it("reports 503 when the database is not configured", async () => {
    const h = harness();
    expect((await createCuratedStationsHandler(h.runtime, null)(request("stations/curated"))).status).toBe(503);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("allows only same-origin GET", async () => {
    const h = harness(); h.fetch(async () => response([]));
    expect((await createCuratedStationsHandler(h.runtime, DB)(request("stations/curated", "POST"))).status).toBe(405);
    expect((await createCuratedStationsHandler(h.runtime, DB)(request("stations/curated", "GET", { headers: { Origin: "https://evil.test" } }))).status).toBe(403);
    expect(h.fetchCalls).toHaveLength(0);
  });
});
