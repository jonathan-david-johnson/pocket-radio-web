import type { NetworkFetch } from "./security";

export const RPC_TIMEOUT_MS = 3_000;
export type RelayRpcName = "web_relay_admit" | "web_relay_release" | "web_session_check";
export type RelayRpc = (name: RelayRpcName, parameters: Record<string, string>, signal: AbortSignal) => Promise<boolean>;
export interface RelayDatabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}
export function createRelayRpc(env: RelayDatabaseEnv, network: NetworkFetch = fetch): RelayRpc {
  return async (name, parameters, signal) => {
    const base = new URL(env.SUPABASE_URL);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
        base.pathname !== "/" || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Relay database configuration invalid");
    const response = await network(new URL("/rest/v1/rpc/" + name, base).href, {
      method: "POST", redirect: "manual", signal,
      headers: {
        "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify(parameters),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Relay database unavailable"); }
    // These RPCs return a scalar boolean, not an identity assertion or session roll.
    if (!response.body) throw new Error("Relay database response invalid");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 64) throw new Error("Relay database response invalid");
        chunks.push(part.value);
      }
      const text = chunks.map(chunk => new TextDecoder().decode(chunk)).join("").trim();
      if (text !== "true" && text !== "false") throw new Error("Relay database response invalid");
      return text === "true";
    } finally { await reader.cancel(); }
  };
}

// Race even when an injected transport ignores abort. Never leave a relay waiting
// indefinitely on a database call. The timer is also injected by the DO tests.
export async function boundedRpc(
  rpc: RelayRpc, name: RelayRpcName, parameters: Record<string, string>,
  after: (callback: () => void, milliseconds: number) => () => void = (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
): Promise<boolean> {
  const abort = new AbortController();
  let cancel = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = after(() => { abort.abort(); reject(new Error("Relay database timeout")); }, RPC_TIMEOUT_MS);
  });
  try { return await Promise.race([rpc(name, parameters, abort.signal), deadline]); }
  finally { cancel(); abort.abort(); }
}
