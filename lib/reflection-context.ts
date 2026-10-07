import "server-only";
import { supabase } from "@/lib/supabase";
import {
  formatDate,
  formatTrainingState,
  getAthleteProfile,
  getContextIndexCounts,
  getRecentSummaries,
  getTrainingState,
  type ContextIndexCounts,
  type TrainingState,
} from "@/lib/context";
import {
  formatPatternsBlock,
  getLatestPatterns,
  getLatestSummaryDateBefore,
  type PatternsRow,
} from "@/lib/patterns";
import { loadReflectionSystemPrompt } from "@/prompts/manifest";

export type ReflectionContext = {
  systemPrompt: string;
  volatileBlock: string;
};

// pulse and deep write insights rows; patterns maintains athlete_patterns
export type ReflectionType = "pulse" | "deep" | "patterns";
export type InsightType = "pulse" | "deep";

type InsightRow = {
  date: string;
  significance: number;
  content: string;
};

async function getRecentInsights(
  athleteId: string,
  type: InsightType,
  limit: number
): Promise<InsightRow[]> {
  const { data, error } = await supabase
    .from("insights")
    .select("date, significance, content")
    .eq("athlete_id", athleteId)
    .eq("type", type)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data.map((row) => ({
    date: row.date,
    significance: row.significance,
    content: row.content,
  }));
}

function formatInsightsBlock(rows: InsightRow[]): string {
  if (rows.length === 0) return "None yet.";
  return rows
    .map((r) => `${formatDate(r.date)} — significance ${r.significance}\n${r.content}`)
    .join("\n\n");
}

function formatSummariesBlock(
  rows: { date: string; summary: string }[]
): string {
  if (rows.length === 0) return "None.";
  return rows
    .map((r) => `${formatDate(r.date)}\n${r.summary ?? ""}`)
    .join("\n\n");
}

function formatIndexLine(args: {
  label: string;
  count: number;
  unit: string;
  earliest: string | null;
  latest: string | null;
}): string {
  const e = args.earliest == null ? "none" : formatDate(args.earliest);
  const l = args.latest == null ? "none" : formatDate(args.latest);
  return `${args.label}: ${args.count} ${args.unit} from ${e} to ${l}`;
}

function formatContextIndex(ci: ContextIndexCounts): string {
  return [
    formatIndexLine({
      label: "Daily summaries",
      count: ci.summaries.count,
      unit: "entries",
      earliest: ci.summaries.earliest,
      latest: ci.summaries.latest,
    }),
    formatIndexLine({
      label: "Runs",
      count: ci.runs.count,
      unit: "sessions",
      earliest: ci.runs.earliest,
      latest: ci.runs.latest,
    }),
    formatIndexLine({
      label: "Sets",
      count: ci.sets.count,
      unit: "entries",
      earliest: ci.sets.earliest,
      latest: ci.sets.latest,
    }),
    `Mesocycles: ${ci.mesocycles.count} total`,
    `Weekly plans: ${ci.weeklyPlans.count} total`,
    `Exercise vocabulary: ${ci.exercises.length > 0 ? ci.exercises.join(", ") : "none yet"}`,
    `Run type vocabulary: ${ci.runTypes.length > 0 ? ci.runTypes.join(", ") : "none yet"}`,
  ].join("\n");
}

const EMPTY_RANGE = { count: 0, earliest: null, latest: null };
const EMPTY_CONTEXT_INDEX: ContextIndexCounts = {
  summaries: EMPTY_RANGE,
  runs: EMPTY_RANGE,
  sets: EMPTY_RANGE,
  mesocycles: { count: 0 },
  weeklyPlans: { count: 0 },
  exercises: [],
  runTypes: [],
};

/** Unwraps a settled load: the value, or the fallback after logging. */
function settled<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  label: string
): T {
  if (result.status === "fulfilled") return result.value;
  console.error(`[reflection-context] ${label} failed:`, result.reason);
  return fallback;
}

