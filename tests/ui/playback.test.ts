// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App";

const STATION = "22222222-2222-4222-8222-222222222222";
const STREAM = "https://stream.example.org/live.mp3";
const OTHER = "33333333-3333-4333-8333-333333333333";
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,synthetic") } }));
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function ready(reply: (url: string) => Response | Promise<Response>) {
  const network = vi.fn(async (url: string) => {
    if (url === "/api/session") return Response.json({ signedIn: true, email: "test@example.invalid" });
    if (url === "/api/signout" || url === "/api/signout/everywhere") return Response.json({ signedIn: false });
    if (url === "/api/playback?stationId=" + STATION || url === "/api/playback?stationId=" + OTHER) return reply(url);
    throw new Error("Unexpected request");
  });
  const events = vi.fn();
  vi.stubGlobal("fetch", network); vi.stubGlobal("EventSource", events);
  const view = render(createElement(App));
  await screen.findByText("Signed in as test@example.invalid");
  const player = within(screen.getByRole("region", { name: "Direct playback" }));
  fireEvent.change(player.getByLabelText("Radio-browser station UUID"), { target: { value: STATION } });
  return { view, player, network, events };
}

it("uses the HTTPS station as audio src, never a relay or metadata connection, and tears down on stop", async () => {
  const h = await ready(() => Response.json({ stationId: STATION, streamUrl: STREAM }));
  await act(async () => { fireEvent.click(h.player.getByRole("button", { name: "Load HTTPS station" })); });
  const audio = h.view.container.querySelector("audio")!;
  expect(audio.getAttribute("src")).toBe(STREAM);
  expect(audio.preload).toBe("none");
  expect(audio.autoplay).toBe(false);
  expect(audio.hasAttribute("crossorigin")).toBe(false);
  expect(h.events).not.toHaveBeenCalled();
  expect(h.network.mock.calls.map(call => call[0])).toEqual(["/api/session", "/api/playback?stationId=" + STATION]);
  expect(h.player.getByText(/Track titles are unavailable/)).toBeTruthy();
  fireEvent.click(h.player.getByRole("button", { name: "Stop playback" }));
  expect(audio.getAttribute("src")).toBeNull();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  expect(h.view.container.querySelector("audio")).toBeNull();
  expect(h.network).toHaveBeenCalledTimes(2);
});

it.each(["stop", "signout", "everywhere", "unmount"])("stops an already loaded direct stream on %s", async action => {
  const h = await ready(() => Response.json({ stationId: STATION, streamUrl: STREAM }));
  await act(async () => { fireEvent.click(h.player.getByRole("button", { name: "Load HTTPS station" })); });
  const audio = h.view.container.querySelector("audio")!;
  if (action === "stop") fireEvent.click(h.player.getByRole("button", { name: "Stop playback" }));
  if (action === "signout") await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out / cancel Pairing" })); });
  if (action === "everywhere") await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" })); });
  if (action === "unmount") h.view.unmount();
  expect(audio.getAttribute("src")).toBeNull();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(h.events).not.toHaveBeenCalled();
});

it("releases the previous station before a replacement lookup completes", async () => {
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const h = await ready(url => url.endsWith(OTHER) ? pending : Response.json({ stationId: STATION, streamUrl: STREAM }));
  await act(async () => { fireEvent.click(h.player.getByRole("button", { name: "Load HTTPS station" })); });
  const previous = h.view.container.querySelector("audio")!;
  fireEvent.change(h.player.getByLabelText("Radio-browser station UUID"), { target: { value: OTHER } });
  fireEvent.click(h.player.getByRole("button", { name: "Load HTTPS station" }));
  expect(previous.getAttribute("src")).toBeNull();
  expect(h.view.container.querySelector("audio")).toBeNull();
  expect(h.player.getByRole("status").textContent).toContain("Looking up");
  await act(async () => { finish(Response.json({ stationId: OTHER, streamUrl: STREAM + "?other=1" })); });
  const next = h.view.container.querySelector("audio")!;
  expect(next).not.toBe(previous);
  expect(next.getAttribute("src")).toBe(STREAM + "?other=1");
  expect(h.events).not.toHaveBeenCalled();
});

it("explains HTTP-only rejection beside the player without opening audio or falling back", async () => {
  const h = await ready(() => Response.json({ error: "https_required" }, { status: 422 }));
  await act(async () => { fireEvent.click(h.player.getByRole("button", { name: "Load HTTPS station" })); });
  expect(h.player.getByRole("status").textContent).toContain("HTTPS");
  expect(h.player.getByRole("status").textContent).toContain("HTTP-only");
  expect(h.view.container.querySelector("audio")).toBeNull();
  expect(h.events).not.toHaveBeenCalled();
  expect(h.network).toHaveBeenCalledTimes(2);
});

it("clears audio and explains browser playback failure without trying a relay", async () => {
  const h = await ready(() => Response.json({ stationId: STATION, streamUrl: STREAM }));
  await act(async () => { fireEvent.click(h.player.getByRole("button", { name: "Load HTTPS station" })); });
  fireEvent.error(h.view.container.querySelector("audio")!);
  expect(h.view.container.querySelector("audio")).toBeNull();
  expect(h.player.getByRole("status").textContent).toContain("could not play");
  expect(h.events).not.toHaveBeenCalled();
  expect(h.network).toHaveBeenCalledTimes(2);
});
