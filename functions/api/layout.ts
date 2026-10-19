import type { Env } from "../_lib/env";
import { createRuntime } from "../_lib/auth/runtime";
import { createLayoutHandler, sharedDatabase } from "../_lib/layout/handler";

export const onRequest: PagesFunction<Env> = ({ request, env }) =>
  createLayoutHandler(createRuntime(env), sharedDatabase(env))(request);
