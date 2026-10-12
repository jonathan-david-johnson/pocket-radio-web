import { email, object, readJson, seconds, token, uuid, type AuthRuntime } from "./runtime";

const BASE = "https://api.pocketcasts.com/";
const ALLOWED_PATHS = new Set([
  "device/authorize", "user/token", "user/podcast/list", "user/podcast/episodes",
  "user/playlist/list", "user/named_settings/update",
]);
export const SCOPE = "mobile";

// Source contract: iOS Api_TokenLoginResponse and AuthenticationResponse.
// Protobuf JSON uses lowerCamelCase; servers may use the original snake_case
// names from api.pb.swift. Only these source-backed aliases are accepted.
function field(row: Record<string, unknown>, snake: string, camel: string): unknown {
  if (row[snake] !== undefined && row[camel] !== undefined && row[snake] !== row[camel]) {
    throw new Error("Conflicting response");
  }
  return row[snake] ?? row[camel];
}
export interface VerifiedGrant {
  userUuid: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
export function verifyGrant(value: unknown): VerifiedGrant {
  const row = object(value);
  const access = field(row, "access_token", "accessToken");
  const refresh = field(row, "refresh_token", "refreshToken");
  const type = field(row, "token_type", "tokenType");
  if (!uuid(row.uuid) || !email(row.email) || !token(access) || !token(refresh) ||
      typeof type !== "string" || type.toLowerCase() !== "bearer") throw new Error("Unverified identity");
  return {
    userUuid: row.uuid.toLowerCase(), email: row.email,
    accessToken: access, refreshToken: refresh,
    expiresIn: seconds(field(row, "expires_in", "expiresIn"), 365 * 86400),
  };
}
export async function pcRequest(runtime: AuthRuntime, path: string, body: unknown, access?: string): Promise<Response> {
  // Defense in depth: no sync writes, arbitrary URL, or arbitrary path even
  // if a future caller bypasses the probe handler's public allowlist.
  if (!ALLOWED_PATHS.has(path)) throw new Error("Unsupported upstream operation");
  return runtime.fetch(BASE + path, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "PocketRadio/1.0",
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
    }, body: JSON.stringify(body),
  });
}
export async function authorize(runtime: AuthRuntime) {
  const response = await pcRequest(runtime, "device/authorize", { scope: SCOPE });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Pairing unavailable"); }
  const row = object(await readJson(response));
  const deviceCode = field(row, "device_code", "deviceCode");
  const userCode = field(row, "user_code", "userCode");
  if (!token(deviceCode) || typeof userCode !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(userCode)) {
    throw new Error("Invalid pairing response");
  }
  return {
    deviceCode, userCode,
    expiresIn: Math.min(900, seconds(field(row, "expires_in", "expiresIn"), 86400)),
    interval: Math.max(5, seconds(row.interval, 60)),
  };
}
export type PollResult = { status: "approved"; grant: VerifiedGrant } | { status: "pending" | "slow_down" | "expired" | "error" };
export async function pollGrant(runtime: AuthRuntime, deviceCode: string): Promise<PollResult> {
  const response = await pcRequest(runtime, "user/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, scope: SCOPE,
  });
  const value = await readJson(response);
  if (response.ok) return { status: "approved", grant: verifyGrant(value) };
  const row = object(value);
  switch (row.error ?? row.errorMessageId) {
    case "authorization_pending": return { status: "pending" };
    case "slow_down": return { status: "slow_down" };
    case "expired_token": return { status: "expired" };
    default: return { status: "error" };
  }
}

export async function accessToken(runtime: AuthRuntime, sessionHash: string): Promise<string | null> {
  const lease = runtime.random();
  const args = { p_session_hash: sessionHash, p_lease: lease, p_now: new Date(runtime.now()).toISOString() };
  const claimed = await runtime.rpc("web_token_claim", args);
  if (claimed === null) return null;
  const row = object(claimed);
  const active = () => runtime.rpc("web_session_check", {
    p_session_hash: sessionHash, p_now: new Date(runtime.now()).toISOString(),
  });
  if (row.status === "ready") return token(row.access_token) && await active() === true ? row.access_token : null;
  if (row.status !== "refresh" || !uuid(row.user_uuid) || !token(row.refresh_token)) return null;
  try {
    const response = await pcRequest(runtime, "user/token", {
      grant_type: "refresh_token", refresh_token: row.refresh_token, scope: SCOPE,
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Refresh unavailable"); }
    const grant = verifyGrant(await readJson(response));
    if (grant.userUuid !== row.user_uuid.toLowerCase()) throw new Error("Identity mismatch");
    const result = await runtime.rpc("web_token_finish", {
      ...args, p_now: new Date(runtime.now()).toISOString(), p_user_uuid: grant.userUuid,
      p_email: grant.email, p_access_token: grant.accessToken, p_refresh_token: grant.refreshToken,
      p_expires_in: grant.expiresIn,
    });
    // A's refresh may save rotated credentials for B after A signs out.
    // Successful storage is not authorization for A to use those credentials.
    return result === true && await active() === true ? grant.accessToken : null;
  } catch {
    await runtime.rpc("web_token_release", { ...args, p_now: new Date(runtime.now()).toISOString() });
    return null;
  }
}
