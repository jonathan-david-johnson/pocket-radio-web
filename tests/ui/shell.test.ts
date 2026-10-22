// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import Shell from "../../src/app/Shell";

const PL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const layout = (...slots: string[]) => new Response(JSON.stringify({ slots, updated_at: "2026-10-01T00:00:00+00:00" }));

function viewport(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow, media: query, addEventListener: () => {}, removeEventListener: () => {},
  }));
}
function mount(path: string, opts: { narrow?: boolean; playlists?: ReadonlyMap<string, string> | null; slots?: string[] } = {}) {
  viewport(opts.narrow ?? false);
  let slots = opts.slots ?? ["podcasts", "streams", `playlist:${PL_A}`];
  // null: /api/playlists fails, so the shell has no playlist list.
  let playlists = opts.playlists ?? null;
  const network = vi.fn(async (url: string) => {
    if (url === "/api/layout") return layout(...slots);
    if (url === "/api/playlists") {
      if (playlists === null) return new Response("no", { status: 502 });
      return new Response(JSON.stringify({ playlists: [...playlists].map(([uuid, title]) => ({ uuid, title })) }));
    }
    throw new Error(`Unexpected ${url}`);
  });
  vi.stubGlobal("fetch", network);
  const ui = (p: string) => createElement(MemoryRouter, { initialEntries: [p] },
    createElement(Shell, { email: "test@example.invalid", onSignedOut: () => {} }));
  render(ui(path));
  return {
    network,
    setSlots: (...next: string[]) => { slots = next; },
    setPlaylists: (next: ReadonlyMap<string, string> | null) => { playlists = next; },
    playlistLoads: () => network.mock.calls.filter(([url]) => url === "/api/playlists").length,
  };
}
const names = (list: HTMLElement) => within(list).getAllByRole("link").map(link => link.textContent);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("wide window: Sidebar", () => {
  it("lists every Destination in render order, with the Bar line where the phone's tab bar ends", async () => {
    mount("/streams");
    const sidebar = await screen.findByRole("navigation", { name: "Destinations" });
    expect(names(sidebar)).toEqual(["Podcasts", "Streams", "Playlist", "Playlists", "Discover", "Profile", "Up Next"]);
    // The Bar line sits above the fourth row: after Podcasts, Streams and the playlist.
    const rows = [...sidebar.querySelectorAll("li")];
    expect(rows.findIndex(row => row.querySelector("[role=separator]") !== null)).toBe(3);
    expect(screen.queryByRole("navigation", { name: "Tabs" })).toBeNull();
  });

  it("shows a loaded playlist's name instead of a generic label", async () => {
    mount("/streams", { playlists: new Map([[PL_A, "New Releases"]]) });
    expect(names(await screen.findByRole("navigation", { name: "Destinations" }))).toContain("New Releases");
  });

  it("drops a slot whose playlist is gone once playlists have loaded", async () => {
    mount("/streams", { playlists: new Map([[PL_B, "Other"]]) });
    expect(names(await screen.findByRole("navigation", { name: "Destinations" }))).not.toContain("Playlist");
  });
});

describe("narrow window: tab bar", () => {
  it("shows the bar's tabs, then More, and no Sidebar", async () => {
    mount("/streams", { narrow: true });
    const tabs = await screen.findByRole("navigation", { name: "Tabs" });
    expect(names(tabs)).toEqual(["Podcasts", "Streams", "Playlist", "More"]);
    expect(screen.queryByRole("navigation", { name: "Destinations" })).toBeNull();
  });

  it("holds four tabs and More when there are more than five slots", async () => {
    mount("/podcasts", { narrow: true, slots: ["podcasts", "playlists", "discover", "streams", "profile", "upNext"] });
    const tabs = await screen.findByRole("navigation", { name: "Tabs" });
    expect(names(tabs)).toEqual(["Podcasts", "Playlists", "Discover", "Streams", "More"]);
  });

  it("lists the rest on /more, in the same order as the Sidebar's lower half", async () => {
    mount("/more", { narrow: true });
    const more = await screen.findByRole("region", { name: "More" });
    expect(names(more)).toEqual(["Playlists", "Discover", "Profile", "Up Next"]);
  });
});

describe("routes", () => {
  it.each([
    ["/podcasts", "Podcasts"], ["/playlists", "Playlists"], ["/discover", "Discover"],
    ["/streams", "Streams"], ["/profile", "Profile"], ["/up-next", "Up Next"],
  ])("%s renders its placeholder", async (path, title) => {
    mount(path);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(title);
  });

  it("starts on the first Sidebar item", async () => {
    mount("/");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Podcasts");
  });

  it("shows a playlist placeholder for a playlist that exists", async () => {
    mount(`/playlist/${PL_A}`, { playlists: new Map([[PL_A, "New Releases"]]) });
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("New Releases");
  });

  it("says a playlist isn't available when it is not in the user's list", async () => {
    mount(`/playlist/${PL_B}`, { playlists: new Map([[PL_A, "New Releases"]]) });
    expect(await screen.findByText("This playlist isn't available")).toBeTruthy();
  });

  it("marks the current Destination in the Sidebar", async () => {
    mount("/streams");
    const link = within(await screen.findByRole("navigation", { name: "Destinations" })).getByRole("link", { name: "Streams" });
    expect(link.getAttribute("aria-current")).toBe("page");
  });
});

