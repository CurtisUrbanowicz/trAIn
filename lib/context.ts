import { readFile } from "fs/promises";
import path from "path";
import { supabase } from "./supabase";

/** Server-only: uses Node fs. Do not import from client components. */

function formatDate(dateStr: string): string {
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const date = new Date(dateStr + "T00:00:00Z");
  return `${dateStr} (${days[date.getUTCDay()]})`;
}

function addUtcCalendarDays(ymd: string, deltaDays: number): string {
  const parts = ymd.split("-").map(Number);
  const y = parts[0]!;
  const mo = parts[1]!;
  const d = parts[2]!;
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + deltaDays);
  const yy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export type TabType = "coach" | "today" | "week" | "season";

export type ContextResult = {
  systemPrompt: string;
  contextBlock: string;
};

export type ContextIndexCounts = {
  summaries: { count: number; earliest: string | null; latest: string | null };
  runs: { count: number; earliest: string | null; latest: string | null };
  sets: { count: number; earliest: string | null; latest: string | null };
  mesocycles: { count: number };
  weeklyPlans: { count: number };
  exercises: string[];
  runTypes: string[];
};

type SystemPromptCacheEntry = {
  value: string;
  /** YYYY-MM-DD when this entry was written */
  cachedDate: string;
};

const systemPromptCache = new Map<TabType, SystemPromptCacheEntry>();

export async function loadSystemPrompt(
  tab: TabType,
  localDate: string
): Promise<string> {
  const hit = systemPromptCache.get(tab);
  if (hit && hit.cachedDate === localDate) {
    return hit.value;
  }

  const root = process.cwd();
  const brainPath = path.join(root, "coaching-brain.md");
  const tabPath = path.join(root, "tab-instructions", `${tab}.md`);

  const [brain, tabInstructions] = await Promise.all([
    readFile(brainPath, "utf8"),
    readFile(tabPath, "utf8"),
  ]);

  const combined = `${brain}\n${tabInstructions}`;
  systemPromptCache.set(tab, { value: combined, cachedDate: localDate });
  return combined;
}

export async function getAthleteProfile(
  athleteId: string
): Promise<{ content: string } | null> {
  const { data, error } = await supabase
    .from("athlete_profile")
    .select("content")
    .eq("athlete_id", athleteId)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data || data.content == null) return null;
  return { content: data.content };
}

export async function getUserPreferences(
  athleteId: string
): Promise<{ content: string } | null> {
  const { data, error } = await supabase
    .from("user_preferences")
    .select("content")
    .eq("athlete_id", athleteId)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data || data.content == null) return null;
  return { content: data.content };
}

export async function getActiveMesocycle(
  athleteId: string
): Promise<{
  start_date: string;
  end_date: string;
  goal: string;
  notes: string;
} | null> {
  const { data, error } = await supabase
    .from("mesocycles")
    .select("start_date, end_date, goal, notes")
    .eq("athlete_id", athleteId)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return {
    start_date: data.start_date,
    end_date: data.end_date,
    goal: data.goal,
    notes: data.notes,
  };
}

export async function getCurrentWeeklyPlan(
  athleteId: string,
  weekStart: string
): Promise<{ days: any } | null> {
  const { data, error } = await supabase
    .from("weekly_plans")
    .select("days")
    .eq("athlete_id", athleteId)
    .eq("week_start", weekStart)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return { days: data.days };
}

export async function getTodaysReadiness(
  athleteId: string,
  localDate: string
): Promise<{
  hrv: number | null;
  rhr: number | null;
  recovery_score: number | null;
  sleep_hours: number | null;
} | null> {
  const { data, error } = await supabase
    .from("readiness")
    .select("hrv, rhr, recovery_score, sleep_hours")
    .eq("athlete_id", athleteId)
    .eq("date", localDate)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return {
    hrv: data.hrv,
    rhr: data.rhr,
    recovery_score: data.recovery_score,
    sleep_hours: data.sleep_hours,
  };
}

