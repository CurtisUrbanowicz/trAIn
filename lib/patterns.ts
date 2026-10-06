import "server-only";
import { supabase } from "./supabase";

/**
 * athlete_patterns: the weekly-maintained, evidence-backed long-term picture
 * of the athlete — three to five verified patterns plus a training arc,
 * written by the patterns reflection pass through write_patterns. Append-only;
 * the newest row is the current document. Shared by the chat context, the
 * reflection contexts, the reflect loop and the morning chain.
 */

export type PatternsRow = {
  id: string;
  content: string;
  // The latest daily summary the document was verified against
  through_date: string;
  timestamp: string;
};

export async function getLatestPatterns(
  athleteId: string
): Promise<PatternsRow | null> {
  const { data, error } = await supabase
    .from("athlete_patterns")
    .select("id, content, through_date, timestamp")
    .eq("athlete_id", athleteId)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as PatternsRow;
}

/**
 * The latest daily summary dated before `localDate` — the most recent one a
 * pass run on that date can have read (summaries are loaded with the same
 * bound). Null when none exist.
 */
export async function getLatestSummaryDateBefore(
  athleteId: string,
  localDate: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("daily_summaries")
    .select("date")
    .eq("athlete_id", athleteId)
    .lt("date", localDate)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.date as string;
}

/**
 * Idempotency for the pass: the current document already covers every
 * summary a run on `localDate` could read. Defined against the run date, so
 * a past-date run is judged against what existed then.
 */
export async function isPatternsCurrent(
  athleteId: string,
  localDate: string
): Promise<{
  current: boolean;
  latest: PatternsRow | null;
  latestSummaryDate: string | null;
}> {
  const [latest, latestSummaryDate] = await Promise.all([
    getLatestPatterns(athleteId),
    getLatestSummaryDateBefore(athleteId, localDate),
  ]);
  if (!latest) return { current: false, latest, latestSummaryDate };
  // Nothing to read yet, so nothing the document could be missing
  if (!latestSummaryDate) return { current: true, latest, latestSummaryDate };
  return {
    current: latest.through_date >= latestSummaryDate,
    latest,
    latestSummaryDate,
  };
}

/**
 * Morning-chain trigger: no document yet, or seven or more summaries dated
 * after the current document's through_date and before the wake date.
 */
export async function patternsDue(
  athleteId: string,
  wakeDate: string
): Promise<{ due: boolean; newSummaries: number; reason: string }> {
  const latest = await getLatestPatterns(athleteId);
  if (!latest) return { due: true, newSummaries: 0, reason: "no document yet" };
  const { count, error } = await supabase
    .from("daily_summaries")
    .select("date", { count: "exact", head: true })
    .eq("athlete_id", athleteId)
    .gt("date", latest.through_date)
    .lt("date", wakeDate);
  if (error) throw new Error(`patternsDue count failed: ${error.message}`);
  const n = count ?? 0;
  return {
    due: n >= 7,
    newSummaries: n,
    reason: `${n} summaries since ${latest.through_date}`,
  };
}

/** The context block, for the chat and reflection contexts alike. */
export function formatPatternsBlock(row: PatternsRow | null): string {
  if (!row) return "<athlete_patterns>\nNo patterns yet.\n</athlete_patterns>";
  return `<athlete_patterns through="${row.through_date}">\n${row.content}\n</athlete_patterns>`;
}
