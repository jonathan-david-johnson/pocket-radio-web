import { describe, expect, it, vi } from "vitest";
import { fetchStationStream, safeStreamUrl } from "../../functions/_lib/relay/security";
import { resolveStation } from "../../functions/_lib/relay/stations";
import { STREAM, UUID } from "./harness";

describe("fail-closed station resolution", () => {
  it.each([
    "file:///tmp/stream", "ftp://ice1.somafm.com/a", "data:audio/mpeg,evil",
    "http://localhost/a", "http://127.0.0.1/a", "http://127.1/a",
    "http://2130706433/a", "http://0x7f000001/a", "http://0.0.0.0/a",
    "http://10.0.0.1/a", "http://172.16.0.1/a", "http://192.168.0.1/a",
    "http://169.254.169.254/a", "http://[::1]/a", "http://[::ffff:127.0.0.1]/a",
    "http://[fc00::1]/a", "http://[fe80::1]/a", "http://localhost.localdomain/a",
    "http://ice1.somafm.com:8080/a", "http://user:password@ice1.somafm.com/a",
    "http://ice1.somafm.com.evil.test/a", "http://ice1.somafm.com./a",
    "http://evil.test/a", "https://ice1.somafm.com/a#fragment",
  ])("rejects unsafe or unapproved server-resolved URL %s", url => {
    expect(() => safeStreamUrl(url)).toThrow();
  });

  it("allows only exact trusted stream hosts, HTTP/S and default ports", () => {
    expect(safeStreamUrl(STREAM).href).toBe(STREAM);
    expect(safeStreamUrl("https://ice2.somafm.com:443/a").port).toBe("");
  });

  it("rejects raw URL / curated name before doing any lookup", async () => {
    const network = vi.fn();
    for (const id of [STREAM, "kcrw", UUID + "?url=http://localhost"]) {
      await expect(resolveStation(id, network)).rejects.toMatchObject({ status: 400, code: "station_uuid_required" });
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("looks up the actual UUID array schema, uses url_resolved and validates it", async () => {
    const network = vi.fn(async () => Response.json([
      { stationuuid: UUID, url: "http://localhost/ignored", url_resolved: STREAM },
    ]));
    expect(await resolveStation(UUID.toUpperCase(), network)).toBe(STREAM);
    expect(network.mock.calls[0]).toEqual([
      "https://de1.api.radio-browser.info/json/stations/byuuid/" + UUID,
      expect.objectContaining({ redirect: "manual" }),
    ]);
    const fallback = async () => Response.json([{ stationuuid: UUID, url: STREAM, url_resolved: "" }]);
    expect(await resolveStation(UUID, fallback)).toBe(STREAM);
  });

  it("fails closed on mismatch, unsafe database URL, missing station and oversized lookup", async () => {
    await expect(resolveStation(UUID, async () => Response.json([{ stationuuid: "different", url: STREAM }])))
      .rejects.toMatchObject({ status: 502, code: "station_lookup_mismatch" });
    await expect(resolveStation(UUID, async () => Response.json([{ stationuuid: UUID, url_resolved: "http://10.0.0.1" }])))
      .rejects.toMatchObject({ status: 403, code: "station_upstream_not_approved" });
    await expect(resolveStation(UUID, async () => Response.json([]))).rejects.toMatchObject({ status: 404 });
    const canceled = vi.fn();
    await expect(resolveStation(UUID, async () => new Response(new ReadableStream({
      start: controller => controller.enqueue(new Uint8Array(65537)), cancel: canceled,
    })))).rejects.toMatchObject({ code: "station_lookup_too_large" });
    expect(canceled).toHaveBeenCalledOnce();
  });

  it("revalidates every redirect before fetching it and cancels discarded response", async () => {
    const canceled = vi.fn();
    const network = vi.fn(async () => new Response(new ReadableStream({ cancel: canceled }), {
      status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" },
    }));
    await expect(fetchStationStream(STREAM, network, new AbortController().signal)).rejects.toThrow();
    expect(network).toHaveBeenCalledOnce();
    expect(canceled).toHaveBeenCalledOnce();
  });

  it("allows bounded trusted redirects with ICY headers on each hop, blocks redirect loops", async () => {
    const network = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://ice2.somafm.com/a" } }))
      .mockResolvedValueOnce(new Response("audio"));
    const response = await fetchStationStream(STREAM, network, new AbortController().signal);
    expect(await response.text()).toBe("audio");
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[1]).toEqual([
      "https://ice2.somafm.com/a", expect.objectContaining({ redirect: "manual", headers: expect.objectContaining({ "Icy-MetaData": "1" }) }),
    ]);
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: STREAM } }));
    await expect(fetchStationStream(STREAM, loop, new AbortController().signal)).rejects.toThrow("Invalid station redirect");
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it("never fetches unsafe initial URLs and rejects upstream errors / compression", async () => {
    const network = vi.fn();
    await expect(fetchStationStream("http://localhost", network, new AbortController().signal)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    for (const response of [
      new Response("bad", { status: 500 }),
      new Response("bad", { headers: { "content-encoding": "gzip" } }),
    ]) {
      await expect(fetchStationStream(STREAM, async () => response, new AbortController().signal)).rejects.toThrow();
    }
  });
});
