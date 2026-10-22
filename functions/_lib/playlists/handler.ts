import { json, sameOrigin } from "../auth/http";
import { accessToken, pcProtobuf } from "../auth/pocket-casts";
import type { AuthRuntime } from "../auth/runtime";
import { createSessionValidator } from "../auth/session";
import { decodePlaylistList, encodePlaylistListRequest } from "../pocket-casts/protobuf";

// Manual playlists carry their episodes, so the response can be large.
const RESPONSE_LIMIT = 4 * 1024 * 1024;

/**
 * The account's playlists, for Sidebar labels and slot availability. A playlist
 * deleted on the server is left out, so its slot counts as unavailable.
 * The request mirrors the iOS RetrievePlaylistsTask: only `m` is set.
 */
export function createPlaylistsHandler(runtime: AuthRuntime) {
  const validate = createSessionValidator(runtime);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (!sameOrigin(request, false)) return json({ error: "same_origin_required" }, 403);
    const identity = await validate(request);
    if (!identity) return json({ error: "session_required" }, 401);
    try {
      const access = await accessToken(runtime, identity.sessionHash);
      if (!access) throw new Error("Token unavailable");
      const bytes = await pcProtobuf(runtime, "user/playlist/list", encodePlaylistListRequest({ m: "mobile" }), access, RESPONSE_LIMIT);
      const playlists = decodePlaylistList(bytes)
        .filter(playlist => !playlist.deleted)
        .map(({ uuid, title }) => ({ uuid, title }));
      return json({ playlists });
    } catch {
      return json({ error: "playlists_unavailable" }, 502);
    }
  };
}
