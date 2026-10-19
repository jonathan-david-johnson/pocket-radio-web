import { vi } from "vitest";
import { RelayCore, type RelayRecord } from "../../workers/relay/core";
import type { RelayRpc } from "../../functions/_lib/relay/rpc";

export const ID = "0000000003e8" + "a".repeat(52);
export const SESSION_HASH = "c".repeat(64);
export const OWNER = "b".repeat(64);
export const STREAM = "http://ice1.somafm.com/groovesalad-128-mp3";
export const UUID = "12345678-1234-1234-1234-123456789abc";
export const encode = (text: string) => new TextEncoder().encode(text);
export function internal(path: string, owner = OWNER, body?: object, signal?: AbortSignal): Request {
  return new Request("https://relay.internal/" + path, {
    method: path === "init" || path === "stop" ? "POST" : "GET",
    headers: { "x-relay-id": ID, "x-relay-owner": owner, "x-relay-session-hash": SESSION_HASH, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal,
  });
}
export function icyFixture(title = "Artist - Track"): Uint8Array {
  const text = encode("StreamTitle='" + title + "';");
  const metadata = new Uint8Array(Math.ceil(text.length / 16) * 16);
  metadata.set(text);
  return new Uint8Array([...encode("abcd"), metadata.length / 16, ...metadata, ...encode("efgh"), 0]);
}
export function harness(options: { initial?: RelayRecord; network?: (input: string, init?: RequestInit) => Promise<Response> } = {}) {
  let now = 1000;
  let record = options.initial ? structuredClone(options.initial) : undefined;
  const alarms: number[] = [];
  const heartbeat = new Set<() => void>();
  const timeouts = new Map<() => void, number>();
  const rpc = vi.fn<RelayRpc>(async () => true);
  const pulls = vi.fn();
  const canceled = vi.fn();
  const network = vi.fn(options.network ?? (async () => new Response(new ReadableStream<Uint8Array>({
    pull: controller => { pulls(); controller.enqueue(icyFixture()); },
    cancel: () => { canceled(); },
  }, { highWaterMark: 0 }), { headers: { "content-type": "audio/mpeg", "icy-metaint": "4" } })));
  const deps = {
    storage: {
      get: async () => record ? structuredClone(record) : undefined,
      put: async (value: RelayRecord) => { record = structuredClone(value); },
      setAlarm: async (at: number) => { alarms.push(at); },
      deleteAll: async () => { record = undefined; },
    },
    network, rpc, now: () => now, matchesId: (id: string) => id === ID,
    every: (callback: () => void) => { heartbeat.add(callback); return () => { heartbeat.delete(callback); }; },
    after: (callback: () => void, milliseconds: number) => { timeouts.set(callback, now + milliseconds); return () => { timeouts.delete(callback); }; },
  };
  const core = new RelayCore(deps);
  return {
    core, deps, network, rpc, pulls, canceled, alarms, heartbeat, timeouts,
    record: () => record,
    advance: (ms: number) => { now += ms; },
    tick: async (ms: number) => {
      now += ms;
      for (const [callback, at] of [...timeouts]) {
        if (at <= now) { timeouts.delete(callback); callback(); }
      }
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
    init: () => core.fetch(internal("init", OWNER, { streamUrl: STREAM })),
  };
}
export async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const part = await reader.read();
  return new TextDecoder().decode(part.value);
}
