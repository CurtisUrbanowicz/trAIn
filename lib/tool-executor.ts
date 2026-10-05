import { supabase } from "./supabase";
import { getWeekStartMondayUtc } from "./context";
import { pushLog } from "./debugLog";
import { MUTATING_TOOLS } from "./tools";

export type ToolContext = {
  athleteId: string;
  localDate: string;
  localTime?: string;
};

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDateLabel(ymd: string): string {
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const date = new Date(ymd + "T00:00:00Z");
  return `${ymd} (${days[date.getUTCDay()]})`;
}

// ── Retrieval executors ─────────────────────────────────────────

async function getHistory(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const table = input.table as string;
  const dateFrom = input.date_from as string | undefined;
  const dateTo = input.date_to as string | undefined;
  const limit = (input.limit as number) ?? 20;

  switch (table) {
    case "sets":
      return getHistorySets(input, context, dateFrom, dateTo, limit);
    case "runs":
      return getHistoryRuns(input, context, dateFrom, dateTo, limit);
    case "daily_summaries":
      return getHistorySummaries(context, dateFrom, dateTo, limit);
    case "readiness":
      return getHistoryReadiness(context, dateFrom, dateTo, limit);
    default:
      return `Unknown table: ${table}`;
  }
}

async function getHistorySets(
  input: Record<string, unknown>,
  context: ToolContext,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  limit: number
): Promise<string> {
  const exercise = input.exercise as string | undefined;

  // Query 1: get distinct dates matching filters
  let datesQuery = supabase
    .from("sets")
    .select("date")
    .eq("athlete_id", context.athleteId)
    .order("date", { ascending: false });

  if (exercise) datesQuery = datesQuery.eq("exercise", exercise);
  if (dateFrom) datesQuery = datesQuery.gte("date", dateFrom);
  if (dateTo) datesQuery = datesQuery.lte("date", dateTo);

  const { data: dateRows, error: dateError } = await datesQuery;
  if (dateError) return `Error querying sets dates: ${dateError.message}`;
  if (!dateRows || dateRows.length === 0) return "No sets found.";

  const distinctDates = Array.from(
    new Set(dateRows.map((r: { date: string }) => r.date))
  ).slice(0, limit);

  // Query 2: fetch all rows for those dates
  let setsQuery = supabase
    .from("sets")
    .select("id, date, exercise, weight_kg, reps, rir, notes, timestamp")
    .eq("athlete_id", context.athleteId)
    .in("date", distinctDates)
    .order("date", { ascending: false })
    .order("timestamp", { ascending: true });

  if (exercise) setsQuery = setsQuery.eq("exercise", exercise);

  const { data: sets, error: setsError } = await setsQuery;
  if (setsError) return `Error querying sets: ${setsError.message}`;
  if (!sets || sets.length === 0) return "No sets found.";

  // Group by date
  const grouped = new Map<string, typeof sets>();
  for (const row of sets) {
    const existing = grouped.get(row.date);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.date, [row]);
    }
  }

  const lines: string[] = [];
  for (const date of distinctDates) {
    const rows = grouped.get(date);
    if (!rows) continue;
    lines.push(formatDateLabel(date) + ":");
    for (const r of rows) {
      let line = `  ${r.exercise}: ${r.weight_kg}kg × ${r.reps}`;
      if (r.rir != null) line += ` @ RIR ${r.rir}`;
      if (r.notes) line += ` — ${r.notes}`;
      line += ` [id: ${r.id}]`;
      lines.push(line);
    }
  }

  return lines.join("\n");
}

async function getHistoryRuns(
  input: Record<string, unknown>,
  context: ToolContext,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  limit: number
): Promise<string> {
  const runType = input.run_type as string | undefined;

  let query = supabase
    .from("runs")
    .select("id, date, distance_km, duration_min, avg_pace, avg_hr, run_type, notes")
    .eq("athlete_id", context.athleteId)
    .order("date", { ascending: false })
    .limit(limit);

  if (runType) query = query.eq("run_type", runType);
  if (dateFrom) query = query.gte("date", dateFrom);
  if (dateTo) query = query.lte("date", dateTo);

  const { data, error } = await query;
  if (error) return `Error querying runs: ${error.message}`;
  if (!data || data.length === 0) return "No runs found.";

  const lines: string[] = [];
  for (const r of data) {
    let line = `${formatDateLabel(r.date)}: ${r.distance_km}km ${r.run_type}`;
    if (r.duration_min != null) line += `, ${r.duration_min}min`;
    if (r.avg_pace) line += `, ${r.avg_pace}/km`;
    if (r.avg_hr != null) line += `, HR ${r.avg_hr}`;
    if (r.notes) line += ` — ${r.notes}`;
    line += ` [id: ${r.id}]`;
    lines.push(line);
  }

  return lines.join("\n");
}

