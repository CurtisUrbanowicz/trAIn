import "server-only";
import { supabase } from "./supabase";
import { loadChatSystemPrompt } from "@/prompts/manifest";
import { formatPatternsBlock, getLatestPatterns, type PatternsRow } from "./patterns";

export function formatDate(dateStr: string): string {
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
  coach: 7,
};

export type ContextResult = {
  systemPrompt: string;
  volatileBlock: string;
  // The rendered <training_state> and <athlete_patterns> blocks (also inside
  // systemPrompt); exposed for the context_loaded log entry and
  // /api/debug/context
  trainingStateBlock: string;
  patternsBlock: string;
};

export type FormattedContext = {
  stableBlock: string;
  volatileBlock: string;
  trainingStateBlock: string;
  patternsBlock: string;
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
  source: "manual" | "whoop";
} | null> {
  const { data, error } = await supabase
    .from("readiness")
    .select("hrv, rhr, recovery_score, sleep_hours, source")
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
    // readiness.source: "whoop" for synced rows, null for manual logs
    source: data.source === "whoop" ? "whoop" : "manual",
  };
}

export async function getTodaysMessages(
  athleteId: string,
  localDate: string,
  excludeTab?: string
): Promise<{ role: string; content: string; tab: string }[]> {
  let query = supabase
    .from("messages")
    .select("role, content, tab")
    .eq("athlete_id", athleteId)
    .eq("date", localDate);
  if (excludeTab) {
    // formatContext only renders cross-tab messages — filter server-side
    query = query.neq("tab", excludeTab);
  }
  const { data, error } = await query.order("timestamp", { ascending: true });

  if (error || !data) return [];
  return data.map((row) => ({
    role: row.role,
    content: row.content,
    tab: row.tab,
  }));
}

export async function getTodaysActions(
  athleteId: string,
  localDate: string
): Promise<
  { timestamp: string; local_time: string | null; tool: string; summary: string }[]
> {
  const { data, error } = await supabase
    .from("actions")
    .select("timestamp, local_time, tool, summary")
    .eq("athlete_id", athleteId)
    .eq("date", localDate)
    .order("timestamp", { ascending: true });

  if (error || !data) return [];
  return data.map((row) => ({
    timestamp: row.timestamp,
    local_time: row.local_time,
    tool: row.tool,
    summary: row.summary,
  }));
}

export async function getTodaysInsights(
  athleteId: string,
  localDate: string
): Promise<{ id: string; type: string; content: string; significance: number }[]> {
  const { data, error } = await supabase
    .from("insights")
    .select("id, type, content, significance")
    .eq("athlete_id", athleteId)
    .eq("date", localDate);

  if (error || !data) return [];
  const order = (t: string) => (t === "pulse" ? 0 : t === "deep" ? 1 : 2);
  return data
    .map((row: { id: string; type: string; content: string; significance: number }) => ({
      id: row.id,
      type: row.type,
      content: row.content,
      significance: row.significance,
    }))
    .sort((a, b) => order(a.type) - order(b.type));
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

export async function getContextIndexCounts(
  athleteId: string
): Promise<ContextIndexCounts> {
  // Single RPC round trip — replaces 13 per-request queries (3× count/min/max,
  // 2 bare counts, and two vocabulary scans that grew with every session).
  // See supabase/migrations/20261004000000_create_get_context_index_rpc.sql.
  const { data, error } = await supabase.rpc("get_context_index", {
    p_athlete_id: athleteId,
  });

  if (error || data == null) {
    throw new Error(
      `get_context_index RPC failed: ${error?.message ?? "no data returned"}`
    );
  }

  const raw = data as Record<string, unknown>;

  const range = (value: unknown) => {
    const r = (value ?? {}) as {
      count?: number;
      earliest?: string | null;
      latest?: string | null;
    };
    return {
      count: r.count ?? 0,
      earliest: r.earliest ?? null,
      latest: r.latest ?? null,
    };
  };

  const countOnly = (value: unknown) => ({
    count: ((value ?? {}) as { count?: number }).count ?? 0,
  });

  const stringList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];

  return {
    summaries: range(raw.summaries),
    runs: range(raw.runs),
    sets: range(raw.sets),
    mesocycles: countOnly(raw.mesocycles),
    weeklyPlans: countOnly(raw.weeklyPlans),
    exercises: stringList(raw.exercises),
    runTypes: stringList(raw.runTypes),
  };
}

