import { IcyParser, parseInterval } from "../../functions/_lib/relay/icy";
import { fetchStationStream, relayCreatedAt, RELAY_ID, safeStreamUrl, type NetworkFetch } from "../../functions/_lib/relay/security";
import { boundedRpc, type RelayRpc } from "../../functions/_lib/relay/rpc";

export const INIT_TTL_MS = 30_000;
export const TOMBSTONE_TTL_MS = 24 * 60 * 60_000;
export const SESSION_INTERVAL_MS = 12_000;
export const SESSION_MAX_AGE_MS = 15_000;
export const AUDIO_TTL_MS = 65 * 60_000;
export const MAX_AUDIO_CHUNK = 64 * 1024;
export const MAX_EVENT_QUEUE = 4;
export const MAX_SUBSCRIBERS = 2;
export interface RelayRecord {
  relayId: string;
  owner: string;
  sessionHash: string;
  streamUrl: string;
  generation: number;
  expiresAt: number;
  phase: "waiting" | "opening" | "playing" | "ended";
}
export interface RelayStorage {
  get(): Promise<RelayRecord | undefined>;
  put(record: RelayRecord): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAll(): Promise<void>;
}
export interface RelayDependencies {
  storage: RelayStorage;
  network: NetworkFetch;
  rpc: RelayRpc;
  now: () => number;
  // Verify the handle maps to this object, not a caller-selected different object.
  matchesId: (relayId: string) => boolean;
  every: (callback: () => void, milliseconds: number) => () => void;
  after: (callback: () => void, milliseconds: number) => () => void;
}
interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  detach: () => void;
}
interface RelayEvent {
  generation: number;
  sequence: number;
  kind: "reset" | "title" | "stopped";
  title?: string;
  receivedAt: number;
}
const encoder = new TextEncoder();
const noCache = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };
function failure(status: number): Response {
  return new Response(null, { status, headers: noCache });
}

// One instance per opaque listener handle. No module-global request rendezvous.
export class RelayCore {
  private record?: RelayRecord;
  private readonly ready: Promise<void>;
  private readonly subscribers = new Set<Subscriber>();
  private sequence = 0;
  private latest?: RelayEvent;
  private upstreamAbort?: AbortController;
  private upstreamReader?: ReadableStreamDefaultReader<Uint8Array>;
  private audioController?: ReadableStreamDefaultController<Uint8Array>;
  private audioDetach?: () => void;
  private initializing = false;
  private lastSessionCheck = 0;
  private cancelSessionTimer?: () => void;
  private sessionCheck?: Promise<boolean>;

  constructor(private readonly deps: RelayDependencies) {
    this.ready = this.restore();
  }

  private async restore(): Promise<void> {
    this.record = await this.deps.storage.get();
    // Never reopen a connection or replay an old title after object restart.
    if (this.record && this.record.phase !== "ended") {
      this.record.generation++;
      await this.end();
    } else if (this.record) {
      // Recovery also repairs a lost cleanup alarm. Never extend retention.
      await this.cleanup();
    }
  }

  private async cleanup(): Promise<void> {
    if (!this.record || this.record.phase !== "ended") return;
    if (this.deps.now() >= this.record.expiresAt) {
      await this.deps.storage.deleteAll();
      this.record = undefined;
    } else await this.deps.storage.setAlarm(this.record.expiresAt);
  }

  private scheduleSessionCheck(startedAt: number): void {
    this.cancelSessionTimer?.();
    this.cancelSessionTimer = this.deps.after(() => {
      void this.checkSession().catch(() => { /* end() already fails closed locally */ });
    }, Math.max(0, startedAt + SESSION_INTERVAL_MS - this.deps.now()));
  }

  private checkSession(): Promise<boolean> {
    if (this.sessionCheck) return this.sessionCheck;
    const record = this.record;
    if (!record || record.phase === "ended") return Promise.resolve(false);
    const startedAt = this.deps.now();
    const checking = (async () => {
      let valid = false;
      try {
        valid = await boundedRpc(this.deps.rpc, "web_session_check", {
          p_session_hash: record.sessionHash, p_now: new Date(startedAt).toISOString(),
        }, this.deps.after);
      } catch { /* DB failure or 3s timeout terminates both streams */ }
      if (record !== this.record || record.phase === "ended") return false;
      if (!valid) { await this.end(); return false; }
      this.lastSessionCheck = startedAt;
      this.scheduleSessionCheck(startedAt);
      return true;
    })();
    this.sessionCheck = checking;
    void checking.finally(() => { if (this.sessionCheck === checking) this.sessionCheck = undefined; }).catch(() => {});
    return checking;
  }

  private async enforceSessionDeadline(): Promise<void> {
    if (this.record?.phase !== "ended" && this.deps.now() - this.lastSessionCheck >= SESSION_MAX_AGE_MS) await this.end();
  }

