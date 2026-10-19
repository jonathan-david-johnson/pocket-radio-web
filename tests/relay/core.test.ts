import { describe, expect, it, vi } from "vitest";
import { RelayCore, AUDIO_TTL_MS, INIT_TTL_MS, MAX_EVENT_QUEUE, MAX_AUDIO_CHUNK } from "../../workers/relay/core";
import ingress from "../../workers/relay/index";
import { encode, harness, internal, OWNER, readText, STREAM } from "./harness";

describe("per-listener Durable Object", () => {
  it("initializes without opening upstream; events alone never open audio", async () => {
    const h = harness();
    expect((await h.init()).status).toBe(201);
    const events = await h.core.fetch(internal("events"));
    const reader = events.body!.getReader();
    expect(await readText(reader)).toContain('event: reset');
    expect(h.network).not.toHaveBeenCalled();
    await reader.cancel();
    expect(h.heartbeat.size).toBe(0);
    expect(h.record()?.phase).toBe("waiting");
  });

  it("audio demand alone opens exactly one ICY connection and yields byte-identical audio + same-connection title", async () => {
    const h = harness();
    await h.init();
    const events = (await h.core.fetch(internal("events"))).body!.getReader();
    await readText(events);
    const [first, duplicate] = await Promise.all([h.core.fetch(internal("audio")), h.core.fetch(internal("audio"))]);
    expect([first.status, duplicate.status].sort()).toEqual([200, 409]);
    const audio = (first.status === 200 ? first : duplicate).body!.getReader();
    expect(h.network).toHaveBeenCalledTimes(1);
    expect(h.network.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", headers: { "Icy-MetaData": "1" } });
    expect(h.pulls).not.toHaveBeenCalled();
    expect(new TextDecoder().decode((await audio.read()).value)).toBe("abcdefgh");
    const title = await readText(events);
    expect(title).toContain('event: title');
    expect(title).toContain('"title":"Artist - Track"');
    expect(title).toContain('"generation":1');
    expect(h.pulls).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(h.pulls).toHaveBeenCalledTimes(1); // no read-ahead without audio demand
    await audio.cancel();
    expect(h.canceled).toHaveBeenCalledTimes(1);
    expect(h.record()?.phase).toBe("ended");
    expect(await readText(events)).toContain('event: stopped');
    expect((await events.read()).done).toBe(true);
    expect((await h.core.fetch(internal("audio"))).status).toBe(410);
    expect(h.heartbeat.size).toBe(0);
  });

  it("late SSE replays latest with reset and never creates a second upstream", async () => {
    const h = harness();
    await h.init();
    const audio = (await h.core.fetch(internal("audio"))).body!.getReader();
    await audio.read();
    const late = (await h.core.fetch(internal("events"))).body!.getReader();
    expect(await readText(late)).toContain('id: 1:0');
    expect(await readText(late)).toContain('"title":"Artist - Track"');
    await late.cancel();
    await audio.read();
    expect(h.network).toHaveBeenCalledTimes(1);
    await audio.cancel();
  });

  it("denies other owner, replayed init, wrong object handle and unauthenticated internal requests", async () => {
    const h = harness();
    await h.init();
    for (const path of ["audio", "events", "stop"]) {
      expect((await h.core.fetch(internal(path, "c".repeat(64)))).status).toBe(404);
    }
    expect((await h.core.fetch(internal("init", "c".repeat(64), { streamUrl: STREAM }))).status).toBe(409);
    const request = internal("audio");
    request.headers.set("x-relay-id", "d".repeat(64));
    expect((await h.core.fetch(request)).status).toBe(403);
    expect((await h.core.fetch(new Request("https://relay.internal/audio"))).status).toBe(403);
    expect(h.network).not.toHaveBeenCalled();
  });

  it("default public ingress denies init, audio, events, and stop even with internal headers", () => {
    for (const path of ["init", "audio", "events", "stop"]) {
      // Default export is intentionally unable to forward even authenticated-looking ingress.
      expect(ingress.fetch(internal(path))).toMatchObject({ status: 404 });
    }
  });

  it("expires SSE-only handle and active audio using injected clock and alarm", async () => {
    const idle = harness();
    await idle.init();
    const events = (await idle.core.fetch(internal("events"))).body!.getReader();
    await readText(events);
    idle.advance(INIT_TTL_MS);
    await idle.core.alarm();
    expect(await readText(events)).toContain('event: stopped');
    expect(idle.network).not.toHaveBeenCalled();
    expect((await idle.core.fetch(internal("audio"))).status).toBe(410);
    const active = harness();
    await active.init();
    const audio = (await active.core.fetch(internal("audio"))).body!.getReader();
    active.advance(AUDIO_TTL_MS);
    await active.core.alarm();
    await expect(audio.read()).rejects.toThrow("Relay ended");
    expect(active.canceled).toHaveBeenCalledOnce();
  });

  it("stop cleans audio and SSE; replay cannot restart the upstream", async () => {
    const h = harness();
    await h.init();
    const audio = (await h.core.fetch(internal("audio"))).body!.getReader();
    const events = (await h.core.fetch(internal("events"))).body!.getReader();
    await readText(events);
    expect((await h.core.fetch(internal("stop"))).status).toBe(204);
    await expect(audio.read()).rejects.toThrow();
    expect(await readText(events)).toContain('event: stopped');
    expect((await h.core.fetch(internal("stop"))).status).toBe(204);
    expect((await h.init()).status).toBe(409);
    expect(h.network).toHaveBeenCalledOnce();
  });

  it("request abort cancels upstream and subscriber; no SSE connection holds audio alone", async () => {
    const h = harness();
    await h.init();
    const signal = new AbortController();
    const audio = (await h.core.fetch(internal("audio", OWNER, undefined, signal.signal))).body!.getReader();
    signal.abort();
    await expect(audio.read()).rejects.toThrow();
    await Promise.resolve();
    expect(h.canceled).toHaveBeenCalledOnce();
    const h2 = harness();
    await h2.init();
    const eventAbort = new AbortController();
    const events = (await h2.core.fetch(internal("events", OWNER, undefined, eventAbort.signal))).body!.getReader();
    eventAbort.abort();
    await expect(events.read()).rejects.toThrow();
    expect(h2.heartbeat.size).toBe(0);
    expect(h2.network).not.toHaveBeenCalled();
  });

  it("caps event queue and subscribers without slowing or retaining audio", async () => {
    const h = harness();
    await h.init();
    const slow = (await h.core.fetch(internal("events"))).body!.getReader();
    const second = (await h.core.fetch(internal("events"))).body!.getReader();
    expect((await h.core.fetch(internal("events"))).status).toBe(429);
    await second.cancel();
    const audio = (await h.core.fetch(internal("audio"))).body!.getReader();
    for (let i = 0; i < MAX_EVENT_QUEUE + 1; i++) await audio.read();
    await expect(slow.read()).rejects.toThrow("Slow relay event subscriber");
    expect(h.record()?.phase).toBe("playing");
    expect(h.heartbeat.size).toBe(0);
    await audio.cancel();
  });

  it("restart invalidates stored generation and never replays its title or opens upstream", async () => {
    const h = harness();
    await h.init();
    const audio = (await h.core.fetch(internal("audio"))).body!.getReader();
    await audio.read();
    const resumed = new RelayCore(h.deps);
    expect((await resumed.fetch(internal("events"))).status).toBe(410);
    expect((await resumed.fetch(internal("audio"))).status).toBe(410);
    expect(h.record()?.generation).toBe(2);
    expect(h.network).toHaveBeenCalledOnce();
    await audio.cancel();
  });

  it("stop during opening aborts pending fetch and prevents publishing stale generation", async () => {
    let release!: (response: Response) => void;
    const network = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const h = harness({ network });
    await h.init();
    const opening = h.core.fetch(internal("audio"));
    for (let i = 0; i < 8 && !network.mock.calls.length; i++) await Promise.resolve();
    expect(network).toHaveBeenCalledOnce();
    await h.core.fetch(internal("stop"));
    const canceled = vi.fn();
    release(new Response(new ReadableStream({ cancel: canceled }), { headers: { "content-type": "audio/mpeg" } }));
    expect((await opening).status).toBe(410);
    expect(canceled).toHaveBeenCalledOnce();
    expect(h.record()?.phase).toBe("ended");
  });

  it("bounds upstream chunks and closes on invalid interval or content-type", async () => {
    const invalidHeaders: Record<string, string>[] = [
      { "content-type": "audio/mpeg", "icy-metaint": "0" },
      { "content-type": "text/html" },
    ];
    for (const headers of invalidHeaders) {
      const canceled = vi.fn();
      const h = harness({ network: async () => new Response(new ReadableStream({ cancel: canceled }), { headers }) });
      await h.init();
      expect((await h.core.fetch(internal("audio"))).status).toBe(502);
      expect(canceled).toHaveBeenCalledOnce();
    }
    const h = harness({ network: async () => new Response(new ReadableStream<Uint8Array>({
      pull: controller => controller.enqueue(new Uint8Array(MAX_AUDIO_CHUNK + 1)),
    }, { highWaterMark: 0 }), { headers: { "content-type": "audio/mpeg" } }) });
    await h.init();
    const reader = (await h.core.fetch(internal("audio"))).body!.getReader();
    await expect(reader.read()).rejects.toThrow("Relay ended");
    expect(h.record()?.phase).toBe("ended");
  });

  it("passes plain audio through without inventing titles and handles EOF", async () => {
    const h = harness({ network: async () => new Response(new ReadableStream<Uint8Array>({
      start: controller => { controller.enqueue(encode("plain")); controller.close(); },
    }), { headers: { "content-type": "audio/mpeg" } }) });
    await h.init();
    const reader = (await h.core.fetch(internal("audio"))).body!.getReader();
    expect(await readText(reader)).toBe("plain");
    expect((await reader.read()).done).toBe(true);
    expect(h.record()?.phase).toBe("ended");
  });
});