// ── training_state ───────────────────────────────────────────────
//
// A computed intermediate layer between the raw tables and the brain: one
// RPC returns the recent shape of training (runs per type, top sets per
// lift, weekly volume, readiness medians) so the brain stops anchoring on
// the last three daily summaries. No model call, no new table. The client's
// local date is the clock, as everywhere else in the app.
// See supabase/migrations/20261006120000_get_training_state_rpc.sql.

export type TrainingState = {
  today: string;
  runs: Record<
    string,
    {
      last3: {
        date: string;
        distance_km: number | null;
        avg_pace: string | null;
        avg_hr: number | null;
      }[];
      longest: { date: string; distance_km: number | null } | null;
      fastest: { date: string; avg_pace: string | null } | null;
    }
  >;
  lifts: Record<
    string,
    {
      last3: {
        date: string;
        weight_kg: number | null;
        reps: number | null;
        rir: number | null;
      }[];
      best: { date: string; weight_kg: number | null; reps: number | null } | null;
    }
  >;
  // Seen in the last 12 weeks but under 3 sessions in 56 days; 10 most recent
  liftsLastSeen: { exercise: string; date: string }[];
  weeks: { week_start: string; km: number; sessions: number; partial: boolean }[];
  readiness28d: {
    hrv: number | null;
    rhr: number | null;
    sleep_hours: number | null;
    days: number;
  } | null;
  lastRun: string | null;
  lastLift: string | null;
};

export async function getTrainingState(
  athleteId: string,
  localDate: string
): Promise<TrainingState> {
  const { data, error } = await supabase.rpc("get_training_state", {
    p_athlete_id: athleteId,
    p_today: localDate,
  });

  if (error || data == null) {
    throw new Error(
      `get_training_state RPC failed: ${error?.message ?? "no data returned"}`
    );
  }

  const raw = data as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      return Number(v);
    }
    return null;
  };
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const arr = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.map(obj) : [];

  const runs: TrainingState["runs"] = {};
  for (const [type, v] of Object.entries(obj(raw.runs))) {
    const r = obj(v);
    const longest = r.longest ? obj(r.longest) : null;
    const fastest = r.fastest ? obj(r.fastest) : null;
    runs[type] = {
      last3: arr(r.last3).map((e) => ({
        date: str(e.date) ?? "",
        distance_km: num(e.distance_km),
        avg_pace: str(e.avg_pace),
        avg_hr: num(e.avg_hr),
      })),
      longest: longest
        ? { date: str(longest.date) ?? "", distance_km: num(longest.distance_km) }
        : null,
      fastest: fastest
        ? { date: str(fastest.date) ?? "", avg_pace: str(fastest.avg_pace) }
        : null,
    };
  }

  const lifts: TrainingState["lifts"] = {};
  for (const [name, v] of Object.entries(obj(raw.lifts))) {
    const l = obj(v);
    const best = l.best ? obj(l.best) : null;
    lifts[name] = {
      last3: arr(l.last3).map((e) => ({
        date: str(e.date) ?? "",
        weight_kg: num(e.weight_kg),
        reps: num(e.reps),
        rir: num(e.rir),
      })),
      best: best
        ? {
            date: str(best.date) ?? "",
            weight_kg: num(best.weight_kg),
            reps: num(best.reps),
          }
        : null,
    };
  }

  const r28 = raw.readiness_28d ? obj(raw.readiness_28d) : null;
  const r28days = r28 ? (num(r28.days) ?? 0) : 0;

  return {
    today: str(raw.today) ?? localDate,
    runs,
    lifts,
    liftsLastSeen: arr(raw.lifts_last_seen)
      .map((e) => ({ exercise: str(e.exercise) ?? "", date: str(e.date) ?? "" }))
      .filter((e) => e.exercise !== "" && e.date !== ""),
    weeks: arr(raw.weeks).map((w) => ({
      week_start: str(w.week_start) ?? "",
      km: num(w.km) ?? 0,
      sessions: num(w.sessions) ?? 0,
      partial: w.partial === true,
    })),
    readiness28d:
      r28 && r28days > 0
        ? {
            hrv: num(r28.hrv),
            rhr: num(r28.rhr),
            sleep_hours: num(r28.sleep_hours),
            days: r28days,
          }
        : null,
    lastRun: str(raw.last_run),
    lastLift: str(raw.last_lift),
  };
}

/** MM-DD when within the last 12 months of `today`, else the full date. */
function shortDate(ymd: string, today: string): string {
  const t = Date.parse(today + "T00:00:00Z");
  const d = Date.parse(ymd + "T00:00:00Z");
  if (!Number.isFinite(t) || !Number.isFinite(d) || t - d > 365 * 86400000) {
    return ymd;
  }
  return ymd.slice(5);
}

