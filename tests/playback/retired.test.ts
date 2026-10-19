import { afterEach, expect, it, vi } from "vitest";
import { onRequest as start } from "../../functions/api/relay/start";
import { onRequest as audio } from "../../functions/api/relay/[relayId]";
import { onRequest as events } from "../../functions/api/relay-events/[relayId]";
import { onRequest as stop } from "../../functions/api/relay/[relayId]/stop";

afterEach(() => vi.unstubAllGlobals());
it.each([start, audio, events, stop])("legacy relay entry returns Gone without touching bindings or network", async handler => {
  const network = vi.fn(() => { throw new Error("No network permitted"); });
  vi.stubGlobal("fetch", network);
  const response = await handler(new Proxy({}, { get() { throw new Error("No request/env/binding access permitted"); } }) as never);
  expect(response.status).toBe(410);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "relay_retired", mode: "direct_https" });
  expect(network).not.toHaveBeenCalled();
});
