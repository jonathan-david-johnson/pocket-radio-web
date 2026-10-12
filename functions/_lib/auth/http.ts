import { opaque } from "./runtime";

export const SESSION_COOKIE = "__Host-pr-session";
export const PAIR_COOKIE = "__Host-pr-pair";
export const BROWSER_COOKIE = "__Host-pr-browser";
export const SESSION_SECONDS = 90 * 24 * 60 * 60;

export function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header || header.length > 8192) return null;
  const matches = header.split(";").map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return opaque(value) ? value : null;
}
export function setCookie(response: Response, name: string, value: string, maxAge: number): void {
  response.headers.append("Set-Cookie", `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`);
}
export function clearCookie(response: Response, name: string): void { setCookie(response, name, "", 0); }
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", Vary: "Cookie, Origin, Sec-Fetch-Site",
  } });
}
export function sameOrigin(request: Request, mutation: boolean): boolean {
  const url = new URL(request.url);
  if (url.protocol !== "https:") return false;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin === url.origin;
  // Same-origin browser GET fetches commonly omit Origin. Mutating GET polls
  // must instead carry Sec-Fetch-Site: same-origin; missing both fails closed.
  return mutation ? site === "same-origin" : true;
}