// Every pass reads the long-term picture and the exact recent shape of
// training, so it builds on them instead of restating them.
const BUILD_ON =
  " <athlete_patterns> is the verified long-term picture of this athlete and <training_state> the exact recent shape of training — build on them, don't restate them.";

const PULSE_INSTRUCTIONS =
  "You are running a reflection pass. Read the athlete profile, review prior insights so you don't restate them, and use the recent summaries as your primary source for this week. Verify any claim against raw data via get_history before calling log_insight." +
  BUILD_ON;

const DEEP_INSTRUCTIONS =
  "You are running a reflection pass. Read the athlete profile, review prior insights so you don't restate them, and use recent summaries for orientation only. The real investigation happens via get_history against raw tables. Use the context index to know what's available. Verify any claim against data before calling log_insight." +
  BUILD_ON;

const PATTERNS_INSTRUCTIONS =
  "You are maintaining the athlete's patterns document and reviewing the athlete profile. Read the profile, the current document in <athlete_patterns>, the recent deep insights and <training_state>. Re-verify every existing pattern against raw data via get_history, add at most one new pattern, then write the full document with write_patterns. Only after write_patterns has succeeded, review <athlete_profile> against <recent_summaries> and call update_athlete_profile only if a stated fact changed.";

function stableBlocks(
  instructions: string,
  profile: { content: string } | null,
  patterns: PatternsRow | null,
  trainingState: TrainingState | null
): string[] {
  return [
    `<context_instructions>\n${instructions}\n</context_instructions>`,
    `<athlete_profile>\n${profile?.content ?? "No profile on file."}\n</athlete_profile>`,
    formatPatternsBlock(patterns),
    formatTrainingState(trainingState),
  ];
}

function assemble(systemPrompt: string, stable: string[], volatile: string[]): ReflectionContext {
  return {
    systemPrompt: `${systemPrompt}\n\n<persistent_context>\n${stable.join("\n\n")}\n</persistent_context>`,
    volatileBlock: volatile.join("\n\n"),
  };
}

export async function buildPulseContext(
  athleteId: string,
  localDate: string
): Promise<ReflectionContext> {
  const [
    promptResult,
    profileResult,
    insightsResult,
    summariesResult,
    patternsResult,
    trainingStateResult,
  ] = await Promise.allSettled([
    loadReflectionSystemPrompt("pulse"),
    getAthleteProfile(athleteId),
    getRecentInsights(athleteId, "pulse", 3),
    getRecentSummaries(athleteId, localDate, 7),
    getLatestPatterns(athleteId),
    getTrainingState(athleteId, localDate),
  ]);

  const systemPrompt = settled(promptResult, "", "loadReflectionSystemPrompt(pulse)");
  const profile = settled(profileResult, null, "getAthleteProfile");
  const insights = settled(insightsResult, [], "getRecentInsights(pulse)");
  const summaries = settled(summariesResult, [], "getRecentSummaries");
  const patterns = settled(patternsResult, null, "getLatestPatterns");
  const trainingState = settled(trainingStateResult, null, "getTrainingState");

  const stable = stableBlocks(PULSE_INSTRUCTIONS, profile, patterns, trainingState);
  const volatile: string[] = [
    `<date>\n${formatDate(localDate)}\n</date>`,
    `<prior_pulse_insights count="${insights.length}">\n${formatInsightsBlock(insights)}\n</prior_pulse_insights>`,
    `<recent_summaries count="${summaries.length}">\n${formatSummariesBlock(summaries)}\n</recent_summaries>`,
  ];

  return assemble(systemPrompt, stable, volatile);
}