async function getHistorySummaries(
  context: ToolContext,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  limit: number
): Promise<string> {
  let query = supabase
    .from("daily_summaries")
    .select("date, summary")
    .eq("athlete_id", context.athleteId)
    .order("date", { ascending: false })
    .limit(limit);

  if (dateFrom) query = query.gte("date", dateFrom);
  if (dateTo) query = query.lte("date", dateTo);

  const { data, error } = await query;
  if (error) return `Error querying summaries: ${error.message}`;
  if (!data || data.length === 0) return "No summaries found.";

  return data
    .map((r) => `${formatDateLabel(r.date)}: ${r.summary}`)
    .join("\n\n");
}

async function getHistoryReadiness(
  context: ToolContext,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  limit: number
): Promise<string> {
  let query = supabase
    .from("readiness")
    .select("date, hrv, rhr, recovery_score, sleep_hours")
    .eq("athlete_id", context.athleteId)
    .order("date", { ascending: false })
    .order("timestamp", { ascending: false })
    .limit(limit);

  if (dateFrom) query = query.gte("date", dateFrom);
  if (dateTo) query = query.lte("date", dateTo);

  const { data, error } = await query;
  if (error) return `Error querying readiness: ${error.message}`;
  if (!data || data.length === 0) return "No readiness data found.";

  const lines: string[] = [];
  for (const r of data) {
    const parts: string[] = [];
    if (r.hrv != null) parts.push(`HRV ${r.hrv}`);
    if (r.rhr != null) parts.push(`RHR ${r.rhr}`);
    if (r.recovery_score != null) parts.push(`Recovery ${r.recovery_score}`);
    if (r.sleep_hours != null) parts.push(`Sleep ${r.sleep_hours}h`);
    lines.push(`${formatDateLabel(r.date)}: ${parts.join(", ") || "no data"}`);
  }

  return lines.join("\n");
}

async function getWeeklyPlan(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const weekStart = input.week_start as string;

  const computedMonday = getWeekStartMondayUtc(weekStart);
  if (computedMonday !== weekStart) {
    return `week_start must be a Monday. Did you mean ${computedMonday}?`;
  }

  const { data, error } = await supabase
    .from("weekly_plans")
    .select("days")
    .eq("athlete_id", context.athleteId)
    .eq("week_start", weekStart)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return `Error querying weekly plan: ${error.message}`;
  if (!data || !data.days) return `No weekly plan found for week of ${formatDateLabel(weekStart)}.`;

  const dayKeys = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ] as const;

  const days = data.days as Record<
    string,
    { session_type?: string; notes?: string }
  >;

  const lines = [`Week of ${formatDateLabel(weekStart)}:`];
  for (let i = 0; i < dayKeys.length; i++) {
    const key = dayKeys[i]!;
    const dayDate = addDays(weekStart, i);
    const entry = days[key];
    const sessionType = entry?.session_type ?? "—";
    const notes = entry?.notes ?? "";
    const notesStr = notes ? ` — ${notes}` : "";
    lines.push(`  ${formatDateLabel(dayDate)}: ${sessionType}${notesStr}`);
  }

  return lines.join("\n");
}

