import type { Env } from "../../_lib/env";
import { startRelay } from "../../_lib/relay/routes";
export const onRequest: PagesFunction<Env> = context => startRelay(context.request, context.env);
