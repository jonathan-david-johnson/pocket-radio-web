import { playlistUuid, type CoreDestination, type DestinationId } from "../nav/render";

/** Tab items the phone renders, counting More. Web ADR 0005: follow the iPhone exactly. */
export const TAB_CAPACITY = 5;

const CORE: Record<CoreDestination, { label: string; path: string }> = {
  podcasts: { label: "Podcasts", path: "/podcasts" },
  playlists: { label: "Playlists", path: "/playlists" },
  discover: { label: "Discover", path: "/discover" },
  streams: { label: "Streams", path: "/streams" },
  profile: { label: "Profile", path: "/profile" },
  upNext: { label: "Up Next", path: "/up-next" },
};

/** Playlist names by UUID, or `null` before they have loaded. */
export type PlaylistNames = ReadonlyMap<string, string> | null;

export const MORE_PATH = "/more";

export function pathFor(id: DestinationId): string {
  const uuid = playlistUuid(id);
  return uuid === null ? CORE[id as CoreDestination].path : `/playlist/${encodeURIComponent(uuid)}`;
}

export function coreLabel(id: CoreDestination): string {
  return CORE[id].label;
}

export function labelFor(id: DestinationId, playlists: PlaylistNames): string {
  const uuid = playlistUuid(id);
  if (uuid === null) return CORE[id as CoreDestination].label;
  return playlists?.get(uuid) || "Playlist";
}

/** Before playlists load, every playlist slot is assumed to exist. */
export function isPlaylistAvailable(playlists: PlaylistNames, uuid: string): boolean {
  return playlists === null || playlists.has(uuid);
}
