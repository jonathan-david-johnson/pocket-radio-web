/**
 * How a stored tab Layout renders: the phone's tab bar and More tab, and the web
 * Sidebar with the Bar line where the phone's tab bar ends (web ADR 0005).
 *
 * A pure port of iOS `TabLayout.renderPlan(capacity:isAvailable:)`. The shared
 * fixtures in `contracts/nav_layout/` are the contract both ports must pass.
 */

/** Core destinations, in the order iOS uses for the More tab. */
export const CORE_DESTINATIONS = ["podcasts", "playlists", "discover", "streams", "profile", "upNext"] as const;

export type CoreDestination = (typeof CORE_DESTINATIONS)[number];

/**
 * What shows when no slot is left to render, so the bar is never empty: the
 * Pocket Casts web menu's top group with Streams after Podcasts. Not iOS
 * behavior; see `contracts/nav_layout/README.md`.
 */
export const EMPTY_LAYOUT_DEFAULT: readonly CoreDestination[] = ["podcasts", "streams", "playlists", "discover"];

const PLAYLIST_PREFIX = "playlist:";

/** A destination as stored in `nav_layout.slots`: a core id or `playlist:<uuid>`. */
export type DestinationId = CoreDestination | `playlist:${string}`;

export interface RenderPlan {
  /** The tabs, in order, not counting More. */
  bar: DestinationId[];
  /** The More tab's rows: slots that did not fit, then unplaced core destinations. Empty when there is no More tab. */
  more: DestinationId[];
  /** `bar` then `more`, the order the Sidebar lists them. */
  sidebar: DestinationId[];
  /** Sidebar rows above the Bar line, or `null` when there is no More tab and so no line. */
  barLineAfter: number | null;
}

/** The playlist UUID of a `playlist:<uuid>` id, or `null` for any other id. */
export function playlistUuid(id: string): string | null {
  if (!id.startsWith(PLAYLIST_PREFIX)) return null;
  const uuid = id.slice(PLAYLIST_PREFIX.length);
  return uuid.length > 0 ? uuid : null;
}

/** A stored slot id as a destination, or `null` when this build does not know it (for instance, written by a newer app). */
export function resolveDestination(id: string): DestinationId | null {
  if ((CORE_DESTINATIONS as readonly string[]).includes(id)) return id as CoreDestination;
  const uuid = playlistUuid(id);
  return uuid === null ? null : `playlist:${uuid}`;
}

/**
 * Renders stored slots at a device's capacity (tab items, counting More).
 *
 * `isPlaylistAvailable` says whether a playlist still exists for the user. A slot
 * for a missing playlist is dropped, as iOS does with `isAvailable`, rather than
 * shown as a dead tab. Unknown ids are dropped too. The rest keep their order.
 * When none is left, `EMPTY_LAYOUT_DEFAULT` renders instead.
 */
export function renderLayout(
  slots: readonly string[],
  capacity: number,
  isPlaylistAvailable: (uuid: string) => boolean = () => true,
): RenderPlan {
  const cap = Math.max(1, Math.floor(capacity));

  let resolvable: DestinationId[] = [];
  for (const slot of slots) {
    const destination = resolveDestination(slot);
    if (destination === null) continue;
    const uuid = playlistUuid(destination);
    if (uuid !== null && !isPlaylistAvailable(uuid)) continue;
    resolvable.push(destination);
  }
  if (resolvable.length === 0) resolvable = [...EMPTY_LAYOUT_DEFAULT];

  const placed = new Set<string>(resolvable);
  const complement = CORE_DESTINATIONS.filter((core) => !placed.has(core));

  // More exists unless nothing is left over: no unplaced core and every slot fits.
  const needsMore = !(complement.length === 0 && resolvable.length <= cap);
  const barCount = Math.min(resolvable.length, needsMore ? cap - 1 : cap);

  const bar = resolvable.slice(0, barCount);
  const more = needsMore ? [...resolvable.slice(barCount), ...complement] : [];

  return { bar, more, sidebar: [...bar, ...more], barLineAfter: more.length > 0 ? bar.length : null };
}
