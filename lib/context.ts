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

const SUMMARY_LIMIT: Record<TabType, number> = {
  today: 3,
  week: 3,
  season: 0,
  coach: 0,
};

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
  athleteId: string,
  localDate: string
): Promise<{
  start_date: string;
  end_date: string;
  name: string | null;
  goal: string;
  structure: string | null;
  notes: string;
} | null> {
  const { data, error } = await supabase
    .from("mesocycles")
    .select("start_date, end_date, name, goal, structure, notes")
    .eq("athlete_id", athleteId)
    .lte("start_date", localDate)
    .gte("end_date", localDate)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return {
    start_date: data.start_date,
    end_date: data.end_date,
    name: data.name,
    goal: data.goal,
    structure: data.structure,
    notes: data.notes,
  };
}

export async function getCurrentWeeklyPlan(
  athleteId: string,
  weekStart: string
): Promise<{ days: Record<string, { session_type?: string; notes?: string }> } | null> {
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

export async function getTodaysPlan(
  athleteId: string,
  localDate: string
): Promise<{
  session_type: string;
  notes: string | null;
  exercises: string[];
} | null> {
  const { data, error } = await supabase
    .from("plans")
    .select("session_type, notes, exercises")
    .eq("athlete_id", athleteId)
    .eq("date", localDate)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  let raw: unknown = data.exercises;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [];
    }
  }
  const exercises: string[] = Array.isArray(raw)
    ? raw
        .map((e) =>
          typeof e === "string"
            ? e
            : e && typeof e === "object" && "name" in e
              ? String((e as { name: unknown }).name ?? "")
              : ""
        )
        .filter(Boolean)
    : [];

  return {
    session_type: data.session_type,
    notes: data.notes,
    exercises,
  };
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
  limit: number
): Promise<{ date: string; summary: string }[]> {
  if (limit <= 0) return [];
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
  localTime: string | undefined,
  data: {
    profile: Awaited<ReturnType<typeof getAthleteProfile>>;
    preferences: Awaited<ReturnType<typeof getUserPreferences>>;
    mesocycle: Awaited<ReturnType<typeof getActiveMesocycle>>;
    weeklyPlan: Awaited<ReturnType<typeof getCurrentWeeklyPlan>>;
    todayPlan: Awaited<ReturnType<typeof getTodaysPlan>>;
    readiness: Awaited<ReturnType<typeof getTodaysReadiness>>;
    messages: Awaited<ReturnType<typeof getTodaysMessages>>;
    summaries: Awaited<ReturnType<typeof getRecentSummaries>>;
    contextIndex: Awaited<ReturnType<typeof getContextIndexCounts>>;
  }
): string {
  const sections: string[] = [];

  sections.push(
    `<context_instructions>\nEmpty fields mean no data exists — do not assume or infer values. Daily summaries are your primary memory of recent training. The context index shows what deeper data is available — retrieve via tool call when it would improve your response.\n</context_instructions>`
  );

  sections.push(
    `<date>${formatDate(localDate)}${localTime ? ` ${localTime}` : ""}</date>`
  );

  const thisMonday = getWeekStartMondayUtc(localDate);
  const nextMonday = getWeekStartMondayUtc(addUtcCalendarDays(localDate, 7));
  sections.push(
    `<week_dates>\nCurrent week Monday: ${formatDate(thisMonday)}\nNext week Monday: ${formatDate(nextMonday)}\n</week_dates>`
  );

  sections.push(
    `<athlete_profile>\n${data.profile?.content ?? "Not yet set"}\n</athlete_profile>`
  );

  sections.push(
    `<user_preferences>\n${data.preferences?.content ?? "Not yet set"}\n</user_preferences>`
  );

  if (data.mesocycle) {
    const m = data.mesocycle;
    const lines = [
      `Name: ${m.name ?? ""}`,
      `Goal: ${m.goal ?? ""}`,
      `Structure: ${m.structure ?? ""}`,
    ];
    const notesStr = m.notes != null ? String(m.notes).trim() : "";
    if (notesStr !== "") {
      lines.push(`Notes: ${notesStr}`);
    }
    lines.push(`Dates: ${formatDate(m.start_date)} – ${formatDate(m.end_date)}`);
    sections.push(`<mesocycle>\n${lines.join("\n")}\n</mesocycle>`);
  } else {
    sections.push("<mesocycle>\nNo active mesocycle\n</mesocycle>");
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
    sections.push(`<weekly_plan>\n${dayLines.join("\n")}\n</weekly_plan>`);
  } else {
    sections.push("<weekly_plan>\nNo plan committed this week\n</weekly_plan>");
  }

  if (data.todayPlan) {
    const p = data.todayPlan;
    const lines = [`Session: ${p.session_type}`];
    if (p.exercises.length > 0) {
      lines.push(`Exercises:\n${p.exercises.map((e) => `- ${e}`).join("\n")}`);
    }
    if (p.notes != null && String(p.notes).trim() !== "") {
      lines.push(`Notes: ${p.notes}`);
    }
    sections.push(`<today_plan>\n${lines.join("\n")}\n</today_plan>`);
  } else {
    sections.push("<today_plan>\nNo plan committed for today.\n</today_plan>");
  }

  if (data.readiness) {
    const r = data.readiness;
    sections.push(
      `<readiness>\n${[
        `HRV: ${formatMetric(r.hrv)}`,
        `RHR: ${formatMetric(r.rhr)}`,
        `Recovery: ${formatMetric(r.recovery_score)}`,
        `Sleep: ${formatMetric(r.sleep_hours)}`,
      ].join("\n")}\n</readiness>`
    );
  } else {
    sections.push(
      `<readiness>\nNothing logged for ${formatDate(localDate)}\n</readiness>`
    );
  }

  if (data.summaries.length === 0) {
    sections.push(
      "<daily_summaries>\nNone pre-loaded. Use get_history to retrieve when needed.\n</daily_summaries>"
    );
  } else {
    const body = data.summaries
      .map((s) => `${formatDate(s.date)}: ${s.summary ?? ""}`)
      .join("\n\n");
    sections.push(
      `<daily_summaries count="${data.summaries.length}">\n${body}\n</daily_summaries>`
    );
  }

  const crossTabMessages = data.messages.filter((m) => m.tab !== tab);
  if (crossTabMessages.length === 0) {
    sections.push(
      "<cross_tab_messages>\nNo messages today from other tabs.\n</cross_tab_messages>"
    );
  } else {
    const body = crossTabMessages
      .map((m) => {
        const role = (m.role ?? "").toLowerCase();
        return `[${m.tab}] ${role}: ${m.content ?? ""}`;
      })
      .join("\n");
    sections.push(`<cross_tab_messages>\n${body}\n</cross_tab_messages>`);
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

  sections.push(`<context_index>\n${indexBody}\n</context_index>`);

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
  localDate: string,
  localTime?: string
): Promise<ContextResult> {
  const weekStart = getWeekStartMondayUtc(localDate);

  const [
    promptResult,
    profileResult,
    preferencesResult,
    mesocycleResult,
    weeklyPlanResult,
    todayPlanResult,
    readinessResult,
    messagesResult,
    summariesResult,
    contextIndexResult,
  ] = await Promise.allSettled([
    loadSystemPrompt(tab, localDate),
    getAthleteProfile(athleteId),
    getUserPreferences(athleteId),
    getActiveMesocycle(athleteId, localDate),
    getCurrentWeeklyPlan(athleteId, weekStart),
    getTodaysPlan(athleteId, localDate),
    getTodaysReadiness(athleteId, localDate),
    getTodaysMessages(athleteId, localDate),
    getRecentSummaries(athleteId, localDate, SUMMARY_LIMIT[tab]),
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

  const todayPlan =
    todayPlanResult.status === "fulfilled" ? todayPlanResult.value : null;
  if (todayPlanResult.status === "rejected") {
    console.error(
      "[buildContext] getTodaysPlan failed:",
      todayPlanResult.reason
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

  const contextBlock = formatContext(tab, localDate, weekStart, localTime, {
    profile,
    preferences,
    mesocycle,
    weeklyPlan,
    todayPlan,
    readiness,
    messages,
    summaries,
    contextIndex,
  });

  return { systemPrompt, contextBlock };
}