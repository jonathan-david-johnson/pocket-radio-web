import { useCallback, useEffect, useRef, useState } from "react";
import { api, record } from "../experiment-api";
import { playlistUuid } from "../nav/render";
import type { PlaylistNames } from "./destinations";

/** Each load is a Pocket Casts call, so focus reloads are spaced out. */
export const PLAYLIST_REFRESH_MS = 30_000;

function parse(data: unknown): Map<string, string> {
  const list = record(data).playlists;
  if (!Array.isArray(list)) throw new Error("Invalid playlists");
  return new Map(list.map(item => {
    const row = record(item);
    if (typeof row.uuid !== "string" || typeof row.title !== "string") throw new Error("Invalid playlist");
    return [row.uuid, row.title];
  }));
}

/**
 * The account's playlist names by UUID, or `null` until the first load succeeds.
 * Loads on mount; on focus or visibility at most every PLAYLIST_REFRESH_MS; and at
 * once, a single time per set, when the Layout names playlists the list lacks.
 * A failed load keeps the last names.
 */
export function usePlaylists(slots: string[] | null): PlaylistNames {
  const [names, setNames] = useState<PlaylistNames>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const lastLoad = useRef(Number.NEGATIVE_INFINITY);
  const triedMissing = useRef("");

  const load = useCallback((): boolean => {
    if (inFlight.current) return false;
    inFlight.current = true;
    lastLoad.current = Date.now();
    void api("/api/playlists")
      .then(({ data }) => { const next = parse(data); if (alive.current) setNames(next); })
      .catch(() => { /* keep the last names */ })
      .finally(() => { inFlight.current = false; });
    return true;
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const stale = () => { if (Date.now() - lastLoad.current >= PLAYLIST_REFRESH_MS) load(); };
    const onVisibility = () => { if (document.visibilityState !== "hidden") stale(); };
    window.addEventListener("focus", stale);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", stale);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  useEffect(() => {
    if (names === null || slots === null) return;
    const missing = [...new Set(slots.map(playlistUuid).filter((uuid): uuid is string => uuid !== null && !names.has(uuid)))]
      .sort().join(",");
    if (missing && missing !== triedMissing.current && load()) triedMissing.current = missing;
  }, [slots, names, load]);

  return names;
}
