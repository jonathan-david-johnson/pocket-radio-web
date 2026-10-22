import { json, sameOrigin } from "../auth/http";
import { createSessionValidator } from "../auth/session";
import { readJson, type AuthRuntime } from "../auth/runtime";
import type { SharedDatabase } from "../layout/handler";

export interface CuratedStation {
  id: string;
  name: string;
  description: string;
  /** An iOS asset catalog name, not a URL. */
  logo_asset: string;
  tracklist_url: string | null;
  /** radio-browser station UUIDs for the station's streams. */
  radio_browser_uuids: string[];
  default_seed_uuid: string;
  seed_as_favorite: boolean;
}

const COLUMNS = ["id", "name", "description", "logo_asset", "tracklist_url", "radio_browser_uuids", "default_seed_uuid", "seed_as_favorite"] as const;

// The rows are public and the same for every user, so no x-user-uuid is sent.
// A session is still required, so a signed-out request never reaches the database.
export function createCuratedStationsHandler(runtime: AuthRuntime, db: SharedDatabase | null) {
  const validate = createSessionValidator(runtime);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (!sameOrigin(request, false)) return json({ error: "same_origin_required" }, 403);
    if (!await validate(request)) return json({ error: "session_required" }, 401);
    if (!db) return json({ error: "stations_unavailable" }, 503);
    try {
      const url = new URL("/rest/v1/curated_stations", db.url);
      url.searchParams.set("select", COLUMNS.join(","));
      url.searchParams.set("order", "position.asc");
      const response = await runtime.fetch(url.href, {
        method: "GET",
        headers: { apikey: db.anonKey, Authorization: `Bearer ${db.anonKey}`, Accept: "application/json" },
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Stations unavailable"); }
      const rows = await readJson(response, 65_536);
      if (!Array.isArray(rows)) throw new Error("Invalid stations");
      return json({ stations: rows.map(toStation) });
    } catch {
      return json({ error: "stations_unavailable" }, 502);
    }
  };
}

function toStation(value: unknown): CuratedStation {
  const row = value as Record<string, unknown> | null;
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!row || typeof row !== "object" ||
      !text(row.id) || !text(row.name) || typeof row.description !== "string" || !text(row.logo_asset) ||
      !(row.tracklist_url === null || (text(row.tracklist_url) && row.tracklist_url.startsWith("https://"))) ||
      !Array.isArray(row.radio_browser_uuids) || row.radio_browser_uuids.length === 0 || !row.radio_browser_uuids.every(text) ||
      !text(row.default_seed_uuid) || typeof row.seed_as_favorite !== "boolean") {
    throw new Error("Invalid station row");
  }
  return {
    id: row.id, name: row.name, description: row.description, logo_asset: row.logo_asset,
    tracklist_url: row.tracklist_url, radio_browser_uuids: row.radio_browser_uuids,
    default_seed_uuid: row.default_seed_uuid, seed_as_favorite: row.seed_as_favorite,
  };
}
