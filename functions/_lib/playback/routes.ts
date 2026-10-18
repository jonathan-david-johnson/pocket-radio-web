import { DirectStreamError, directStreamUrl, STATION_ID } from "../../../shared/direct-playback";
import { json, sameOrigin } from "../auth/http";
import { createSessionValidator } from "../auth/session";
import { readJson, type AuthRuntime } from "../auth/runtime";

const LOOKUP = "https://de1.api.radio-browser.info/json/stations/byuuid/";
// Resolves metadata only. Never fetches, HEADs or follows redirects to an audio URL.
export function createPlaybackHandler(runtime: AuthRuntime) {
  const validate = createSessionValidator(runtime);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (!sameOrigin(request, true)) return json({ error: "same_origin_required" }, 403);
    const params = new URL(request.url).searchParams;
    const stationId = params.get("stationId")?.toLowerCase();
    if (!stationId || !STATION_ID.test(stationId) || params.getAll("stationId").length !== 1 ||
        [...params.keys()].some(key => key !== "stationId")) return json({ error: "station_id_required" }, 400);
    try {
      if (!await validate(request)) return json({ error: "session_required" }, 401);
      const response = await runtime.fetch(LOOKUP + stationId, {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(8_000),
        headers: { Accept: "application/json", "User-Agent": "PocketRadio-Web/0.1" },
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Lookup unavailable"); }
      const rows: unknown = await readJson(response, 65_536);
      if (!Array.isArray(rows)) throw new Error("Invalid lookup");
      const row = rows.find((item: unknown) => item !== null && typeof item === "object" &&
        typeof (item as Record<string, unknown>).stationuuid === "string" &&
        String((item as Record<string, unknown>).stationuuid).toLowerCase() === stationId) as Record<string, unknown> | undefined;
      if (!row) return json({ error: "station_not_found" }, 404);
      const stream = typeof row.url_resolved === "string" && row.url_resolved ? row.url_resolved : row.url;
      return json({ stationId, streamUrl: directStreamUrl(stream) });
    } catch (error) {
      if (error instanceof DirectStreamError) return json({ error: error.code }, 422);
      return json({ error: "station_lookup_unavailable" }, 502);
    }
  };
}
