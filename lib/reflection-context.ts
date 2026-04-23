import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { supabase } from "@/lib/supabase";
import {
  formatDate,
  getAthleteProfile,
  getUserPreferences,
  getRecentSummaries,
  getContextIndexCounts,
  type ContextIndexCounts,
} from "@/lib/context";

export type ReflectionContext = {
  systemPrompt: string;
  contextBlock: string;
};

type ReflectionType = "pulse" | "deep";

const systemPromptCache = new Map<ReflectionType, string>();

async function loadReflectionPrompt(type: ReflectionType): Promise<string> {
  const hit = systemPromptCache.get(type);
  if (hit != null) return hit;

  const root = process.cwd();
  const promptPath = path.join(root, `${type}-brain.md`);
  const value = await fs.readFile(promptPath, "utf8");
  systemPromptCache.set(type, value);
  return value;
}

type InsightRow = {
  date: string;
  significance: number;
  content: string;
};

async function getRecentInsights(
  athleteId: string,
  type: ReflectionType,
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

const PULSE_INSTRUCTIONS =
  "You are running a reflection pass. Read your profile and preferences, review prior insights so you don't restate them, and use the recent summaries as your primary source for this week. Verify any claim against raw data via get_history before calling log_insight.";

const DEEP_INSTRUCTIONS =
  "You are running a reflection pass. Read your profile and preferences, review prior insights so you don't restate them, and use recent summaries for orientation only. The real investigation happens via get_history against raw tables. Use the context index to know what's available. Verify any claim against data before calling log_insight.";

export async function buildPulseContext(
  athleteId: string,
  localDate: string
): Promise<ReflectionContext> {
  const [
    promptResult,
    profileResult,
    preferencesResult,
    insightsResult,
    summariesResult,
  ] = await Promise.allSettled([
    loadReflectionPrompt("pulse"),
    getAthleteProfile(athleteId),
    getUserPreferences(athleteId),
    getRecentInsights(athleteId, "pulse", 3),
    getRecentSummaries(athleteId, localDate, 7),
  ]);

  const systemPrompt =
    promptResult.status === "fulfilled" ? promptResult.value : "";
  if (promptResult.status === "rejected") {
    console.error("[buildPulseContext] loadReflectionPrompt failed:", promptResult.reason);
  }

  const profile =
    profileResult.status === "fulfilled" ? profileResult.value : null;
  if (profileResult.status === "rejected") {
    console.error("[buildPulseContext] getAthleteProfile failed:", profileResult.reason);
  }

  const preferences =
    preferencesResult.status === "fulfilled" ? preferencesResult.value : null;
  if (preferencesResult.status === "rejected") {
    console.error("[buildPulseContext] getUserPreferences failed:", preferencesResult.reason);
  }

  const insights =
    insightsResult.status === "fulfilled" ? insightsResult.value : [];
  if (insightsResult.status === "rejected") {
    console.error("[buildPulseContext] getRecentInsights failed:", insightsResult.reason);
  }

  const summaries =
    summariesResult.status === "fulfilled" ? summariesResult.value : [];
  if (summariesResult.status === "rejected") {
    console.error("[buildPulseContext] getRecentSummaries failed:", summariesResult.reason);
  }

  const sections: string[] = [];
  sections.push(`<context_instructions>\n${PULSE_INSTRUCTIONS}\n</context_instructions>`);
  sections.push(`<date>\n${formatDate(localDate)}\n</date>`);
  sections.push(
    `<athlete_profile>\n${profile?.content ?? "No profile on file."}\n</athlete_profile>`
  );
  sections.push(
    `<user_preferences>\n${preferences?.content ?? "No preferences on file."}\n</user_preferences>`
  );
  sections.push(
    `<prior_pulse_insights count="${insights.length}">\n${formatInsightsBlock(insights)}\n</prior_pulse_insights>`
  );
  sections.push(
    `<recent_summaries count="${summaries.length}">\n${formatSummariesBlock(summaries)}\n</recent_summaries>`
  );

  return { systemPrompt, contextBlock: sections.join("\n\n") };
}

export async function buildDeepContext(
  athleteId: string,
  localDate: string
): Promise<ReflectionContext> {
  const [
    promptResult,
    profileResult,
    preferencesResult,
    insightsResult,
    summariesResult,
    contextIndexResult,
  ] = await Promise.allSettled([
    loadReflectionPrompt("deep"),
    getAthleteProfile(athleteId),
    getUserPreferences(athleteId),
    getRecentInsights(athleteId, "deep", 5),
    getRecentSummaries(athleteId, localDate, 7),
    getContextIndexCounts(athleteId),
  ]);

  const systemPrompt =
    promptResult.status === "fulfilled" ? promptResult.value : "";
  if (promptResult.status === "rejected") {
    console.error("[buildDeepContext] loadReflectionPrompt failed:", promptResult.reason);
  }

  const profile =
    profileResult.status === "fulfilled" ? profileResult.value : null;
  if (profileResult.status === "rejected") {
    console.error("[buildDeepContext] getAthleteProfile failed:", profileResult.reason);
  }

  const preferences =
    preferencesResult.status === "fulfilled" ? preferencesResult.value : null;
  if (preferencesResult.status === "rejected") {
    console.error("[buildDeepContext] getUserPreferences failed:", preferencesResult.reason);
  }

  const insights =
    insightsResult.status === "fulfilled" ? insightsResult.value : [];
  if (insightsResult.status === "rejected") {
    console.error("[buildDeepContext] getRecentInsights failed:", insightsResult.reason);
  }

  const summaries =
    summariesResult.status === "fulfilled" ? summariesResult.value : [];
  if (summariesResult.status === "rejected") {
    console.error("[buildDeepContext] getRecentSummaries failed:", summariesResult.reason);
  }

  const emptyRange = { count: 0, earliest: null, latest: null };
  const defaultContextIndex: ContextIndexCounts = {
    summaries: emptyRange,
    runs: emptyRange,
    sets: emptyRange,
    mesocycles: { count: 0 },
    weeklyPlans: { count: 0 },
    exercises: [],
    runTypes: [],
  };
  const contextIndex =
    contextIndexResult.status === "fulfilled"
      ? contextIndexResult.value
      : defaultContextIndex;
  if (contextIndexResult.status === "rejected") {
    console.error("[buildDeepContext] getContextIndexCounts failed:", contextIndexResult.reason);
  }

  const sections: string[] = [];
  sections.push(`<context_instructions>\n${DEEP_INSTRUCTIONS}\n</context_instructions>`);
  sections.push(`<date>\n${formatDate(localDate)}\n</date>`);
  sections.push(
    `<athlete_profile>\n${profile?.content ?? "No profile on file."}\n</athlete_profile>`
  );
  sections.push(
    `<user_preferences>\n${preferences?.content ?? "No preferences on file."}\n</user_preferences>`
  );
  sections.push(
    `<prior_deep_insights count="${insights.length}">\n${formatInsightsBlock(insights)}\n</prior_deep_insights>`
  );
  sections.push(
    `<recent_summaries count="${summaries.length}">\n${formatSummariesBlock(summaries)}\n</recent_summaries>`
  );
  sections.push(
    `<context_index>\n${formatContextIndex(contextIndex)}\n</context_index>`
  );

  return { systemPrompt, contextBlock: sections.join("\n\n") };
}
