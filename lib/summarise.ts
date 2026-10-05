import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/lib/supabase";
import { pushLog } from "@/lib/debugLog";
import { SUMMARISE, ADAPTIVE_THINKING, SUMMARISE_EFFORT } from "@/lib/models";
import { flagIncompleteStop, thinkingTokensOf } from "@/lib/model-response";
import { getWeekStartMondayUtc } from "@/lib/context";
import { loadSummariserSystemPrompt } from "@/prompts/manifest";

const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export function addUtcCalendarDays(ymd: string, deltaDays: number): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y!, mo! - 1, d!));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export async function hasSummaryForDate(
  athleteId: string,
  date: string
): Promise<boolean> {
  const { data } = await supabase
    .from("daily_summaries")
    .select("date")
    .eq("athlete_id", athleteId)
    .eq("date", date)
    .limit(1);
  return (data ?? []).length > 0;
}

export type GeneratedSummary = {
  summary: string;
  stopReason: Anthropic.Messages.StopReason | null;
  // false on stop_reason max_tokens or refusal (already logged) — never insert
  complete: boolean;
  thinkingTokens: number | null;
  outputTokens: number;
  contextMs: number;
  apiMs: number;
};

/**
 * Builds the summariser request for one date and calls the model. No DB
 * writes — summariseMissing inserts the result. Null when the date has
 * nothing to summarise.
 */
export async function generateSummary(
  anthropic: Anthropic,
  summariserSystemPrompt: string,
  athleteId: string,
  date: string
): Promise<GeneratedSummary | null> {
  // Fetch all data for this date in parallel
  const contextStart = Date.now();
  const [messagesResult, runsResult, setsResult, profileResult] = await Promise.all([
    supabase
      .from("messages")
      .select("tab, role, content")
      .eq("athlete_id", athleteId)
      .eq("date", date)
      .order("timestamp", { ascending: true }),
    supabase
      .from("runs")
      .select("*")
      .eq("athlete_id", athleteId)
      .eq("date", date),
    supabase
      .from("sets")
      .select("*")
      .eq("athlete_id", athleteId)
      .eq("date", date),
    supabase
      .from("athlete_profile")
      .select("content")
      .eq("athlete_id", athleteId)
      .order("timestamp", { ascending: false })
      .limit(1)
      .single(),
  ]);
  const contextMs = Date.now() - contextStart;

  // Format user message content
  const sections: string[] = [];

  const profile = profileResult.data?.content ?? "";
  if (profile) {
    sections.push(`ATHLETE PROFILE:\n${profile}`);
  }

  const messages = messagesResult.data ?? [];
  if (messages.length > 0) {
    const formatted = messages
      .map(
        (m: { tab: string; role: string; content: string }) =>
          `[${m.tab}] ${m.role}: ${m.content}`
      )
      .join("\n");
    sections.push(`MESSAGES:\n${formatted}`);
  }

  const runs = runsResult.data ?? [];
  if (runs.length > 0) {
    sections.push(`RUNS:\n${JSON.stringify(runs, null, 2)}`);
  }

  const sets = setsResult.data ?? [];
  if (sets.length > 0) {
    sections.push(`SETS:\n${JSON.stringify(sets, null, 2)}`);
  }

  if (sections.length === 0) return null;


  const apiStart = Date.now();
  const response = await anthropic.messages.create({
    model: SUMMARISE,
    // Covers adaptive thinking plus the summary — at 500, thinking could
    // truncate or empty the summary
    max_tokens: 4000,
    thinking: ADAPTIVE_THINKING,
    output_config: { effort: SUMMARISE_EFFORT },
    system: [
      {
        type: "text",
        text: summariserSystemPrompt,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `DATE: ${date}\n\n${sections.join("\n\n")}`,
      },
    ],
  });
  const apiMs = Date.now() - apiStart;

  // Read by block type — responses can start with thinking blocks
  let summary = "";
  for (const block of response.content) {
    if (block.type === "text") summary += block.text;
  }

  return {
    summary,
    stopReason: response.stop_reason,
    complete: !flagIncompleteStop("summarise", response, { date }),
    thinkingTokens: thinkingTokensOf(response.usage),
    outputTokens: response.usage.output_tokens,
    contextMs,
    apiMs,
  };
}

export type SummariseResult = { generated: number; errors: number };

/**
 * Generates missing daily summaries for dates before `localDate`:
 * phase 1, up to three dates with messages but no summary (one model call
 * each); phase 2, gap-fill stubs for planned days with no activity (no
 * model call). Idempotent — existing summaries are never regenerated, and
 * the unique constraint on (athlete_id, date) backstops concurrent runs.
 * Shared by POST /api/summarise and the morning chain.
 */
