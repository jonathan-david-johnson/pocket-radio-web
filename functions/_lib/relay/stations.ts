import { safeStreamUrl, STATION_UUID, type NetworkFetch } from "./security";

export class StationError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

// Actual radio-browser schema: /json/stations/byuuid/:uuid returns an array
// containing stationuuid, url and url_resolved. Cross-platform reference:
// pocket-radio-menubar/PocketRadio/Services/APIService.swift lookupStation(uuid:).
// curated_stations is not created yet: do not invent its future SQL columns.
export async function resolveStation(stationId: string, network: NetworkFetch): Promise<string> {
  if (!STATION_UUID.test(stationId)) throw new StationError(400, "station_uuid_required");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 8_000);
  try {
    const response = await network(
      "https://de1.api.radio-browser.info/json/stations/byuuid/" + stationId.toLowerCase(),
      { redirect: "manual", signal: abort.signal, headers: { "User-Agent": "PocketRadio-Web/0.1" } },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new StationError(502, "station_lookup_failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 64 * 1024) throw new StationError(502, "station_lookup_too_large");
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    const rows: unknown = JSON.parse(new TextDecoder().decode(data));
    if (!Array.isArray(rows) || rows.length === 0) throw new StationError(404, "station_not_found");
    const row = rows.find((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      return (item as Record<string, unknown>).stationuuid === stationId.toLowerCase();
    }) as Record<string, unknown> | undefined;
    if (!row) throw new StationError(502, "station_lookup_mismatch");
    const upstream = typeof row.url_resolved === "string" && row.url_resolved
      ? row.url_resolved : row.url;
    if (typeof upstream !== "string") throw new StationError(502, "station_url_missing");
    try { return safeStreamUrl(upstream).href; }
    catch { throw new StationError(403, "station_upstream_not_approved"); }
  } catch (error) {
    if (error instanceof StationError) throw error;
    throw new StationError(502, "station_lookup_failed");
  } finally { clearTimeout(timeout); }
}
