import type { Env } from "../../_lib/env";
import { createRuntime } from "../../_lib/auth/runtime";
import { sharedDatabase } from "../../_lib/layout/handler";
import { createCuratedStationsHandler } from "../../_lib/stations/curated";

export const onRequest: PagesFunction<Env> = ({ request, env }) =>
  createCuratedStationsHandler(createRuntime(env), sharedDatabase(env))(request);