export async function getTodaysMessages(
  athleteId: string,
  localDate: string
): Promise<{ role: string; content: string; tab: string }[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content, tab")
    .eq("athlete_id", athleteId)
    .eq("date", localDate)
    .order("timestamp", { ascending: true });

  if (error || !data) return [];
  return data.map((row) => ({
    role: row.role,
    content: row.content,
    tab: row.tab,
  }));
}

export async function getRecentSummaries(
  athleteId: string,
  localDate: string,
  limit = 7
): Promise<{ date: string; summary: string }[]> {
  const { data, error } = await supabase
    .from("daily_summaries")
    .select("date, summary")
    .eq("athlete_id", athleteId)
    .lt("date", localDate)
    .order("date", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data.map((row) => ({ date: row.date, summary: row.summary }));
}

async function rangeCountAndDates(
  table: "daily_summaries" | "runs" | "sets",
  athleteId: string
): Promise<{ count: number; earliest: string | null; latest: string | null }> {
  const [countRes, minRes, maxRes] = await Promise.all([
    supabase
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("athlete_id", athleteId),
    supabase
      .from(table)
      .select("date")
      .eq("athlete_id", athleteId)
      .order("date", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from(table)
      .select("date")
      .eq("athlete_id", athleteId)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    count: countRes.count ?? 0,
    earliest: minRes.data?.date ?? null,
    latest: maxRes.data?.date ?? null,
  };
}

export async function getContextIndexCounts(
  athleteId: string
): Promise<ContextIndexCounts> {
  const [summaries, runs, sets, mesoRes, plansRes, exercisesRes, runTypesRes] =
    await Promise.all([
      rangeCountAndDates("daily_summaries", athleteId),
      rangeCountAndDates("runs", athleteId),
      rangeCountAndDates("sets", athleteId),
      supabase
        .from("mesocycles")
        .select("*", { count: "exact", head: true })
        .eq("athlete_id", athleteId),
      supabase
        .from("weekly_plans")
        .select("*", { count: "exact", head: true })
        .eq("athlete_id", athleteId),
      supabase
        .from("sets")
        .select("exercise")
        .eq("athlete_id", athleteId),
      supabase
        .from("runs")
        .select("run_type")
        .eq("athlete_id", athleteId),
    ]);

  const exercises = Array.from(
    new Set(
      (exercisesRes.data ?? [])
        .map((r: { exercise: string }) => r.exercise)
        .filter(Boolean)
    )
  ).sort();

  const runTypes = Array.from(
    new Set(
      (runTypesRes.data ?? [])
        .map((r: { run_type: string }) => r.run_type)
        .filter(Boolean)
    )
  ).sort();

  return {
    summaries,
    runs,
    sets,
    mesocycles: { count: mesoRes.count ?? 0 },
    weeklyPlans: { count: plansRes.count ?? 0 },
    exercises,
    runTypes,
  };
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

const WEEK_DAY_KEYS = [
  ["monday", "Monday"],
  ["tuesday", "Tuesday"],
  ["wednesday", "Wednesday"],
  ["thursday", "Thursday"],
  ["friday", "Friday"],
  ["saturday", "Saturday"],
  ["sunday", "Sunday"],
] as const;

function formatMetric(value: number | null): string {
  if (value === null || value === undefined) return "none";
  return String(value);
}

export function formatContext(
  tab: TabType,
  localDate: string,
  weekStart: string,
  data: {
    profile: Awaited<ReturnType<typeof getAthleteProfile>>;
    preferences: Awaited<ReturnType<typeof getUserPreferences>>;
    mesocycle: Awaited<ReturnType<typeof getActiveMesocycle>>;
    weeklyPlan: Awaited<ReturnType<typeof getCurrentWeeklyPlan>>;
    readiness: Awaited<ReturnType<typeof getTodaysReadiness>>;
    messages: Awaited<ReturnType<typeof getTodaysMessages>>;
    summaries: Awaited<ReturnType<typeof getRecentSummaries>>;
    contextIndex: Awaited<ReturnType<typeof getContextIndexCounts>>;
  }
): string {
  const sections: string[] = [];

  sections.push(
    `Fields marked as empty or "not yet set" simply mean no data exists yet — do not assume or infer values. Daily summaries are your primary memory of this athlete's recent training history. The context index at the end shows what deeper data is available beyond what's loaded here — retrieve via tool call when it would improve your response.`
  );

  sections.push(`TODAY'S DATE: ${formatDate(localDate)}`);

  const thisMonday = getWeekStartMondayUtc(localDate);
  const nextMonday = getWeekStartMondayUtc(addUtcCalendarDays(localDate, 7));
  sections.push(
    `WEEK REFERENCE DATES:\nCurrent week Monday: ${formatDate(thisMonday)}\nNext week Monday: ${formatDate(nextMonday)}`
  );

  sections.push(
    `ATHLETE PROFILE:\n${data.profile?.content ?? "Not yet set"}`
  );

  sections.push(
    `USER PREFERENCES:\n${data.preferences?.content ?? "Not yet set"}`
  );

  if (data.mesocycle) {
    const m = data.mesocycle;
    const lines = [
      "MESOCYCLE:",
      `Goal: ${m.goal ?? ""}`,
      `Start: ${formatDate(m.start_date)}`,
      `End: ${formatDate(m.end_date)}`,
    ];
    const notesStr = m.notes != null ? String(m.notes).trim() : "";
    if (notesStr !== "") {
      lines.push(`Notes: ${notesStr}`);
    }
    sections.push(lines.join("\n"));
  } else {
    sections.push("MESOCYCLE:\nNo active mesocycle");
  }

  if (data.weeklyPlan?.days != null && typeof data.weeklyPlan.days === "object") {
    const days = data.weeklyPlan.days as Record<
      string,
      { session_type?: string; notes?: string }
    >;
    const dayLines = WEEK_DAY_KEYS.map(([key], index) => {
      const dayYmd = addUtcCalendarDays(weekStart, index);
      const entry = days[key];
      const sessionType = entry?.session_type ?? "";
      const notes = entry?.notes ?? "";
      return `${formatDate(dayYmd)}: ${sessionType} — ${notes}`;
    });
    sections.push(`WEEKLY PLAN:\n${dayLines.join("\n")}`);
  } else {
    sections.push("WEEKLY PLAN:\nNo plan committed this week");
  }

  if (data.readiness) {
    const r = data.readiness;
    sections.push(
      [
        "TODAY'S READINESS:",
        `Date: ${formatDate(localDate)}`,
        `HRV: ${formatMetric(r.hrv)}`,
        `RHR: ${formatMetric(r.rhr)}`,
        `Recovery Score: ${formatMetric(r.recovery_score)}`,
        `Sleep Hours: ${formatMetric(r.sleep_hours)}`,
      ].join("\n")
    );
  } else {
    sections.push(
      `TODAY'S READINESS:\nNothing logged for ${formatDate(localDate)}`
    );
  }

  if (data.summaries.length === 0) {
    sections.push("RECENT SUMMARIES (LAST 7 DAYS):\nNo recent summaries");
  } else {
    const body = data.summaries
      .map((s) => `${formatDate(s.date)}: ${s.summary ?? ""}`)
      .join("\n\n");
    sections.push(`RECENT SUMMARIES (LAST 7 DAYS):\n${body}`);
  }

  const crossTabMessages = data.messages.filter((m) => m.tab !== tab);
  if (crossTabMessages.length === 0) {
    sections.push(
      "TODAY'S MESSAGES:\nNo messages today from other tabs."
    );
  } else {
    const body = crossTabMessages
      .map((m) => {
        const role = (m.role ?? "").toLowerCase();
        return `[${m.tab}] ${role}: ${m.content ?? ""}`;
      })
      .join("\n");
    sections.push(`TODAY'S MESSAGES:\n${body}`);
  }

  const ci = data.contextIndex;
  const indexBody = [
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

  sections.push(`CONTEXT INDEX:\n${indexBody}`);

  return sections.join("\n\n");
}

/** Monday of the week containing `localDate` (YYYY-MM-DD), computed in UTC. */
export function getWeekStartMondayUtc(localDate: string): string {
  const parts = localDate.split("-").map(Number);
  const y = parts[0]!;
  const mo = parts[1]!;
  const d = parts[2]!;
  const date = new Date(Date.UTC(y, mo - 1, d));
  const dayOfWeek = date.getUTCDay();
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  date.setUTCDate(date.getUTCDate() - daysToSubtract);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export async function buildContext(
  athleteId: string,
  tab: TabType,
  localDate: string
): Promise<ContextResult> {
  const weekStart = getWeekStartMondayUtc(localDate);

  const [
    promptResult,
    profileResult,
    preferencesResult,
    mesocycleResult,
    weeklyPlanResult,
    readinessResult,
    messagesResult,
    summariesResult,
    contextIndexResult,
  ] = await Promise.allSettled([
    loadSystemPrompt(tab, localDate),
    getAthleteProfile(athleteId),
    getUserPreferences(athleteId),
    getActiveMesocycle(athleteId),
    getCurrentWeeklyPlan(athleteId, weekStart),
    getTodaysReadiness(athleteId, localDate),
    getTodaysMessages(athleteId, localDate),
    getRecentSummaries(athleteId, localDate),
    getContextIndexCounts(athleteId),
  ]);

  const systemPrompt =
    promptResult.status === "fulfilled" ? promptResult.value : "";
  if (promptResult.status === "rejected") {
    console.error("[buildContext] loadSystemPrompt failed:", promptResult.reason);
  }

  const profile =
    profileResult.status === "fulfilled" ? profileResult.value : null;
  if (profileResult.status === "rejected") {
    console.error(
      "[buildContext] getAthleteProfile failed:",
      profileResult.reason
    );
  }

  const preferences =
    preferencesResult.status === "fulfilled" ? preferencesResult.value : null;
  if (preferencesResult.status === "rejected") {
    console.error(
      "[buildContext] getUserPreferences failed:",
      preferencesResult.reason
    );
  }

  const mesocycle =
    mesocycleResult.status === "fulfilled" ? mesocycleResult.value : null;
  if (mesocycleResult.status === "rejected") {
    console.error(
      "[buildContext] getActiveMesocycle failed:",
      mesocycleResult.reason
    );
  }

  const weeklyPlan =
    weeklyPlanResult.status === "fulfilled" ? weeklyPlanResult.value : null;
  if (weeklyPlanResult.status === "rejected") {
    console.error(
      "[buildContext] getCurrentWeeklyPlan failed:",
      weeklyPlanResult.reason
    );
  }

  const readiness =
    readinessResult.status === "fulfilled" ? readinessResult.value : null;
  if (readinessResult.status === "rejected") {
    console.error(
      "[buildContext] getTodaysReadiness failed:",
      readinessResult.reason
    );
  }

  const messages =
    messagesResult.status === "fulfilled" ? messagesResult.value : [];
  if (messagesResult.status === "rejected") {
    console.error(
      "[buildContext] getTodaysMessages failed:",
      messagesResult.reason
    );
  }

  const summaries =
    summariesResult.status === "fulfilled" ? summariesResult.value : [];
  if (summariesResult.status === "rejected") {
    console.error(
      "[buildContext] getRecentSummaries failed:",
      summariesResult.reason
    );
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
    console.error(
      "[buildContext] getContextIndexCounts failed:",
      contextIndexResult.reason
    );
  }

  const contextBlock = formatContext(tab, localDate, weekStart, {
    profile,
    preferences,
    mesocycle,
    weeklyPlan,
    readiness,
    messages,
    summaries,
    contextIndex,
  });

  return { systemPrompt, contextBlock };
}