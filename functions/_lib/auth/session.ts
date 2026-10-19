import type { Env, SessionIdentity } from "../env";
import { cookie, SESSION_COOKIE } from "./http";
import { createRuntime, object, uuid, type AuthRuntime } from "./runtime";

export function createSessionValidator(runtime: AuthRuntime) {
  return async (request: Request): Promise<SessionIdentity | null> => {
    const handle = cookie(request, SESSION_COOKIE);
    if (!handle) return null;
    try {
      const sessionHash = await runtime.hash(handle);
      const value = await runtime.rpc("web_session_roll", {
        p_session_hash: sessionHash, p_now: new Date(runtime.now()).toISOString(),
      });
      if (value === null) return null;
      const row = object(value);
      if (!uuid(row.user_uuid)) return null;
      return { userUuid: row.user_uuid.toLowerCase(), sessionHash };
    } catch { return null; }
  };
}

// ADR 0002/0003: identity is read only from service-role secret storage.
// Rolls the database expiry; /api/session renews the browser cookie on visits.
// This seam never returns tokens and never trusts x-user-uuid or a request body.
export async function requireSession(request: Request, env: Env): Promise<SessionIdentity | null> {
  return createSessionValidator(createRuntime(env))(request);
}