  private save(): Promise<void> {
    return this.deps.storage.put({ ...this.record! });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    const relayId = request.headers.get("x-relay-id") ?? "";
    const owner = request.headers.get("x-relay-owner") ?? "";
    if (url.origin !== "https://relay.internal" || url.search || !RELAY_ID.test(relayId) ||
        !RELAY_ID.test(owner) || !this.deps.matchesId(relayId)) return failure(403);
    if (url.pathname === "/init" && request.method === "POST") {
      // Single-use while retained; the creation prefix rejects old INITs even
      // after deleteAll(). It is freshness, not authentication or a SQL lease.
      if (this.record) return failure(409);
      const createdAt = relayCreatedAt(relayId);
      if (createdAt > this.deps.now() || this.deps.now() - createdAt >= INIT_TTL_MS) return failure(410);
      const sessionHash = request.headers.get("x-relay-session-hash") ?? "";
      if (!RELAY_ID.test(sessionHash)) return failure(403);
      let body: unknown;
      try { body = await request.json(); } catch { return failure(400); }
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !("streamUrl" in body) || typeof body.streamUrl !== "string") return failure(400);
      let streamUrl: string;
      try { streamUrl = safeStreamUrl(body.streamUrl).href; } catch { return failure(403); }
      // Recheck after the body await. Reserve before storage awaits.
      if (this.record) return failure(409);
      if (this.deps.now() - createdAt >= INIT_TTL_MS) return failure(410);
      this.initializing = true;
      this.record = { relayId, owner, sessionHash, streamUrl, generation: 1, phase: "waiting", expiresAt: createdAt + INIT_TTL_MS };
      try {
        await this.save();
        await this.deps.storage.setAlarm(this.record.expiresAt);
        if (!await this.checkSession()) return failure(401);
        if (this.record.phase === "ended" || this.deps.now() >= this.record.expiresAt) {
          await this.end(); return failure(410);
        }
        return failure(201);
      } catch (error) {
        // Failed persistence/setup must not leave a playable in-memory record.
        await this.end().catch(() => {});
        throw error;
      } finally { this.initializing = false; }
    }
    if (!this.record || this.record.relayId !== relayId || this.record.owner !== owner) return failure(404);
    if (this.initializing) return failure(409);
    if (this.record.phase === "ended") {
      if (this.deps.now() >= this.record.expiresAt) { await this.cleanup(); return failure(404); }
    } else {
      if (this.deps.now() >= this.record.expiresAt) await this.end();
      await this.enforceSessionDeadline();
    }
    if (url.pathname === "/stop" && request.method === "POST") { await this.end(); return failure(204); }
    if (request.method !== "GET") return failure(405);
    if (url.pathname === "/events") return this.events(request);
    if (url.pathname === "/audio") return this.audio(request);
    return failure(404);
  }

  async alarm(): Promise<void> {
    await this.ready;
    if (!this.record) return;
    if (this.record.phase === "ended") { await this.cleanup(); return; }
    if (this.deps.now() < this.record.expiresAt) {
      await this.deps.storage.setAlarm(this.record.expiresAt);
      return;
    }
    await this.end();
  }

  private event(kind: RelayEvent["kind"], title?: string): RelayEvent {
    return { generation: this.record!.generation, sequence: ++this.sequence, kind, receivedAt: this.deps.now(), ...(title === undefined ? {} : { title }) };
  }

  private send(subscriber: Subscriber, event: RelayEvent): void {
    if ((subscriber.controller.desiredSize ?? 0) <= 0) {
      subscriber.controller.error(new Error("Slow relay event subscriber"));
      subscriber.detach();
      return;
    }
    if (event.kind !== "stopped" && this.deps.now() - this.lastSessionCheck >= SESSION_MAX_AGE_MS) {
      void this.end().catch(() => {});
      return;
    }
    subscriber.controller.enqueue(encoder.encode(
      `id: ${event.generation}:${event.sequence}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
    ));
  }

  private publish(event: RelayEvent): void {
    for (const subscriber of this.subscribers) this.send(subscriber, event);
  }

  private events(request: Request): Response {
    if (this.record!.phase === "ended") return failure(410);
    if (this.subscribers.size >= MAX_SUBSCRIBERS) return failure(429);
    if (request.signal.aborted) return failure(499);
    let subscriber: Subscriber;
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        const abort = () => { controller.error(new Error("Relay events disconnected")); subscriber.detach(); };
        const heartbeat = this.deps.every(() => {
          if ((controller.desiredSize ?? 0) <= 0) {
            controller.error(new Error("Slow relay event subscriber"));
            subscriber.detach();
          } else controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15_000);
        subscriber = { controller, detach: () => {
          this.subscribers.delete(subscriber);
          heartbeat();
          request.signal.removeEventListener("abort", abort);
        } };
        this.subscribers.add(subscriber);
        request.signal.addEventListener("abort", abort, { once: true });
        // Always reset before latest; Last-Event-ID cannot suppress generation reset.
        this.send(subscriber, { generation: this.record!.generation, sequence: 0, kind: "reset", receivedAt: this.deps.now() });
        if (this.latest) this.send(subscriber, this.latest);
      },
      cancel: () => subscriber.detach(),
    }, { highWaterMark: MAX_EVENT_QUEUE });
    return new Response(stream, { headers: { ...noCache, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" } });
  }

  private async audio(request: Request): Promise<Response> {
    if (this.record!.phase !== "waiting") return failure(this.record!.phase === "ended" ? 410 : 409);
    if (request.signal.aborted) { await this.end(); return failure(499); }
    this.record!.phase = "opening"; // reserve before any await: at most one upstream
    const generation = this.record!.generation;
    const abort = new AbortController();
    this.upstreamAbort = abort;
    const disconnected = () => { void this.end(); };
    request.signal.addEventListener("abort", disconnected, { once: true });
    this.audioDetach = () => request.signal.removeEventListener("abort", disconnected);
    const clearTimeout = this.deps.after(() => abort.abort(), 10_000);
    try {
      await this.save();
      if (abort.signal.aborted || this.record!.phase !== "opening") {
        clearTimeout();
        return failure(410);
      }
      const response = await fetchStationStream(this.record!.streamUrl, this.deps.network, abort.signal);
      clearTimeout();
      await this.enforceSessionDeadline();
      if (abort.signal.aborted || this.record!.phase !== "opening") {
        await response.body?.cancel();
        await this.end();
        return failure(410);
      }
      let interval: number | null;
      try { interval = parseInterval(response.headers.get("icy-metaint")); }
      catch (error) { await response.body?.cancel(); throw error; }
      const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (!type || !["audio/mpeg", "audio/aac", "audio/aacp", "audio/ogg", "application/ogg"].includes(type)) {
        await response.body?.cancel();
        throw new Error("Unsupported station content type");
      }
      this.record!.phase = "playing";
      this.record!.expiresAt = this.deps.now() + AUDIO_TTL_MS;
      await this.save();
      await this.deps.storage.setAlarm(this.record!.expiresAt);
      if (abort.signal.aborted || this.record!.phase !== "playing") {
        await response.body?.cancel();
        return failure(410);
      }
      const reader = response.body!.getReader();
      this.upstreamReader = reader;
      const parser = new IcyParser(interval, title => {
        if (this.record!.phase !== "playing" || generation !== this.record!.generation) return;
        this.latest = this.event("title", title);
        this.publish(this.latest);
      });
      const audio = new ReadableStream<Uint8Array>({
        start: controller => { this.audioController = controller; },
        pull: async controller => {
          try {
            await this.enforceSessionDeadline();
            if (this.record!.phase !== "playing") return;
            const part = await reader.read();
            await this.enforceSessionDeadline();
            if (this.record!.phase !== "playing" || generation !== this.record!.generation) return;
            if (part.done) {
              this.audioController = undefined;
              controller.close();
              await this.end();
              return;
            }
            if (part.value.byteLength > MAX_AUDIO_CHUNK) throw new Error("Upstream chunk limit");
            const chunks = parser.push(part.value);
            const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
            if (size) {
              const output = new Uint8Array(size);
              let offset = 0;
              for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
              controller.enqueue(output);
            }
          } catch { await this.end(); }
        },
        cancel: () => {
          this.audioController = undefined;
          return this.end();
        },
      }, { highWaterMark: 0 }); // no read-ahead: audio demand drives metadata
      return new Response(audio, { headers: { ...noCache, "Content-Type": type } });
    } catch {
      clearTimeout();
      await this.end();
      return failure(502);
    }
  }

  private async end(): Promise<void> {
    if (!this.record || this.record.phase === "ended") return;
    this.record.phase = "ended";
    this.record.expiresAt = this.deps.now() + TOMBSTONE_TTL_MS;
    this.record.streamUrl = "";
    this.cancelSessionTimer?.();
    this.cancelSessionTimer = undefined;
    this.latest = undefined;
    this.upstreamAbort?.abort();
    const reader = this.upstreamReader;
    this.upstreamReader = undefined;
    this.audioDetach?.();
    this.audioDetach = undefined;
    this.audioController?.error(new Error("Relay ended"));
    this.audioController = undefined;
    this.publish(this.event("stopped"));
    for (const subscriber of this.subscribers) { subscriber.controller.close(); subscriber.detach(); }
    // Local teardown precedes all persistence/network awaits. A broken database
    // cannot hold audio or SSE open. Failed release expires in SQL independently.
    const cancellation = reader?.cancel().catch(() => {});
    try {
      await this.save();
      await this.deps.storage.setAlarm(this.record.expiresAt);
    } finally {
      // Release even when storage/alarm fails. SQL expiry is the final fallback.
      await boundedRpc(this.deps.rpc, "web_relay_release", {
        p_session_hash: this.record.sessionHash, p_relay_id: this.record.relayId,
      }, this.deps.after).catch(() => false);
      await cancellation;
    }
  }
}
