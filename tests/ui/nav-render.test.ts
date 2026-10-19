import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderLayout, resolveDestination } from "../../src/nav/render";

interface Fixture {
  description: string;
  slots: string[];
  capacity: number;
  available_playlists: string[];
  expected: { bar: string[]; more: string[]; sidebar: string[]; bar_line_after: number | null };
}

// The shared contract lives in the shell repo, next to this repo.
const CONTRACT = new URL("../../../contracts/nav_layout/", import.meta.url);
const fixtures = readdirSync(CONTRACT)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => [name, JSON.parse(readFileSync(new URL(name, CONTRACT), "utf8")) as Fixture] as const);

describe("contracts/nav_layout", () => {
  it("has fixtures to check", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(9);
  });

  it.each(fixtures)("%s", (_name, fixture) => {
    const available = new Set(fixture.available_playlists);
    const plan = renderLayout(fixture.slots, fixture.capacity, (uuid) => available.has(uuid));
    expect({ bar: plan.bar, more: plan.more, sidebar: plan.sidebar, bar_line_after: plan.barLineAfter }).toEqual(
      fixture.expected,
    );
  });
});

describe("renderLayout", () => {
  it("treats every playlist as available when no check is given", () => {
    expect(renderLayout(["playlist:abc", "streams"], 5).bar).toEqual(["playlist:abc", "streams"]);
  });

  it("clamps a capacity below one to one", () => {
    const plan = renderLayout(["podcasts", "streams"], 0);
    expect(plan.bar).toEqual([]);
    expect(plan.more[0]).toBe("podcasts");
  });

  it("does not change the stored slots", () => {
    const slots = ["podcasts", "from_the_future", "streams"];
    renderLayout(slots, 5);
    expect(slots).toEqual(["podcasts", "from_the_future", "streams"]);
  });
});

describe("resolveDestination", () => {
  it("knows the core ids and playlist ids, and nothing else", () => {
    expect(resolveDestination("upNext")).toBe("upNext");
    expect(resolveDestination("playlist:abc")).toBe("playlist:abc");
    expect(resolveDestination("playlist:")).toBeNull();
    expect(resolveDestination("from_the_future")).toBeNull();
    expect(resolveDestination("UpNext")).toBeNull();
  });
});
