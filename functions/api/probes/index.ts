import type { Env } from "../../_lib/env";
import { createAuthHandlers } from "../../_lib/auth/handlers";
import { createRuntime } from "../../_lib/auth/runtime";

export const onRequest: PagesFunction<Env> = ({ request, env }) =>
  createAuthHandlers(createRuntime(env)).probes(request);
