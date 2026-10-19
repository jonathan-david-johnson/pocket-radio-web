import { afterEach, expect, it, vi } from "vitest";
import { api, pairingResponse, playbackResponse, retrySeconds, sessionResponse } from "../src/experiment-api";

afterEach(() => vi.unstubAllGlobals());
it("validates a pairing URI that contains only the returned approval code", () => {
  const data = { userCode: "ABCDEF", pairingUri: "pktc://pair?user_code=ABCDEF", expiresIn: 600, interval: 5 };
  expect(pairingResponse(data)).toEqual(data);
  for (const patch of [{ pairingUri: "https://other.test" }, { interval: 0 }, { expiresIn: 1000 }, { userCode: "<html>" }]) {
    expect(() => pairingResponse({ ...data, ...patch })).toThrow();
  }
});
it("copies only a verified station and direct HTTPS URL, rejecting unsafe or same-origin audio", () => {
  const stationId = "22222222-2222-4222-8222-222222222222";
  const data = { stationId, streamUrl: "https://stream.example.org/live.mp3" };
  expect(playbackResponse({ ...data, token: "private" }, stationId, "https://radio.example.org")).toEqual(data);
  for (const patch of [{ stationId: "bad" }, { streamUrl: "http://stream.example.org/live" },
    { streamUrl: "https://127.0.0.1/live" }, { streamUrl: "https://radio.example.org/api/relay/old" }]) {
    expect(() => playbackResponse({ ...data, ...patch }, stationId, "https://radio.example.org")).toThrow();
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
it.each([["12", 12], ["bad", 30], ["999999", 900]])("explains rate limiting with bounded Retry-After %s", async (header, wait) => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "private upstream detail" }), {
    status: 429, headers: { "Retry-After": String(header) },
  }));
  await expect(api("/api/probes?endpoint=user%2Fpodcast%2Flist")).rejects.toThrow(`Wait ${wait} seconds`);
});
it("uses only same-origin paths and does not expose private server errors", async () => {
  const network = vi.fn(async () => new Response(JSON.stringify({ error: "private upstream detail" }), { status: 503 }));
  vi.stubGlobal("fetch", network);
  await expect(api("/api/session")).rejects.toThrow("Request failed (503)");
  expect(network).toHaveBeenCalledWith("/api/session", expect.objectContaining({ redirect: "error" }));
  await expect(api("https://other.test/api/session")).rejects.toThrow("Same-origin");
  expect(network).toHaveBeenCalledTimes(1);
});
