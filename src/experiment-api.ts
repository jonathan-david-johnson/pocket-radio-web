export interface Pairing {
  userCode: string;
  pairingUri: string;
  expiresIn: number;
  interval: number;
}
export interface Relay {
  relayId: string;
  audioUrl: string;
  eventsUrl: string;
}
export type Session = { signedIn: false } | { signedIn: true; email: string };

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid API response");
  return value as Record<string, unknown>;
}
export function pairingResponse(value: unknown): Pairing {
  const data = record(value);
  if (typeof data.userCode !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(data.userCode) ||
      data.pairingUri !== `pktc://pair?user_code=${encodeURIComponent(data.userCode)}` ||
      !Number.isInteger(data.expiresIn) || Number(data.expiresIn) < 1 || Number(data.expiresIn) > 900 ||
      !Number.isInteger(data.interval) || Number(data.interval) < 5 || Number(data.interval) > 60) {
    throw new Error("Invalid Pairing response");
  }
  return data as unknown as Pairing;
}
export function relayResponse(value: unknown): Relay {
  const data = record(value);
  if (typeof data.relayId !== "string" || !/^[a-f0-9]{64}$/.test(data.relayId) ||
      data.audioUrl !== `/api/relay/${data.relayId}` || data.eventsUrl !== `/api/relay-events/${data.relayId}`) {
    throw new Error("Invalid relay response");
  }
  return data as unknown as Relay;
}
export function sessionResponse(value: unknown): Session {
  const data = record(value);
  if (data.signedIn === false) return { signedIn: false };
  if (data.signedIn !== true || typeof data.email !== "string" || data.email.length > 320) throw new Error("Invalid session response");
  return { signedIn: true, email: data.email };
}
export function retrySeconds(value: string | null, fallback: number): number {
  const seconds = value && /^\d+$/.test(value) ? Number(value) : fallback;
  return Math.max(5, Math.min(900, Number.isSafeInteger(seconds) ? seconds : fallback));
}
export async function api(path: string, init: RequestInit = {}): Promise<{ data: unknown; retryAfter: string | null }> {
  if (!path.startsWith("/api/") || path.startsWith("//") || path.includes("\\")) throw new Error("Same-origin API required");
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  // Browser fetch defaults to same-origin credentials; no cross-origin path is accepted.
  const response = await fetch(path, { ...init, redirect: "error", signal });
  if (!response.ok) throw new Error(`Request failed (${response.status}). Check server bindings and the experiment notes.`);
  return { data: await response.json(), retryAfter: response.headers.get("Retry-After") };
}
export function post(body?: unknown): RequestInit {
  return { method: "POST", ...(body === undefined ? {} : {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) };
}
