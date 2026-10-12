// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
