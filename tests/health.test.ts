import { afterEach, expect, it, vi } from "vitest";
import { onRequestGet } from "../functions/api/health";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("returns an uncached healthy response without network or browser storage", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const fetch = vi.fn(() => { throw new Error("Network is forbidden"); });
  const storage = vi.fn(() => { throw new Error("Storage is forbidden"); });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("localStorage", { getItem: storage, setItem: storage });

  const response = onRequestGet();

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true });
  expect(fetch).not.toHaveBeenCalled();
  expect(storage).not.toHaveBeenCalled();
});
