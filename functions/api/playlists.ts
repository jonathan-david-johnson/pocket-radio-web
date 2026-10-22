import type { Env } from "../_lib/env";
import { createRuntime } from "../_lib/auth/runtime";
import { createPlaylistsHandler } from "../_lib/playlists/handler";

export const onRequest: PagesFunction<Env> = ({ request, env }) =>
  createPlaylistsHandler(createRuntime(env))(request);