function fmtKm(km: number | null): string {
  if (km === null) return "-";
  return `${Number.isInteger(km) ? String(km) : km.toFixed(1)}k`;
}

/** "80x8@2"; bodyweight work is stored as weight 0 (or null) → "bwx12". */
function fmtSet(s: {
  weight_kg: number | null;
  reps: number | null;
  rir?: number | null;
}): string {
  const w = s.weight_kg === null || s.weight_kg === 0 ? "bw" : String(s.weight_kg);
  const reps = s.reps === null ? "?" : String(s.reps);
  const rir = s.rir === null || s.rir === undefined ? "" : `@${s.rir}`;
  return `${w}x${reps}${rir}`;
}

/**
 * One line per item. Dates are MM-DD (the year only when older than 12
 * months). When the RPC failed the block says so explicitly, so absence is
 * never read as "no data".
 */
export function formatTrainingState(ts: TrainingState | null): string {
  if (!ts) {
    return "<training_state>\nUnavailable this turn — use get_history for recent runs, sets and readiness.\n</training_state>";
  }
  const today = ts.today;
  const lines: string[] = [];

  const runTypes = Object.keys(ts.runs).sort();
  if (runTypes.length > 0) {
    // Dense numbers tokenise at under two characters per token, so labels
    // are short and the separator is a plain comma (measured: "·" and long
    // headers cost ~80 tokens on this block)
    lines.push("runs (last 3: date km pace hr; 6-month longest, fastest)");
    for (const type of runTypes) {
      const r = ts.runs[type]!;
      const parts = r.last3.map(
        (e) =>
          `${shortDate(e.date, today)} ${fmtKm(e.distance_km)} ${e.avg_pace ?? "-"} ${
            e.avg_hr === null ? "-" : Math.round(e.avg_hr)
          }`
      );
      if (r.longest) {
        parts.push(`longest ${fmtKm(r.longest.distance_km)} ${shortDate(r.longest.date, today)}`);
      }
      if (r.fastest) {
        parts.push(`fastest ${r.fastest.avg_pace ?? "-"} ${shortDate(r.fastest.date, today)}`);
      }
      lines.push(`${type}: ${parts.join(", ")}`);
    }
  } else {
    lines.push("runs: none logged");
  }

  const liftNames = Object.keys(ts.lifts).sort();
  if (liftNames.length > 0) {
    lines.push("lifts (top set per session, last 3 as weightxreps@rir; all-time best)");
    for (const name of liftNames) {
      const l = ts.lifts[name]!;
      const parts = l.last3.map((s) => `${shortDate(s.date, today)} ${fmtSet(s)}`);
      if (l.best) parts.push(`best ${fmtSet(l.best)} ${shortDate(l.best.date, today)}`);
      lines.push(`${name}: ${parts.join(", ")}`);
    }
  } else {
    lines.push("lifts: none with 3+ sessions in the last 56 days");
  }
  if (ts.liftsLastSeen.length > 0) {
    lines.push(
      `other lifts (12 weeks), last seen: ${ts.liftsLastSeen
        .map((e) => `${e.exercise} ${shortDate(e.date, today)}`)
        .join(", ")}`
    );
  }

  if (ts.weeks.length > 0) {
    lines.push(
      `weeks (Mon, km, sessions): ${ts.weeks
        .map(
          (w) =>
            `${shortDate(w.week_start, today)} ${Math.round(w.km)}km ${w.sessions}${
              w.partial ? " (partial)" : ""
            }`
        )
        .join(", ")}`
    );
  }

  const r = ts.readiness28d;
  lines.push(
    r
      ? `readiness 28d median: HRV ${r.hrv ?? "-"}, RHR ${r.rhr ?? "-"}, sleep ${r.sleep_hours ?? "-"}`
      : "readiness 28d median: no data"
  );

  lines.push(
    `last run ${ts.lastRun ? shortDate(ts.lastRun, today) : "none"}, last lift ${
      ts.lastLift ? shortDate(ts.lastLift, today) : "none"
    }`
  );

  return `<training_state>\n${lines.join("\n")}\n</training_state>`;
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

function roundDownToHalfHour(time: string): string {
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return time;
  const hh = match[1]!.padStart(2, "0");
  const mm = parseInt(match[2]!, 10) < 30 ? "00" : "30";
  return `${hh}:${mm}`;
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
    insights: Awaited<ReturnType<typeof getTodaysInsights>>;
    contextIndex: Awaited<ReturnType<typeof getContextIndexCounts>>;
    actions: Awaited<ReturnType<typeof getTodaysActions>>;
    // Null when the RPC failed — the block then says "unavailable"
    trainingState: TrainingState | null;
    // Newest athlete_patterns row; null before the first patterns pass
    patterns: PatternsRow | null;
  }
): FormattedContext {
  const stable: string[] = [];
  const volatile: string[] = [];
  const trainingStateBlock = formatTrainingState(data.trainingState);
  const patternsBlock = formatPatternsBlock(data.patterns);

  stable.push(
    `<context_instructions>\nEmpty fields mean no data exists — do not assume or infer values. Daily summaries are your primary memory of recent training. The training_state block is exact and current — answer from it directly, and use get_history only for detail it doesn't hold or anything older than its windows. The athlete_patterns block is verified long-term behaviour — use it when planning or coaching rather than re-deriving it. The context index shows what deeper data is available — retrieve via tool call when it would improve your response.\n</context_instructions>`
  );

  stable.push(
    `<athlete_profile>\n${data.profile?.content ?? "Not yet set"}\n</athlete_profile>`
  );

  stable.push(
    `<user_preferences>\n${data.preferences?.content ?? "Not yet set"}\n</user_preferences>`
  );

  // Verified long-term behaviour, rewritten weekly by the patterns pass
  stable.push(patternsBlock);

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
    stable.push(`<mesocycle>\n${lines.join("\n")}\n</mesocycle>`);
  } else {
    stable.push("<mesocycle>\nNo active mesocycle\n</mesocycle>");
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
    stable.push(`<weekly_plan>\n${dayLines.join("\n")}\n</weekly_plan>`);
  } else {
    stable.push("<weekly_plan>\nNo plan committed this week\n</weekly_plan>");
  }

  // Stable: it changes when a session is logged, i.e. once per session, so
  // it costs one cache rewrite per session — the same as a plan commit
  stable.push(trainingStateBlock);

  volatile.push(
    `<date>${formatDate(localDate)}${localTime ? ` ${roundDownToHalfHour(localTime)}` : ""}</date>`
  );

  const thisMonday = getWeekStartMondayUtc(localDate);
  const nextMonday = getWeekStartMondayUtc(addUtcCalendarDays(localDate, 7));
  volatile.push(
    `<week_dates>\nCurrent week Monday: ${formatDate(thisMonday)}\nNext week Monday: ${formatDate(nextMonday)}\n</week_dates>`
  );

  if (data.todayPlan) {
    const p = data.todayPlan;
    const lines = [`Session: ${p.session_type}`];
    if (p.exercises.length > 0) {
      lines.push(`Exercises:\n${p.exercises.map((e) => `- ${e}`).join("\n")}`);
    }
    if (p.notes != null && String(p.notes).trim() !== "") {
      lines.push(`Notes: ${p.notes}`);
    }
    volatile.push(`<today_plan>\n${lines.join("\n")}\n</today_plan>`);
  } else {
    volatile.push("<today_plan>\nNo plan committed for today.\n</today_plan>");
  }

  if (data.readiness) {
    const r = data.readiness;
    // 28-day medians from training_state, so today's numbers read against
    // the athlete's own recent baseline
    const med = data.trainingState?.readiness28d ?? null;
    const medianNote = (v: number | null | undefined) =>
      v === null || v === undefined ? "" : ` (28d median ${v})`;
    volatile.push(
      `<readiness>\n${[
        `Stored: yes (source: ${r.source})`,
        `HRV: ${formatMetric(r.hrv)}${medianNote(med?.hrv)}`,
        `RHR: ${formatMetric(r.rhr)}${medianNote(med?.rhr)}`,
        `Recovery: ${formatMetric(r.recovery_score)}`,
        `Sleep: ${formatMetric(r.sleep_hours)}`,
      ].join("\n")}\n</readiness>`
    );
  } else {
    volatile.push(
      `<readiness>\nNothing logged for ${formatDate(localDate)}\n</readiness>`
    );
  }

  if (data.actions.length === 0) {
    volatile.push("<todays_actions>\nNo actions yet today.\n</todays_actions>");
  } else {
    const body = data.actions
      .map((a) => `${a.local_time ?? "??:??"} — ${a.tool}: ${a.summary}`)
      .join("\n");
    volatile.push(`<todays_actions>\n${body}\n</todays_actions>`);
  }

  if (data.summaries.length === 0) {
    volatile.push(
      "<daily_summaries>\nNone pre-loaded. Use get_history to retrieve when needed.\n</daily_summaries>"
    );
  } else {
    const body = data.summaries
      .map((s) => `${formatDate(s.date)}: ${s.summary ?? ""}`)
      .join("\n\n");
    volatile.push(
      `<daily_summaries count="${data.summaries.length}">\n${body}\n</daily_summaries>`
    );
  }

  if (tab === "coach") {
    if (data.insights.length === 0) {
      volatile.push(
        '<todays_insights count="0">\nNone yet today.\n</todays_insights>'
      );
    } else {
      const body = data.insights
        .map(
          (i) =>
            `[${i.type} — significance ${i.significance}]\n${i.content ?? ""}`
        )
        .join("\n\n");
      volatile.push(
        `<todays_insights count="${data.insights.length}">\n${body}\n</todays_insights>`
      );
    }
  }

  const crossTabMessages = data.messages.filter((m) => m.tab !== tab);
  if (crossTabMessages.length === 0) {
    volatile.push(
      "<cross_tab_messages>\nNo messages today from other tabs.\n</cross_tab_messages>"
    );
  } else {
    const body = crossTabMessages
      .map((m) => {
        const role = (m.role ?? "").toLowerCase();
        return `[${m.tab}] ${role}: ${m.content ?? ""}`;
      })
      .join("\n");
    volatile.push(`<cross_tab_messages>\n${body}\n</cross_tab_messages>`);
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

  volatile.push(`<context_index>\n${indexBody}\n</context_index>`);

  return {
    stableBlock: stable.join("\n\n"),
    volatileBlock: volatile.join("\n\n"),
    trainingStateBlock,
    patternsBlock,
  };
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
    insightsResult,
    contextIndexResult,
    actionsResult,
    trainingStateResult,
    patternsResult,
  ] = await Promise.allSettled([
    loadChatSystemPrompt(tab),
    getAthleteProfile(athleteId),
    getUserPreferences(athleteId),
    getActiveMesocycle(athleteId, localDate),
    getCurrentWeeklyPlan(athleteId, weekStart),
    getTodaysPlan(athleteId, localDate),
    getTodaysReadiness(athleteId, localDate),
    getTodaysMessages(athleteId, localDate, tab),
    getRecentSummaries(athleteId, localDate, SUMMARY_LIMIT[tab]),
    // Insights are only rendered on the coach tab — skip the fetch elsewhere
    tab === "coach"
      ? getTodaysInsights(athleteId, localDate)
      : Promise.resolve([]),
    getContextIndexCounts(athleteId),
    getTodaysActions(athleteId, localDate),
    getTrainingState(athleteId, localDate),
    getLatestPatterns(athleteId),
  ]);

  const systemPrompt =
    promptResult.status === "fulfilled" ? promptResult.value : "";
  if (promptResult.status === "rejected") {
    console.error("[buildContext] loadChatSystemPrompt failed:", promptResult.reason);
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

  const insights =
    insightsResult.status === "fulfilled" ? insightsResult.value : [];
  if (insightsResult.status === "rejected") {
    console.error(
      "[buildContext] getTodaysInsights failed:",
      insightsResult.reason
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

  const actions =
    actionsResult.status === "fulfilled" ? actionsResult.value : [];
  if (actionsResult.status === "rejected") {
    console.error(
      "[buildContext] getTodaysActions failed:",
      actionsResult.reason
    );
  }

  const trainingState =
    trainingStateResult.status === "fulfilled" ? trainingStateResult.value : null;
  if (trainingStateResult.status === "rejected") {
    console.error(
      "[buildContext] getTrainingState failed:",
      trainingStateResult.reason
    );
  }

  const patterns =
    patternsResult.status === "fulfilled" ? patternsResult.value : null;
  if (patternsResult.status === "rejected") {
    console.error("[buildContext] getLatestPatterns failed:", patternsResult.reason);
  }

  const { stableBlock, volatileBlock, trainingStateBlock, patternsBlock } =
    formatContext(tab, localDate, weekStart, localTime, {
      profile,
      preferences,
      mesocycle,
      weeklyPlan,
      todayPlan,
      readiness,
      messages,
      summaries,
      insights,
      contextIndex,
      actions,
      trainingState,
      patterns,
    });

  const fullSystemPrompt = `${systemPrompt}\n\n<persistent_context>\n${stableBlock}\n</persistent_context>`;

  return {
    systemPrompt: fullSystemPrompt,
    volatileBlock,
    trainingStateBlock,
    patternsBlock,
  };
}