import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stationLogoUrl } from "../../src/stations/logos";

// iOS is the source of the station list and its logos. These checks skip when
// pocket-radio-ios is not checked out next to this repo.
const ios = new URL("../../../pocket-radio-ios/", import.meta.url);
const iosList = new URL("podcasts/Radio/curated_stations.json", ios);
const iosCatalog = new URL("podcasts/CommonImages.xcassets/", ios);
const hasIos = existsSync(iosList);
const logoAssets = hasIos
  ? (JSON.parse(readFileSync(iosList, "utf8")) as { stations: { logoAsset: string }[] }).stations.map(s => s.logoAsset)
  : [];

describe("station logos", () => {
  it.skipIf(!hasIos)("resolve for every logoAsset in the iOS station list", () => {
    expect(logoAssets.length).toBeGreaterThan(0);
    for (const asset of logoAssets) expect(stationLogoUrl(asset), asset).toEqual(expect.any(String));
  });

  it.skipIf(!hasIos)("are byte-identical to the iOS asset catalog images", () => {
    for (const asset of logoAssets) {
      const imageset = new URL(`${asset}.imageset/`, iosCatalog);
      const { images } = JSON.parse(readFileSync(new URL("Contents.json", imageset), "utf8")) as { images: { filename?: string }[] };
      const filename = images.find(image => image.filename)?.filename;
      expect(filename, asset).toBeDefined();
      const web = readFileSync(new URL(`../../src/stations/logos/${asset}.png`, import.meta.url));
      expect(web.equals(readFileSync(new URL(filename!, imageset))), asset).toBe(true);
    }
  });

  it("returns null for an unknown or unsafe name", () => {
    expect(stationLogoUrl("no_such_logo")).toBeNull();
    expect(stationLogoUrl("../kexp_logo")).toBeNull();
    expect(stationLogoUrl("")).toBeNull();
  });
});
