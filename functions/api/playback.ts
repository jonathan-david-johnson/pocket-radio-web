import type { Env } from "../_lib/env";
import { json } from "../_lib/auth/http";
import { createRuntime } from "../_lib/auth/runtime";
import { createPlaybackHandler } from "../_lib/playback/routes";
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  try { return await createPlaybackHandler(createRuntime(env))(request); }
  catch { return json({ error: "playback_unavailable" }, 503); }
};