async function getMesocycles(context: ToolContext): Promise<string> {
  const { data, error } = await supabase
    .from("mesocycles")
    .select("start_date, end_date, name, goal, structure, notes")
    .eq("athlete_id", context.athleteId)
    .order("start_date", { ascending: false });

  if (error) return `Error querying mesocycles: ${error.message}`;
  if (!data || data.length === 0) return "No mesocycles found.";

  const blocks: string[] = [];
  for (const m of data) {
    const header = m.name
      ? `${m.name} (${formatDateLabel(m.start_date)} to ${formatDateLabel(m.end_date)})`
      : `${formatDateLabel(m.start_date)} to ${formatDateLabel(m.end_date)}`;
    const lines = [header];
    if (m.goal) lines.push(`Goal: ${m.goal}`);
    if (m.structure) lines.push(`Structure: ${m.structure}`);
    if (m.notes) lines.push(`Notes: ${m.notes}`);
    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}

// ── Write executors ─────────────────────────────────────────────

async function logReadiness(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const date = (input.date as string) ?? context.localDate;

  const recoveryScore = input.recovery_score as number | null | undefined;
  if (recoveryScore != null && (recoveryScore < 0 || recoveryScore > 100)) {
    return "recovery_score must be between 0 and 100";
  }

  // One row per athlete per date (readiness_athlete_date_unique). Upsert
  // merges: supplied fields overwrite, omitted fields keep their stored
  // values. Any manual write relabels the row manual (source null), even
  // if it started as a Whoop sync.
  const row: Record<string, unknown> = {
    athlete_id: context.athleteId,
    date,
    source: null,
    timestamp: new Date().toISOString(),
  };
  if (input.hrv != null) row.hrv = input.hrv;
  if (input.rhr != null) row.rhr = input.rhr;
  if (input.recovery_score != null) row.recovery_score = input.recovery_score;
  if (input.sleep_hours != null) row.sleep_hours = input.sleep_hours;

  const { error } = await supabase
    .from("readiness")
    .upsert(row, { onConflict: "athlete_id,date" });
  if (error) return `Error logging readiness: ${error.message}`;

  const parts: string[] = [];
  if (input.hrv != null) parts.push(`HRV ${input.hrv}`);
  if (input.rhr != null) parts.push(`RHR ${input.rhr}`);
  if (input.recovery_score != null) parts.push(`Recovery ${input.recovery_score}`);
  if (input.sleep_hours != null) parts.push(`Sleep ${input.sleep_hours}h`);

  return `Logged readiness for ${date}: ${parts.join(", ")}`;
}

async function updateAthleteProfile(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const { error } = await supabase.from("athlete_profile").insert({
    athlete_id: context.athleteId,
    content: input.content as string,
    timestamp: new Date().toISOString(),
  });
  if (error) return `Error updating athlete profile: ${error.message}`;
  return "Athlete profile updated.";
}

async function updateUserPreferences(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const { error } = await supabase.from("user_preferences").insert({
    athlete_id: context.athleteId,
    content: input.content as string,
    timestamp: new Date().toISOString(),
  });
  if (error) return `Error updating user preferences: ${error.message}`;
  return "User preferences updated.";
}

async function createMesocycle(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const row: Record<string, unknown> = {
    athlete_id: context.athleteId,
    start_date: input.start_date as string,
    end_date: input.end_date as string,
    name: input.name as string,
    goal: input.goal as string,
    structure: input.structure as string,
    timestamp: new Date().toISOString(),
  };
  if (input.notes != null) row.notes = input.notes;

  const { error } = await supabase.from("mesocycles").insert(row);
  if (error) return `Error creating mesocycle: ${error.message}`;

  return `Mesocycle created: ${input.name} (${input.start_date} to ${input.end_date})`;
}

async function deleteLogEntry(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const table = input.table as string;
  const id = input.id as string;

  // Fetch the row to confirm it exists and belongs to this athlete
  const { data: row, error: fetchError } = await supabase
    .from(table)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) return `Error fetching entry: ${fetchError.message}`;
  if (!row) return `No entry found with id ${id} in ${table}.`;
  if (row.athlete_id !== context.athleteId)
    return `Entry ${id} does not belong to this athlete.`;

  // Delete
  const { error: deleteError } = await supabase
    .from(table)
    .delete()
    .eq("id", id);

  if (deleteError) return `Error deleting entry: ${deleteError.message}`;

  // Format response — exclude id, athlete_id, timestamp
  if (table === "sets") {
    let desc = `${row.exercise} ${row.weight_kg}x${row.reps}`;
    if (row.rir != null) desc += ` @ RIR ${row.rir}`;
    return `Deleted from sets: ${desc} on ${row.date}`;
  } else {
    let desc = `${row.distance_km}km ${row.run_type}`;
    if (row.avg_pace) desc += `, ${row.avg_pace}/km`;
    return `Deleted from runs: ${desc} on ${row.date}`;
  }
}

const NON_UPDATABLE = new Set(["athlete_id", "id", "timestamp"]);

