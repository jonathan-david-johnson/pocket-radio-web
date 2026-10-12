import type { Env } from "../env";

export interface AuthRuntime {
  now: () => number;
  random: () => string;
  hash: (value: string) => Promise<string>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response");
  return value as Record<string, unknown>;
}
export function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function opaque(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
export function email(value: unknown): value is string {
  return typeof value === "string" && value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value);
}
export function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
}
export function seconds(value: unknown, max: number): number {
  // Protobuf JSON may represent integer values as strings. No coercion of other types.
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0 || n > max) throw new Error("Invalid lifetime");
  return n;
}
export async function readJson(response: Response, limit = 32_768): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    await response.body?.cancel();
    throw new Error("Expected JSON");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error("Response too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createRuntime(env: Env): AuthRuntime {
  const fetchBounded: AuthRuntime["fetch"] = (input, init) => fetch(input, {
    ...init, redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  return {
    now: () => Date.now(),
    random: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    },
    hash: async value => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    },
    fetch: fetchBounded,
    rpc: async (name, args) => {
      if (!/^web_[a-z_]+$/.test(name)) throw new Error("Invalid operation");
      const url = new URL(env.SUPABASE_URL);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("Invalid database configuration");
      }
      url.pathname = `/rest/v1/rpc/${name}`;
      const response = await fetchBounded(url.href, {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json", Accept: "application/json",
        },
        body: JSON.stringify(args),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Storage unavailable"); }
      return readJson(response);
    },
  };
}