describe("layout refresh", () => {
  it("re-renders the Sidebar when the window regains focus, keeping the current Destination", async () => {
    const m = mount("/streams");
    const before = await screen.findByRole("navigation", { name: "Destinations" });
    expect(names(before)).toEqual(["Podcasts", "Streams", "Playlist", "Playlists", "Discover", "Profile", "Up Next"]);
    m.setSlots("streams", "podcasts");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    const after = await screen.findByRole("navigation", { name: "Destinations" });
    expect(names(after)).toEqual(["Streams", "Podcasts", "Playlists", "Discover", "Profile", "Up Next"]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Streams");
    expect(m.network).toHaveBeenCalledWith("/api/layout", expect.anything());
  });

  it("also refreshes when the tab becomes visible", async () => {
    const m = mount("/streams");
    await screen.findByRole("navigation", { name: "Destinations" });
    const calls = m.network.mock.calls.length;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(m.network.mock.calls.length).toBe(calls + 1);
  });

  it("keeps showing the last Layout when a refresh fails", async () => {
    const m = mount("/streams");
    await screen.findByRole("navigation", { name: "Destinations" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 502 })));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(names(screen.getByRole("navigation", { name: "Destinations" }))).toContain("Streams");
    void m;
  });
});

describe("playlist names", () => {
  const PL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const focus = () => act(async () => { window.dispatchEvent(new Event("focus")); });

  it("reads them from /api/playlists", async () => {
    const m = mount("/streams", { playlists: new Map([[PL_A, "New Releases"]]) });
    expect(names(await screen.findByRole("navigation", { name: "Destinations" }))).toContain("New Releases");
    expect(m.playlistLoads()).toBe(1);
  });

  it("shows the generic label for a playlist with an empty title", async () => {
    mount("/streams", { playlists: new Map([[PL_A, ""]]) });
    await screen.findByRole("link", { name: "Playlist" });
  });

  it("reloads them on focus at most every 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = mount("/streams", { playlists: new Map([[PL_A, "New Releases"]]) });
    await screen.findByRole("link", { name: "New Releases" });
    m.setPlaylists(new Map([[PL_A, "Renamed"]]));
    await focus();
    expect(m.playlistLoads()).toBe(1);
    vi.setSystemTime(Date.now() + 30_000);
    await focus();
    await screen.findByRole("link", { name: "Renamed" });
    expect(m.playlistLoads()).toBe(2);
  });

  it("reloads them at once when the Layout names a playlist they don't include", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = mount("/streams", { playlists: new Map([[PL_A, "New Releases"]]) });
    await screen.findByRole("link", { name: "New Releases" });
    // Created on the phone and added to the tab bar since the last load.
    m.setPlaylists(new Map([[PL_A, "New Releases"], [PL_C, "Tech"]]));
    m.setSlots("podcasts", `playlist:${PL_C}`, `playlist:${PL_A}`);
    await focus();
    await screen.findByRole("link", { name: "Tech" });
    expect(m.playlistLoads()).toBe(2);
  });

  it("does not keep reloading for a playlist that stays missing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = mount("/streams", { playlists: new Map([[PL_B, "Other"]]) });
    await screen.findByRole("navigation", { name: "Destinations" });
    await act(async () => {});
    await focus();
    await focus();
    expect(m.playlistLoads()).toBe(2);
    expect(names(screen.getByRole("navigation", { name: "Destinations" }))).not.toContain("Playlist");
  });

  it("keeps the last names when a reload fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = mount("/streams", { playlists: new Map([[PL_A, "New Releases"]]) });
    await screen.findByRole("link", { name: "New Releases" });
    m.setPlaylists(null);
    vi.setSystemTime(Date.now() + 30_000);
    await focus();
    expect(m.playlistLoads()).toBe(2);
    expect(screen.getByRole("link", { name: "New Releases" })).toBeTruthy();
  });
});

describe("account menu", () => {
  it("shows the email and both sign-outs", async () => {
    mount("/streams");
    const menu = await screen.findByRole("region", { name: "Account" });
    expect(within(menu).getByText("test@example.invalid")).toBeTruthy();
    expect(within(menu).getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(within(menu).getByRole("button", { name: "Sign out everywhere" })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("button", { name: "Sign out" }));
  });
});
