import type { Env } from "../env";
import { requireSession } from "../auth/session";
import { ownerCapability, randomRelayId, RELAY_ID, type NetworkFetch } from "./security";
import { resolveStation, StationError } from "./stations";
import { boundedRpc, createRelayRpc, type RelayRpc } from "./rpc";

export const privateHeaders = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };
export function problem(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: privateHeaders });
}

function permittedOrigin(request: Request, mutation: boolean): boolean {
  const origin = request.headers.get("origin");
  if (mutation && !origin) return false;
  if (origin && origin !== new URL(request.url).origin) return false;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

async function startBody(request: Request): Promise<string | null> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024) return null;
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const object = body as Record<string, unknown>;
    return Object.keys(object).length === 1 && typeof object.stationId === "string" ? object.stationId : null;
  } catch { return null; }
  finally { await reader.cancel(); }
}

async function internalRequest(
  request: Request, env: Env, relayId: string, sessionHash: string,
  operation: string, body?: string,
): Promise<Response> {
  const namespace = env.RELAY_HUB!;
  const headers = new Headers({
    "x-relay-id": relayId,
    "x-relay-owner": await ownerCapability(sessionHash, relayId),
  });
  if (operation === "init") headers.set("x-relay-session-hash", sessionHash);
  if (body) headers.set("content-type", "application/json");
  // Never forward browser cookies, Authorization, identity, range, or arbitrary headers.
  return namespace.get(namespace.idFromName(relayId)).fetch(new Request("https://relay.internal/" + operation, {
    method: operation === "init" || operation === "stop" ? "POST" : "GET",
    headers, body, signal: request.signal,
  }));
}

export async function startRelay(
  request: Request, env: Env, network: NetworkFetch = fetch,
  control: { rpc?: RelayRpc; now?: () => number } = {},
): Promise<Response> {
  if (request.method !== "POST") return problem(405, "method_not_allowed");
  if (!permittedOrigin(request, true)) return problem(403, "same_origin_required");
  if (new URL(request.url).search) return problem(400, "unexpected_query");
  const session = await requireSession(request, env);
  if (!session) return problem(401, "session_required");
  if (!env.RELAY_HUB) return problem(503, "relay_binding_missing");
  const stationId = await startBody(request);
  if (stationId === null) return problem(400, "station_id_only");
  try {
    const streamUrl = await resolveStation(stationId, network);
    const now = control.now ?? Date.now;
    const relayId = randomRelayId(now());
    const rpc = control.rpc ?? createRelayRpc(env);
    const lease = { p_session_hash: session.sessionHash, p_relay_id: relayId };
    // Atomic account-wide limits are enforced in service-role SQL, before any DO
    // lookup/storage/upstream. A lost admission reply is released as well.
    let initialized = false;
    try {
      if (!await boundedRpc(rpc, "web_relay_admit", { ...lease, p_now: new Date(now()).toISOString() })) {
        return problem(429, "relay_admission_denied");
      }
      const response = await internalRequest(request, env, relayId, session.sessionHash, "init", JSON.stringify({ streamUrl }));
      if (!response.ok) return problem(502, "relay_init_failed");
      initialized = true;
    } finally {
      if (!initialized) {
        // Failure here must not turn denied admission into success. SQL leases
        // expire independently if release cannot reach the database.
        await boundedRpc(rpc, "web_relay_release", lease).catch(() => false);
      }
    }
    return Response.json({
      relayId, audioUrl: "/api/relay/" + relayId, eventsUrl: "/api/relay-events/" + relayId,
    }, { status: 201, headers: privateHeaders });
  } catch (error) {
    if (error instanceof StationError) return problem(error.status, error.code);
    return problem(502, "relay_start_failed");
  }
}

export async function accessRelay(
  request: Request, env: Env, relayId: string, operation: "audio" | "events" | "stop",
): Promise<Response> {
  if (request.method !== (operation === "stop" ? "POST" : "GET")) return problem(405, "method_not_allowed");
  if (!permittedOrigin(request, operation === "stop")) return problem(403, "same_origin_required");
  if (new URL(request.url).search || !RELAY_ID.test(relayId)) return problem(400, "invalid_relay_handle");
  const session = await requireSession(request, env);
  if (!session) return problem(401, "session_required");
  if (!env.RELAY_HUB) return problem(503, "relay_binding_missing");
  try { return await internalRequest(request, env, relayId, session.sessionHash, operation); }
  catch { return problem(502, "relay_unavailable"); }
}