export async function buildDeepContext(
  athleteId: string,
  localDate: string
): Promise<ReflectionContext> {
  const [
    promptResult,
    profileResult,
    insightsResult,
    summariesResult,
    contextIndexResult,
    patternsResult,
    trainingStateResult,
  ] = await Promise.allSettled([
    loadReflectionSystemPrompt("deep"),
    getAthleteProfile(athleteId),
    getRecentInsights(athleteId, "deep", 5),
    getRecentSummaries(athleteId, localDate, 7),
    getContextIndexCounts(athleteId),
    getLatestPatterns(athleteId),
    getTrainingState(athleteId, localDate),
  ]);

  const systemPrompt = settled(promptResult, "", "loadReflectionSystemPrompt(deep)");
  const profile = settled(profileResult, null, "getAthleteProfile");
  const insights = settled(insightsResult, [], "getRecentInsights(deep)");
  const summaries = settled(summariesResult, [], "getRecentSummaries");
  const contextIndex = settled(contextIndexResult, EMPTY_CONTEXT_INDEX, "getContextIndexCounts");
  const patterns = settled(patternsResult, null, "getLatestPatterns");
  const trainingState = settled(trainingStateResult, null, "getTrainingState");

  const stable = stableBlocks(DEEP_INSTRUCTIONS, profile, patterns, trainingState);
  const volatile: string[] = [
    `<date>\n${formatDate(localDate)}\n</date>`,
    `<prior_deep_insights count="${insights.length}">\n${formatInsightsBlock(insights)}\n</prior_deep_insights>`,
    `<recent_summaries count="${summaries.length}">\n${formatSummariesBlock(summaries)}\n</recent_summaries>`,
    `<context_index>\n${formatContextIndex(contextIndex)}\n</context_index>`,
  ];

  return assemble(systemPrompt, stable, volatile);
}

/**
 * The patterns pass: profile, the current document, the last seven deep
 * insights (candidates to verify), training_state, the context index and the
 * week's daily summaries. Patterns are verified against raw tables; the
 * summaries are for the profile review that follows the write. The volatile
 * block names the through_date to pass, so it is never guessed.
 */
export async function buildPatternsContext(
  athleteId: string,
  localDate: string
): Promise<ReflectionContext> {
  const [
    promptResult,
    profileResult,
    insightsResult,
    summariesResult,
    contextIndexResult,
    patternsResult,
    trainingStateResult,
    latestSummaryResult,
  ] = await Promise.allSettled([
    loadReflectionSystemPrompt("patterns"),
    getAthleteProfile(athleteId),
    getRecentInsights(athleteId, "deep", 7),
    getRecentSummaries(athleteId, localDate, 7),
    getContextIndexCounts(athleteId),
    getLatestPatterns(athleteId),
    getTrainingState(athleteId, localDate),
    getLatestSummaryDateBefore(athleteId, localDate),
  ]);

  const systemPrompt = settled(promptResult, "", "loadReflectionSystemPrompt(patterns)");
  const profile = settled(profileResult, null, "getAthleteProfile");
  const insights = settled(insightsResult, [], "getRecentInsights(deep)");
  const summaries = settled(summariesResult, [], "getRecentSummaries");
  const contextIndex = settled(contextIndexResult, EMPTY_CONTEXT_INDEX, "getContextIndexCounts");
  const patterns = settled(patternsResult, null, "getLatestPatterns");
  const trainingState = settled(trainingStateResult, null, "getTrainingState");
  const latestSummary = settled(latestSummaryResult, null, "getLatestSummaryDateBefore");

  const throughDateLine = latestSummary
    ? `Latest daily summary: ${formatDate(latestSummary)}. Pass ${latestSummary} as through_date.`
    : `No daily summaries yet. Pass ${localDate} as through_date.`;

  const stable = stableBlocks(PATTERNS_INSTRUCTIONS, profile, patterns, trainingState);
  const volatile: string[] = [
    `<date>\n${formatDate(localDate)}\n</date>`,
    `<through_date>\n${throughDateLine}\n</through_date>`,
    `<recent_deep_insights count="${insights.length}">\n${formatInsightsBlock(insights)}\n</recent_deep_insights>`,
    `<recent_summaries count="${summaries.length}">\n${formatSummariesBlock(summaries)}\n</recent_summaries>`,
    `<context_index>\n${formatContextIndex(contextIndex)}\n</context_index>`,
  ];

  return assemble(systemPrompt, stable, volatile);
}
