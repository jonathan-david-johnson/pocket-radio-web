// Browser and server URL policy for direct playback (ADR 0006).
export const STATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class DirectStreamError extends Error {
  constructor(readonly code: "https_required" | "unsafe_stream_url") { super(code); }
}
export function directStreamUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\\") || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new DirectStreamError("unsafe_stream_url");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new DirectStreamError("unsafe_stream_url"); }
  if (url.protocol === "http:") throw new DirectStreamError("https_required");
  const host = url.hostname;
  // No literal IPs, single-label/local/reserved names, credentials or nonstandard ports.
  // This validates URL syntax, not DNS answers or subsequent browser redirects.
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
      host.length > 253 || /^[0-9.]+$/.test(host) ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) ||
      host.split(".").some(label => label.length > 63) ||
      /\.(localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(host)) {
    throw new DirectStreamError("unsafe_stream_url");
  }
  return url.href;
}
