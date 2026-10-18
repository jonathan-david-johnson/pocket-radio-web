export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY?: string;
  PC_API_ENVIRONMENT?: string;
  PC_CLIENT_ID?: string;
  PC_CLIENT_SECRET?: string;
  // Legacy offline relay fixtures only. Active routes return 410; no deployed binding.
  RELAY_HUB?: DurableObjectNamespace;
}

export interface SessionIdentity {
  userUuid: string;
  sessionHash: string;
}