export async function summariseMissing(
  athleteId: string,
  localDate: string
): Promise<SummariseResult> {
  let generated = 0;
  let errors = 0;

  // Find dates with messages but no daily_summary, excluding today
  const { data: messageDates } = await supabase
    .from("messages")
    .select("date")
    .eq("athlete_id", athleteId)
    .lt("date", localDate)
    .order("date", { ascending: false });

  if (!messageDates || messageDates.length === 0) {
    return { generated, errors };
  }

  // Deduplicate dates
  const uniqueDates = Array.from(
    new Set(messageDates.map((r: { date: string }) => r.date))
  );

  // Check which dates already have summaries
  const { data: existingSummaries } = await supabase
    .from("daily_summaries")
    .select("date")
    .eq("athlete_id", athleteId)
    .in("date", uniqueDates);

  const summarisedDates = new Set(
    (existingSummaries ?? []).map((r: { date: string }) => r.date)
  );

  const unsummarised = uniqueDates
    .filter((d) => !summarisedDates.has(d))
    .slice(0, 3);

  const anthropic = new Anthropic();
  const summariserSystemPrompt = await loadSummariserSystemPrompt();

  for (const date of unsummarised) {
    try {
      // Idempotency check — re-verify before generating
      if (await hasSummaryForDate(athleteId, date)) continue;

      const result = await generateSummary(
        anthropic,
        summariserSystemPrompt,
        athleteId,
        date
      );
      if (!result) continue;

      // Truncated or refused: already logged; skip so the next run retries
      if (!result.complete) {
        errors++;
        continue;
      }

      const summary = result.summary;
      if (summary) {
        const { error } = await supabase.from("daily_summaries").insert({
          athlete_id: athleteId,
          date,
          summary,
          timestamp: new Date().toISOString(),
        });

        if (error) {
          errors++;
          console.error(`[summarise] failed to write summary for ${date}:`, error.message);
          pushLog("error", { date, message: error.message });
        } else {
          generated++;
          pushLog("summary_generated", {
            date,
            context_ms: result.contextMs,
            api_ms: result.apiMs,
            stop_reason: result.stopReason,
            thinking_tokens: result.thinkingTokens,
            summaryText: summary.length > 200 ? summary.slice(0, 200) + "…" : summary,
          });
          console.log(`[summarise] generated summary for ${date}`);
        }
      }
    } catch (err) {
      errors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      pushLog("error", { date, message: errMsg });
      console.error(`[summarise] failed for ${date}:`, errMsg);
      // Continue to next date
    }
  }

  // Gap-fill: synthesise summaries for planned days with no activity
  const thisMonday = getWeekStartMondayUtc(localDate);
  const prevMonday = addUtcCalendarDays(thisMonday, -7);

  const { data: planRows } = await supabase
    .from("weekly_plans")
    .select("week_start, days")
    .eq("athlete_id", athleteId)
    .in("week_start", [thisMonday, prevMonday])
    .order("timestamp", { ascending: false });

  const latestByWeek = new Map<string, Record<string, { session_type?: string; notes?: string }>>();
  for (const row of (planRows ?? []) as Array<{
    week_start: string;
    days: Record<string, { session_type?: string; notes?: string }>;
  }>) {
    if (!latestByWeek.has(row.week_start)) {
      latestByWeek.set(row.week_start, row.days);
    }
  }

  const candidates: Array<{ date: string; sessionType: string | undefined }> = [];
  for (const [weekStart, days] of Array.from(latestByWeek)) {
    DAY_KEYS.forEach((key, i) => {
      const dayDate = addUtcCalendarDays(weekStart, i);
      if (dayDate >= localDate) return;
      candidates.push({ date: dayDate, sessionType: days?.[key]?.session_type });
    });
  }

  for (const { date, sessionType } of candidates) {
    try {
      const gapContextStart = Date.now();
      const [existingSummary, dayMessages, dayRuns, daySets] = await Promise.all([
        supabase
          .from("daily_summaries")
          .select("date")
          .eq("athlete_id", athleteId)
          .eq("date", date)
          .limit(1),
        supabase
          .from("messages")
          .select("date")
          .eq("athlete_id", athleteId)
          .eq("date", date)
          .limit(1),
        supabase
          .from("runs")
          .select("date")
          .eq("athlete_id", athleteId)
          .eq("date", date)
          .limit(1),
        supabase
          .from("sets")
          .select("date")
          .eq("athlete_id", athleteId)
          .eq("date", date)
          .limit(1),
      ]);
      const gapContextMs = Date.now() - gapContextStart;

      if ((existingSummary.data ?? []).length > 0) continue;
      if ((dayMessages.data ?? []).length > 0) continue;
      if ((dayRuns.data ?? []).length > 0) continue;
      if ((daySets.data ?? []).length > 0) continue;

      if (!sessionType) continue;
      const isRest = sessionType === "rest" || sessionType === "Rest";
      const summary = isRest
        ? "Rest day — planned."
        : `Planned ${sessionType} — no activity logged.`;

      const { error } = await supabase.from("daily_summaries").insert({
        athlete_id: athleteId,
        date,
        summary,
        timestamp: new Date().toISOString(),
      });

      if (error) {
        errors++;
        console.error(`[summarise] gap-fill failed for ${date}:`, error.message);
        pushLog("error", { date, message: error.message });
      } else {
        generated++;
        pushLog("summary_gap_filled", { date, summary, context_ms: gapContextMs });
        console.log(`[summarise] gap-filled summary for ${date}`);
      }
    } catch (err) {
      errors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      pushLog("error", { date, message: errMsg });
      console.error(`[summarise] gap-fill error for ${date}:`, errMsg);
    }
  }

  return { generated, errors };
}
