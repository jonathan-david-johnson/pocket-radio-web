import { afterEach, expect, it, vi } from "vitest";
import { api, pairingResponse, relayResponse, retrySeconds, sessionResponse } from "../src/experiment-api";

afterEach(() => vi.unstubAllGlobals());
it("validates a pairing URI that contains only the returned approval code", () => {
  const data = { userCode: "ABCDEF", pairingUri: "pktc://pair?user_code=ABCDEF", expiresIn: 600, interval: 5 };
  expect(pairingResponse(data)).toEqual(data);
  for (const patch of [{ pairingUri: "https://other.test" }, { interval: 0 }, { expiresIn: 1000 }, { userCode: "<html>" }]) {
    expect(() => pairingResponse({ ...data, ...patch })).toThrow();
  }
});
it("refuses relay URLs that do not match the opaque same-origin handle", () => {
  const relayId = "a".repeat(64);
  const data = { relayId, audioUrl: `/api/relay/${relayId}`, eventsUrl: `/api/relay-events/${relayId}` };
  expect(relayResponse(data)).toEqual(data);
  for (const patch of [{ audioUrl: "https://other.test/audio" }, { eventsUrl: "//other.test/events" }, { relayId: "bad" }]) {
    expect(() => relayResponse({ ...data, ...patch })).toThrow();
  }
});
it("copies only the public session fields", () => {
  expect(sessionResponse({ signedIn: true, email: "test@example.invalid", uuid: "secret", token: "secret" }))
    .toEqual({ signedIn: true, email: "test@example.invalid" });
  expect(sessionResponse({ signedIn: false, token: "secret" })).toEqual({ signedIn: false });
  expect(() => sessionResponse({ signedIn: true })).toThrow();
});
it("honors bounded poll intervals", () => {
  expect(retrySeconds("10", 5)).toBe(10);
  expect(retrySeconds("0", 5)).toBe(5);
  expect(retrySeconds("9999", 5)).toBe(900);
  expect(retrySeconds("bad", 7)).toBe(7);
});
it("uses only same-origin paths and does not expose private server errors", async () => {
  const network = vi.fn(async () => new Response(JSON.stringify({ error: "private upstream detail" }), { status: 503 }));
  vi.stubGlobal("fetch", network);
  await expect(api("/api/session")).rejects.toThrow("Request failed (503)");
  expect(network).toHaveBeenCalledWith("/api/session", expect.objectContaining({ redirect: "error" }));
  await expect(api("https://other.test/api/session")).rejects.toThrow("Same-origin");
  expect(network).toHaveBeenCalledTimes(1);
});
