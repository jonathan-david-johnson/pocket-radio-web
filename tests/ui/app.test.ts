// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../../src/App";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,synthetic") } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("does not permit pairing or signout while a cookie-renewing restoration request is pending", async () => {
  let resolve!: (value: Response) => void;
  const restoring = new Promise<Response>(done => { resolve = done; });
  const network = vi.fn(() => restoring);
  vi.stubGlobal("fetch", network);
  render(createElement(App));
  const pair = screen.getByRole("button", { name: "Start Pairing" }) as HTMLButtonElement;
  const signout = screen.getByRole("button", { name: "Sign out / cancel Pairing" }) as HTMLButtonElement;
  expect(pair.disabled).toBe(true);
  expect(signout.disabled).toBe(true);
  fireEvent.click(pair);
  expect(network).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve(new Response(JSON.stringify({ signedIn: true, email: "old@example.invalid" })));
    await restoring;
  });
  expect(screen.getByText("Signed in as old@example.invalid")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start Pairing" })).toBeNull();
});

it("allows pairing only after restoration has settled without a session", async () => {
  let resolve!: (value: Response) => void;
  const restoring = new Promise<Response>(done => { resolve = done; });
  const network = vi.fn(() => restoring);
  vi.stubGlobal("fetch", network);
  render(createElement(App));
  expect((screen.getByRole("button", { name: "Start Pairing" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { resolve(new Response(JSON.stringify({ signedIn: false }))); await restoring; });
  expect((screen.getByRole("button", { name: "Start Pairing" }) as HTMLButtonElement).disabled).toBe(false);
  const probes = within(screen.getByRole("region", { name: "Pocket Casts JSON probes" }));
  expect((probes.getByRole("button", { name: "Run selected probe" }) as HTMLButtonElement).disabled).toBe(true);
  expect(probes.getByText("Pair first to enable probes.")).toBeTruthy();
});

it("shows probe progress and results beside the button, without duplicate requests", async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const network = vi.fn(async (url: string) => url === "/api/session"
    ? new Response(JSON.stringify({ signedIn: true, email: "test@example.invalid" })) : pending);
  vi.stubGlobal("fetch", network);
  render(createElement(App));
  await screen.findByText("Signed in as test@example.invalid");
  const probes = within(screen.getByRole("region", { name: "Pocket Casts JSON probes" }));
  // Choosing an endpoint does not run it automatically.
  fireEvent.change(probes.getByRole("combobox"), { target: { value: "user/playlist/list" } });
  expect(network).toHaveBeenCalledTimes(1);
  const button = probes.getByRole("button", { name: "Run selected probe" }) as HTMLButtonElement;
  fireEvent.click(button);
  expect(probes.getByRole("status").textContent).toContain("Running user/playlist/list…");
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(network).toHaveBeenCalledTimes(2);
  expect(network.mock.calls[1]![0]).toBe("/api/probes?endpoint=user%2Fplaylist%2Flist");
  await act(async () => {
    resolve(new Response(JSON.stringify({ endpoint: "user/playlist/list", status: "observed", httpStatus: 200, format: "json-object" })));
    await pending;
  });
  expect(probes.getByRole("status").textContent).toContain('"httpStatus": 200');
  expect(probes.getByRole("status").textContent).toContain('"format": "json-object"');
  expect(button.disabled).toBe(false);
});

it.each([429, 503])("shows HTTP %s failures inside the probe section, without server details", async status => {
  vi.stubGlobal("fetch", async (url: string) => url === "/api/session"
    ? new Response(JSON.stringify({ signedIn: true, email: "test@example.invalid" }))
    : new Response(JSON.stringify({ error: "private upstream detail" }), { status, headers: { "Retry-After": "30" } }));
  render(createElement(App));
  await screen.findByText("Signed in as test@example.invalid");
  const probes = within(screen.getByRole("region", { name: "Pocket Casts JSON probes" }));
  await act(async () => { fireEvent.click(probes.getByRole("button", { name: "Run selected probe" })); });
  const result = probes.getByRole("status").textContent;
  expect(result).toContain(status === 429 ? "Wait 30 seconds" : "Request failed (503)");
  expect(document.body.textContent).not.toContain("private upstream detail");
  expect((probes.getByRole("button", { name: "Run selected probe" }) as HTMLButtonElement).disabled).toBe(false);
});
