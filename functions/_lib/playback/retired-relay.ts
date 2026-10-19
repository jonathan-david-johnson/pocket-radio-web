import { json } from "../auth/http";
// Kept as explicit tombstones so old links cannot reach the retired relay (ADR 0006).
export function retiredRelay(): Response {
  return json({ error: "relay_retired", mode: "direct_https" }, 410);
}
