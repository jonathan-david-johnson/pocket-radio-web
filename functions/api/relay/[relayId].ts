import type { Env } from "../../_lib/env";
import { accessRelay } from "../../_lib/relay/routes";
export const onRequest: PagesFunction<Env> = context => accessRelay(context.request, context.env, String(context.params.relayId), "audio");
