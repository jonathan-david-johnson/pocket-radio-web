import { useCallback, useEffect, useRef, useState } from "react";
import { api, record } from "../experiment-api";

export interface LayoutState {
  /** The stored slots, or `null` until the first load succeeds. */
  slots: string[] | null;
  /** Set when the latest load failed; the previous slots stay in place. */
  failed: boolean;
}

/** Reads the user's Layout, and reads it again when the window regains focus or the tab becomes visible. */
export function useLayout(): LayoutState {
  const [state, setState] = useState<LayoutState>({ slots: null, failed: false });
  const inFlight = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { data } = await api("/api/layout");
      const row = record(data);
      if (!Array.isArray(row.slots) || !row.slots.every(slot => typeof slot === "string")) throw new Error("Invalid layout");
      if (alive.current) setState({ slots: row.slots as string[], failed: false });
    } catch {
      if (alive.current) setState(previous => ({ slots: previous.slots, failed: true }));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const onFocus = () => void load();
    const onVisibility = () => { if (document.visibilityState !== "hidden") void load(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  return state;
}
