import { json, sameOrigin } from "../auth/http";
import { createSessionValidator } from "../auth/session";
import { readJson, type AuthRuntime } from "../auth/runtime";

/** Where shared (anon-key) tables live. `null` when the server is not configured for them. */
export interface SharedDatabase { url: string; anonKey: string }

/** iOS `TabLayout.default`: four content tabs, with Profile and Up Next left to More. Dated at the epoch. */
export const IOS_DEFAULT_LAYOUT = {
  slots: ["podcasts", "playlists", "discover", "streams"],
  updated_at: "1970-01-01T00:00:00.000Z",
} as const;

// ADR 0002: shared tables are read with the anon key and a server-set x-user-uuid.
// The uuid comes only from the verified session, never from the request.
export function createLayoutHandler(runtime: AuthRuntime, db: SharedDatabase | null) {
  const validate = createSessionValidator(runtime);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (!sameOrigin(request, false)) return json({ error: "same_origin_required" }, 403);
    const identity = await validate(request);
    if (!identity) return json({ error: "session_required" }, 401);
    if (!db) return json({ error: "layout_unavailable" }, 503);
    try {
      const url = new URL("/rest/v1/nav_layout", db.url);
      url.searchParams.set("select", "slots,updated_at");
      url.searchParams.set("user_uuid", `eq.${identity.userUuid}`);
      const response = await runtime.fetch(url.href, {
        method: "GET",
        headers: {
          apikey: db.anonKey, Authorization: `Bearer ${db.anonKey}`,
          "x-user-uuid": identity.userUuid, Accept: "application/json",
        },
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Layout unavailable"); }
      const rows = await readJson(response, 65_536);
      if (!Array.isArray(rows)) throw new Error("Invalid layout");
      if (rows.length === 0) return json({ slots: [...IOS_DEFAULT_LAYOUT.slots], updated_at: IOS_DEFAULT_LAYOUT.updated_at });
      const row = rows[0] as Record<string, unknown> | null;
      if (!row || typeof row !== "object" || !Array.isArray(row.slots) ||
          !row.slots.every(slot => typeof slot === "string") || typeof row.updated_at !== "string") {
        throw new Error("Invalid layout row");
      }
      return json({ slots: row.slots, updated_at: row.updated_at });
    } catch {
      return json({ error: "layout_unavailable" }, 502);
    }
  };
}

export function sharedDatabase(env: { SUPABASE_URL: string; SUPABASE_ANON_KEY?: string }): SharedDatabase | null {
  if (!env.SUPABASE_ANON_KEY) return null;
  try {
    const url = new URL(env.SUPABASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return { url: url.origin, anonKey: env.SUPABASE_ANON_KEY };
  } catch { return null; }
}
