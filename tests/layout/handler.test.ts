import { describe, expect, it } from "vitest";
import { createLayoutHandler, IOS_DEFAULT_LAYOUT, sharedDatabase } from "../../functions/_lib/layout/handler";
import { harness, OTHER, request, response, USER } from "../auth/harness";

const DB = { url: "https://db.example.test", anonKey: "fixture-anon-key" };
const STORED = { slots: ["podcasts", "playlist:33333333-3333-4333-8333-333333333333", "streams"], updated_at: "2026-10-01T12:00:00+00:00" };

describe("GET /api/layout", () => {
  it("returns the stored row for the session's user, read with the anon key and a server-set x-user-uuid", async () => {
    const h = harness(); h.fetch(async () => response([STORED]));
    // A client-supplied x-user-uuid must never reach the database.
    const result = await createLayoutHandler(h.runtime, DB)(request("layout", "GET", { headers: { "x-user-uuid": OTHER } }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ slots: STORED.slots, updated_at: STORED.updated_at });
    expect(h.fetchCalls).toHaveLength(1);
    const call = h.fetchCalls[0]!;
    expect(call.url).toBe(`${DB.url}/rest/v1/nav_layout?select=slots%2Cupdated_at&user_uuid=eq.${USER}`);
    expect(call.init?.method).toBe("GET");
    expect(call.init?.headers).toMatchObject({ apikey: DB.anonKey, Authorization: `Bearer ${DB.anonKey}`, "x-user-uuid": USER });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns the iOS default Layout, dated at the epoch, when the user has no row", async () => {
    const h = harness(); h.fetch(async () => response([]));
    const result = await createLayoutHandler(h.runtime, DB)(request("layout"));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ slots: ["podcasts", "playlists", "discover", "streams"], updated_at: "1970-01-01T00:00:00.000Z" });
    expect(IOS_DEFAULT_LAYOUT.slots).toEqual(["podcasts", "playlists", "discover", "streams"]);
  });

  it("returns 401 without a session cookie and does not touch the database", async () => {
    const h = harness();
    const bare = new Request("https://radio.test/api/layout", { headers: { Origin: "https://radio.test" } });
    expect((await createLayoutHandler(h.runtime, DB)(bare)).status).toBe(401);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("returns 401 for a revoked or expired session and does not touch the database", async () => {
    const h = harness(); h.rpc(async () => null);
    expect((await createLayoutHandler(h.runtime, DB)(request("layout"))).status).toBe(401);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it.each([
    ["not an array", { slots: "podcasts", updated_at: STORED.updated_at }],
    ["a non-string slot", { slots: ["podcasts", 7], updated_at: STORED.updated_at }],
    ["a missing date", { slots: ["podcasts"] }],
  ])("reports 502, not the data, when the stored row has %s", async (_name, row) => {
    const h = harness(); h.fetch(async () => response([row]));
    const result = await createLayoutHandler(h.runtime, DB)(request("layout"));
    expect(result.status).toBe(502);
    expect(JSON.stringify(await result.json())).not.toContain("podcasts");
  });

  it("reports 502 without leaking upstream details when the database fails", async () => {
    const h = harness(); h.fetch(async () => new Response("secret upstream text", { status: 500 }));
    const result = await createLayoutHandler(h.runtime, DB)(request("layout"));
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("secret");
  });

  it("reports 503 when the database is not configured", async () => {
    const h = harness();
    expect((await createLayoutHandler(h.runtime, null)(request("layout"))).status).toBe(503);
    expect(h.fetchCalls).toHaveLength(0);
  });

  it("allows only same-origin GET", async () => {
    const h = harness(); h.fetch(async () => response([]));
    expect((await createLayoutHandler(h.runtime, DB)(request("layout", "POST"))).status).toBe(405);
    expect((await createLayoutHandler(h.runtime, DB)(request("layout", "GET", { headers: { Origin: "https://evil.test" } }))).status).toBe(403);
    expect(h.fetchCalls).toHaveLength(0);
  });
});

describe("sharedDatabase", () => {
  it("needs the anon key and a plain HTTPS database origin", () => {
    expect(sharedDatabase({ SUPABASE_URL: "https://db.example.test/", SUPABASE_ANON_KEY: "k" })).toEqual({ url: "https://db.example.test", anonKey: "k" });
    expect(sharedDatabase({ SUPABASE_URL: "https://db.example.test/" })).toBeNull();
    expect(sharedDatabase({ SUPABASE_URL: "http://db.example.test/", SUPABASE_ANON_KEY: "k" })).toBeNull();
    expect(sharedDatabase({ SUPABASE_URL: "https://u:p@db.example.test/", SUPABASE_ANON_KEY: "k" })).toBeNull();
    expect(sharedDatabase({ SUPABASE_URL: "not a url", SUPABASE_ANON_KEY: "k" })).toBeNull();
  });

  it("reads from the shared database when one is configured, never mixing in the session database's key", () => {
    const shared = { SHARED_SUPABASE_URL: "https://main.example.test/", SHARED_SUPABASE_ANON_KEY: "main-key" };
    expect(sharedDatabase({ SUPABASE_URL: "https://db.example.test/", SUPABASE_ANON_KEY: "staging-key", ...shared }))
      .toEqual({ url: "https://main.example.test", anonKey: "main-key" });
    // A shared URL without its own key is a misconfiguration, not a reason to send the other key.
    expect(sharedDatabase({ SUPABASE_URL: "https://db.example.test/", SUPABASE_ANON_KEY: "staging-key", SHARED_SUPABASE_URL: "https://main.example.test/" })).toBeNull();
    expect(sharedDatabase({ SUPABASE_URL: "https://db.example.test/", SHARED_SUPABASE_ANON_KEY: "main-key" })).toBeNull();
    expect(sharedDatabase({ SUPABASE_URL: "https://db.example.test/", ...shared, SHARED_SUPABASE_URL: "http://main.example.test/" })).toBeNull();
  });
});
