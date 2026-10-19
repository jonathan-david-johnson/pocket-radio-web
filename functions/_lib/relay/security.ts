// Exact, station-operator-controlled hosts only. No suffix matching or user configuration.
// This is a restricted spike, NOT arbitrary radio-browser SSRF protection (ADR 0004).
export const APPROVED_STREAM_HOSTS = new Set(["ice1.somafm.com", "ice2.somafm.com"]);
export const RELAY_ID = /^[a-f0-9]{64}$/;
export const STATION_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function safeStreamUrl(input: string): URL {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.port || url.hash || !APPROVED_STREAM_HOSTS.has(url.hostname)) {
    throw new Error("Station upstream not approved");
  }
  return url;
}

// Timestamp routing prefix + 208 random bits. Expired INITs cannot resurrect an
// object after its tombstone has been deleted. This is not an identity assertion.
export function randomRelayId(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return now.toString(16).padStart(12, "0") + [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function relayCreatedAt(relayId: string): number {
  return RELAY_ID.test(relayId) ? Number.parseInt(relayId.slice(0, 12), 16) : NaN;
}

// Only the namespace binding can reach the class. Bind the internal capability to
// the authenticated session and handle, never a caller-supplied identity header.
export async function ownerCapability(sessionHash: string, relayId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify(["PocketRadio relay owner v1", sessionHash, relayId]),
  ));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export type NetworkFetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchStationStream(
  input: string, network: NetworkFetch, signal: AbortSignal,
): Promise<Response> {
  let url = safeStreamUrl(input);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await network(url.href, {
      method: "GET", redirect: "manual", signal,
      headers: { "Icy-MetaData": "1", "Accept-Encoding": "identity", "User-Agent": "PocketRadio-Web/0.1" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hop === 3) throw new Error("Invalid station redirect");
      url = safeStreamUrl(new URL(location, url).href);
      continue;
    }
    if (response.status !== 200 || !response.body ||
        (response.headers.get("content-encoding") ?? "identity") !== "identity") {
      await response.body?.cancel();
      throw new Error("Invalid station response");
    }
    return response;
  }
  throw new Error("Station redirect limit");
}
