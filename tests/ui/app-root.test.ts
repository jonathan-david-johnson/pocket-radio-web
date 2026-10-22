// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import AppRoot from "../../src/AppRoot";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,synthetic") } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function network(session: unknown) {
  return vi.fn(async (url: string) => {
    if (url === "/api/session") return new Response(JSON.stringify(session));
    if (url === "/api/layout") return new Response(JSON.stringify({ slots: ["podcasts", "streams"], updated_at: "2026-10-01T00:00:00+00:00" }));
    if (url === "/api/playlists") return new Response(JSON.stringify({ playlists: [] }));
    throw new Error(`Unexpected ${url}`);
  });
}
const at = (path: string) => createElement(MemoryRouter, { initialEntries: [path] }, createElement(AppRoot));

it("shows the Pairing page, not the shell, when signed out, and never reads the Layout", async () => {
  const fetcher = network({ signedIn: false });
  vi.stubGlobal("fetch", fetcher);
  render(at("/streams"));
  expect(await screen.findByRole("button", { name: "Start Pairing" })).toBeTruthy();
  expect(fetcher.mock.calls.map(call => call[0])).not.toContain("/api/layout");
});

it("shows the shell with the account email when signed in", async () => {
  vi.stubGlobal("fetch", network({ signedIn: true, email: "me@example.invalid" }));
  render(at("/streams"));
  expect(await screen.findByRole("navigation", { name: "Destinations" })).toBeTruthy();
  expect(screen.getByText("me@example.invalid")).toBeTruthy();
});

it("keeps the M1 experiment page reachable at /experiments when signed in", async () => {
  vi.stubGlobal("fetch", network({ signedIn: true, email: "me@example.invalid" }));
  render(at("/experiments"));
  expect(await screen.findByRole("region", { name: "Pocket Casts JSON probes" })).toBeTruthy();
  await act(async () => {});
});
