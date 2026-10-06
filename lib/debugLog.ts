import { supabase } from "@/lib/supabase";

export type DebugEntryType =
  | "tool_call"
  | "tool_result"
  | "summary_generated"
  | "summary_gap_filled"
  | "context_loaded"
  | "error"
  | "cache_usage"
  | "model_used"
  | "timing"
  | "guard_fired"
  | "wearable_sync"
  | "morning_chain"
  | "opener_claim";

export interface DebugEntry {
  timestamp: string;
  type: DebugEntryType;
  data: Record<string, unknown>;
}

export function pushLog(type: DebugEntryType, data: Record<string, unknown>) {
  try {
    supabase
      .from("debug_log")
      .insert({ type, data, timestamp: new Date().toISOString() })
      .then(({ error }) => {
        if (error) console.error("[debugLog] insert failed:", error.message);
      });
  } catch {
    // Silently fail — debug log must never break the app
  }
}

/**
 * Awaited variant for background work (waitUntil): the last entry of a chain
 * must land before the function is released, so it is awaited rather than
 * fire-and-forget. Still never throws.
 */
export async function pushLogAsync(
  type: DebugEntryType,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await supabase
      .from("debug_log")
      .insert({ type, data, timestamp: new Date().toISOString() });
    if (error) console.error("[debugLog] insert failed:", error.message);
  } catch {
    // Silently fail — debug log must never break the app
  }
}

export async function getLog(): Promise<DebugEntry[]> {
  const { data, error } = await supabase
    .from("debug_log")
    .select("timestamp, type, data")
    .order("timestamp", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[debugLog] getLog failed:", error.message);
    return [];
  }

  return (data ?? []).map((row: { timestamp: string; type: string; data: Record<string, unknown> }) => ({
    timestamp: row.timestamp,
    type: row.type as DebugEntryType,
    data: row.data,
  }));
}

export async function clearLog(): Promise<void> {
  const { error } = await supabase.from("debug_log").delete().not("id", "is", null);
  if (error) console.error("[debugLog] clearLog failed:", error.message);
}
