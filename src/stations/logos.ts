// Station logos copied from the iOS asset catalog, one file per asset name:
// logos/<logo_asset>.png. `logo_asset` in /api/stations/curated is that name.
const logos = import.meta.glob<string>("./logos/*.png", { eager: true, query: "?url", import: "default" });

/** The bundled URL for a station's `logo_asset`, or null when the web has no such logo. */
export function stationLogoUrl(logoAsset: string): string | null {
  return logos[`./logos/${logoAsset}.png`] ?? null;
}