async function updateLogEntry(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const table = input.table as string;
  const id = input.id as string;
  const updates = input.updates as Record<string, unknown>;

  const blockedKeys = Object.keys(updates).filter((k) => NON_UPDATABLE.has(k));
  if (blockedKeys.length > 0)
    return `Cannot update protected fields: ${blockedKeys.join(", ")}`;

  // Fetch current row
  const { data: row, error: fetchError } = await supabase
    .from(table)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) return `Error fetching entry: ${fetchError.message}`;
  if (!row) return `No entry found with id ${id} in ${table}.`;
  if (row.athlete_id !== context.athleteId)
    return `Entry ${id} does not belong to this athlete.`;

  // Capture old values for changed fields
  const oldValues: Record<string, unknown> = {};
  for (const key of Object.keys(updates)) {
    oldValues[key] = row[key];
  }

  // Step 3: Apply update
  const { error: updateError } = await supabase
    .from(table)
    .update(updates)
    .eq("id", id);

  if (updateError) return `Error updating entry: ${updateError.message}`;

  // Step 4: Return before/after
  const exercise = row.exercise ?? row.run_type ?? "";
  const date = row.date ?? "";
  const changes = Object.keys(updates)
    .map((k) => `${k} ${oldValues[k]} → ${updates[k]}`)
    .join(", ");

  return `Updated ${exercise} on ${date}: ${changes}`;
}

async function logSets(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const sets = input.sets as Array<Record<string, unknown>>;
  const date = (input.date as string) ?? context.localDate;
  const timestamp = new Date().toISOString();

  // Phase 1: Duplicate check — skip sets already logged
  const toInsert: Record<string, unknown>[] = [];
  for (const s of sets) {
    const { data: existing } = await supabase
      .from("sets")
      .select("id")
      .eq("athlete_id", context.athleteId)
      .eq("date", date)
      .eq("exercise", s.exercise as string)
      .eq("weight_kg", s.weight_kg as number)
      .eq("reps", s.reps as number)
      .limit(1);

    if (existing && existing.length > 0) continue;

    const row: Record<string, unknown> = {
      athlete_id: context.athleteId,
      date,
      exercise: s.exercise,
      weight_kg: s.weight_kg,
      reps: s.reps,
      timestamp,
    };
    if (s.rir != null) row.rir = s.rir;
    if (s.notes != null) row.notes = s.notes;
    toInsert.push(row);
  }

  // Phase 2: Insert non-duplicates
  if (toInsert.length > 0) {
    const { error } = await supabase.from("sets").insert(toInsert);
    if (error) return `Error logging sets: ${error.message}`;
  }

  // Phase 3: Return full session for this date
  const { data: allSets, error: fetchError } = await supabase
    .from("sets")
    .select("exercise, weight_kg, reps, rir")
    .eq("athlete_id", context.athleteId)
    .eq("date", date)
    .order("timestamp", { ascending: true });

  if (fetchError) return `Error fetching session: ${fetchError.message}`;
  if (!allSets || allSets.length === 0) return `No sets found for ${date}.`;

  const summaries = allSets.map((s) => {
    let desc = `${s.exercise} ${s.weight_kg}x${s.reps}`;
    if (s.rir != null) desc += ` @${s.rir}`;
    return desc;
  });

  return `Session for ${date}: ${summaries.join(", ")}. (${allSets.length} sets total)`;
}


async function logRun(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const date = (input.date as string) ?? context.localDate;

  const row: Record<string, unknown> = {
    athlete_id: context.athleteId,
    date,
    distance_km: input.distance_km,
    run_type: input.run_type,
    timestamp: new Date().toISOString(),
  };
  if (input.duration_min != null) row.duration_min = input.duration_min;
  if (input.avg_pace != null) row.avg_pace = input.avg_pace;
  if (input.avg_hr != null) row.avg_hr = input.avg_hr;
  if (input.notes != null) row.notes = input.notes;

  const { error } = await supabase.from("runs").insert(row);
  if (error) return `Error logging run: ${error.message}`;

  const parts = [`${input.distance_km}km ${input.run_type}`];
  if (input.avg_pace != null) parts.push(`${input.avg_pace}/km`);
  if (input.avg_hr != null) parts.push(`HR ${input.avg_hr}`);
  return `Logged: ${parts.join(", ")} on ${date}`;
}

async function commitWeeklyPlan(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const weekStart = input.week_start as string;

  const computedMonday = getWeekStartMondayUtc(weekStart);
  if (computedMonday !== weekStart) {
    return `week_start must be a Monday. Did you mean ${computedMonday}?`;
  }

  const { error } = await supabase.from("weekly_plans").insert({
    athlete_id: context.athleteId,
    week_start: weekStart,
    days: input.days,
    timestamp: new Date().toISOString(),
  });
  if (error) return `Error committing weekly plan: ${error.message}`;

  return `Weekly plan committed for week of ${weekStart} (Monday)`;
}

