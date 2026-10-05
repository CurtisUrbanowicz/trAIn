import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ── Service-role client — server-only. Used for RLS deny-all tables
// (wearable_tokens, turn_records): the browser's anon key can never touch
// them. Null when the env var isn't set (e.g. local dev), in which case
// callers no-op.
// SUPABASE_SERVICE_ROLE_KEY is a new-format sb_secret_… key: supabase-js
// passes it through as the apikey header and the gateway maps it to
// service role (RLS bypass) — no JWT involved.
let serviceClient: SupabaseClient | null = null;
export function getServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!serviceClient) {
    serviceClient = createClient(url, key, {
      // Server-side key client: no user sessions, ever
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serviceClient;
}
