import { useEffect, useState } from "react";

const NARROW = "(max-width: 720px)";

/** True in a window narrow enough for the phone's tab bar instead of the Sidebar. */
export function useNarrow(): boolean {
  const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(NARROW) : null);
  const [narrow, setNarrow] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const media = query();
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}
