import "server-only";
import { getServiceClient } from "./supabase-service";

/**
 * Full record of one chat turn, stored in turn_records (RLS deny-all,
 * service-role only). Assembled in memory by /api/chat and inserted after
 * the stream closes via waitUntil. Thinking text is deliberately excluded.
 * Rows older than 30 days are removed daily by the pg_cron job
 * `turn_records_cleanup`.
 */

export type TurnToolCall = {
  round: number;
  // Position of the tool_use block within its round
  index: number;
  name: string;
  input: unknown;
  result: string;
};

export type TurnRound = {
  round: number;
  api_ms: number;
  tools_ms: number;
  tools: number;
  text_chars?: number;
  thinking_tokens?: number | null;
  // Reply text the model wrote in this round (all rounds are persisted)
  text?: string;
};

export type TurnTiming = {
  context_ms: number;
  first_token_ms: number | null;
  tool_rounds: number;
  rounds: TurnRound[];
  total_ms: number;
  error?: string;
};

export type TurnUsageRound = {
  round: number;
  input_tokens: number;
  output_tokens: number;
  // From usage.output_tokens_details; null when the model didn't report it
  thinking_tokens: number | null;
  cache_read: number;
  cache_write: number;
};

export type TurnUsage = {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read: number;
  cache_write: number;
  rounds: TurnUsageRound[];
};

export type TurnRecordInsert = {
  athlete_id: string;
  tab: string;
  date: string;
  user_message: string;
  context_block: string;
  tool_calls: TurnToolCall[];
  final_message: string | null;
  model: string;
  timing: TurnTiming;
  usage: TurnUsage;
};

export type TurnRecord = TurnRecordInsert & { id: string; created_at: string };

export type TurnRecordSummary = Pick<
  TurnRecord,
  "id" | "tab" | "date" | "created_at" | "user_message" | "model" | "timing"
>;

/** Never throws — a failed record must not affect the turn. */
export async function insertTurnRecord(record: TurnRecordInsert): Promise<void> {
  const svc = getServiceClient();
  if (!svc) return;
  try {
    const { error } = await svc.from("turn_records").insert(record);
    if (error) console.error("[turnRecords] insert failed:", error.message);
  } catch (err) {
    console.error("[turnRecords] insert threw:", err);
  }
}

export async function listTurnRecords(limit = 100): Promise<TurnRecordSummary[]> {
  const svc = getServiceClient();
  if (!svc) return [];
  const { data, error } = await svc
    .from("turn_records")
    .select("id, tab, date, created_at, user_message, model, timing")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[turnRecords] list failed:", error.message);
    return [];
  }
  return (data ?? []) as TurnRecordSummary[];
}

export async function getTurnRecord(id: string): Promise<TurnRecord | null> {
  const svc = getServiceClient();
  if (!svc) return null;
  const { data, error } = await svc
    .from("turn_records")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[turnRecords] get failed:", error.message);
    return null;
  }
  return (data as TurnRecord | null) ?? null;
}
