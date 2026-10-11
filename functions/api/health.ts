export const onRequestGet = (() =>
  Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
) satisfies PagesFunction;
