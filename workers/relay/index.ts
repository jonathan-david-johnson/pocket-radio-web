import { RelayCore, type RelayRecord } from "./core";
import { createRelayRpc, type RelayDatabaseEnv } from "../../functions/_lib/relay/rpc";

interface RelayWorkerEnv extends RelayDatabaseEnv {
  RELAY_HUB: DurableObjectNamespace;
}

// Classic fetch-based class: the namespace has no public HTTP address.
// The default Worker never forwards ingress into it.
export class RelayHub implements DurableObject {
  private readonly core: RelayCore;

  constructor(state: DurableObjectState, env: RelayWorkerEnv) {
    this.core = new RelayCore({
      storage: {
        get: () => state.storage.get<RelayRecord>("relay"),
        put: record => state.storage.put("relay", record),
        setAlarm: at => state.storage.setAlarm(at),
        deleteAll: async () => {
          await state.storage.deleteAlarm();
          await state.storage.deleteAll();
        },
      },
      network: fetch,
      rpc: createRelayRpc(env),
      now: Date.now,
      matchesId: relayId => env.RELAY_HUB.idFromName(relayId).equals(state.id),
      every: (callback, milliseconds) => {
        const timer = setInterval(callback, milliseconds);
        return () => clearInterval(timer);
      },
      after: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      },
    });
    // Await constructor recovery behind the DO input gate, including tombstone writes.
    state.blockConcurrencyWhile(async () => {
      // A harmless invalid request waits for the core's restoration without mutation.
      await this.core.fetch(new Request("https://relay.internal/ready"));
    });
  }

  fetch(request: Request): Promise<Response> { return this.core.fetch(request); }
  alarm(): Promise<void> { return this.core.alarm(); }
}

export default {
  fetch(_request: Request): Response {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  },
} satisfies ExportedHandler<RelayWorkerEnv>;