async function commitTodayPlan(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const row: Record<string, unknown> = {
    athlete_id: context.athleteId,
    date: context.localDate,
    type: "today_plan",
    session_type: input.session_type as string,
    timestamp: new Date().toISOString(),
  };
  if (input.notes != null) row.notes = input.notes;
  row.exercises = input.exercises != null ? input.exercises : null;

  const { error } = await supabase.from("plans").insert(row);
  if (error) return `Error committing today's plan: ${error.message}`;

  const sessionType = input.session_type as string;
  const notes = input.notes as string | undefined;
  const suffix = notes ? ` — ${notes}` : "";
  return `Today's plan committed: ${sessionType}${suffix}`;
}

async function daysBetween(input: Record<string, unknown>): Promise<string> {
  const dateFrom = input.date_from as string;
  const dateTo = input.date_to as string;
  const [yf, mf, df] = dateFrom.split("-").map(Number);
  const [yt, mt, dt] = dateTo.split("-").map(Number);
  const from = Date.UTC(yf!, mf! - 1, df!);
  const to = Date.UTC(yt!, mt! - 1, dt!);
  const diff = Math.abs(Math.round((to - from) / 86400000));
  return `${diff} days`;
}

// ── Main dispatcher ─────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  let result: string;
  switch (name) {
    // Retrieval
    case "get_history":
      result = await getHistory(input, context); break;
    case "get_weekly_plan":
      result = await getWeeklyPlan(input, context); break;
    case "get_mesocycles":
      result = await getMesocycles(context); break;
    // Write
    case "log_readiness":
      result = await logReadiness(input, context); break;
    case "update_athlete_profile":
      result = await updateAthleteProfile(input, context); break;
    case "update_user_preferences":
      result = await updateUserPreferences(input, context); break;
    case "create_mesocycle":
      result = await createMesocycle(input, context); break;
    case "delete_log_entry":
      result = await deleteLogEntry(input, context); break;
    case "update_log_entry":
      result = await updateLogEntry(input, context); break;
    case "log_sets":
      result = await logSets(input, context); break;
    case "log_run":
      result = await logRun(input, context); break;
    case "commit_weekly_plan":
      result = await commitWeeklyPlan(input, context); break;
    case "commit_today_plan":
      result = await commitTodayPlan(input, context); break;
    case "days_between":
      result = await daysBetween(input); break;
    case "log_insight": {
      const { type, content, significance } = input as {
        type: "pulse" | "deep";
        content: string;
        significance: number;
      };

      const { data, error } = await supabase
        .from("insights")
        .insert({
          athlete_id: context.athleteId,
          date: context.localDate,
          type,
          content,
          significance,
          status: "unsurfaced",
        })
        .select()
        .single();

      if (error) {
        // 23505: insights_athlete_date_type_unique — a concurrent pass (the
        // morning chain vs the on-mount Coach fallback) already logged this
        // date/type. Not an "Error" so the reflect loop treats the insight as
        // landed and reads the existing row.
        result =
          error.code === "23505"
            ? `Insight for ${type} on ${context.localDate} was already logged by a concurrent pass. Nothing more to do.`
            : `Error logging insight: ${error.message}`;
      } else {
        result = `Insight logged. id=${data.id}, type=${type}, significance=${significance}.`;
      }
      break;
    }
    default:
      result = `Unknown tool: ${name}`;
  }

  pushLog("tool_call", {
    name,
    input,
    result: result.length > 200 ? result.slice(0, 200) + "…" : result,
  });

  // Fire-and-forget: record successful write-tool executions to actions.
  // Must never throw or slow the tool call.
  if (
    MUTATING_TOOLS.has(name) &&
    !result.startsWith("Error") &&
    result !== `Unknown tool: ${name}`
  ) {
    try {
      void supabase
        .from("actions")
        .insert({
          athlete_id: context.athleteId,
          date: context.localDate,
          local_time: context.localTime ?? null,
          tool: name,
          summary: result.length > 300 ? result.slice(0, 300) : result,
        })
        .then(({ error }) => {
          if (error) console.error("[actions] insert failed:", error.message);
        });
    } catch (err) {
      console.error("[actions] insert threw:", err);
    }
  }

  return result;
}
