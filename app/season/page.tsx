"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import ChatView from "@/app/components/ChatView";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

// ── Helpers ──────────────────────────────────────────────────

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y!, m! - 1, d!);
  dt.setDate(dt.getDate() + n);
  return ymd(dt);
}

/** Monday of the ISO week containing `dateStr`. */
function isoMonday(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y!, m! - 1, d!);
  const day = dt.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  return ymd(dt);
}

function weeksBetween(a: string, b: string): number {
  const da = new Date(a);
  const db = new Date(b);
  return Math.floor((db.getTime() - da.getTime()) / (7 * 86400000));
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

const MESO_MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatMesoDate(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${MESO_MONTHS_SHORT[m! - 1]} ${d}`;
}

/** 0=Mon … 6=Sun for the 1st of the month. */
function startDayOffset(year: number, month: number): number {
  const d = new Date(year, month, 1).getDay(); // 0=Sun
  return d === 0 ? 6 : d - 1;
}

// ── Types ────────────────────────────────────────────────────

type Meso = {
  start_date: string;
  end_date: string;
  goal: string;
  name: string | null;
};

type SetRow = { date: string; exercise: string; weight_kg: number };
type RunRow = { date: string; distance_km: number };

type TimeRange = "4w" | "12w" | "52w";
const TIME_RANGES: TimeRange[] = ["4w", "12w", "52w"];
const RANGE_WEEKS: Record<TimeRange, number> = { "4w": 4, "12w": 12, "52w": 52 };

// ── Component ────────────────────────────────────────────────

export default function SeasonPage() {
  const [meso, setMeso] = useState<Meso | null>(null);
  const [activityDates, setActivityDates] = useState<Set<string>>(new Set());
  const [sets, setSets] = useState<SetRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [exercises, setExercises] = useState<string[]>([]);
  const [selectedExercise, setSelectedExercise] = useState<string>("");
  const [liftRange, setLiftRange] = useState<TimeRange>("4w");
  const [runRange, setRunRange] = useState<TimeRange>("4w");
  const [loaded, setLoaded] = useState(false);

  const today = todayYmd();

  // Date range for queries: 52 weeks back covers all toggle options + calendar
  const rangeStart = useMemo(() => addDays(today, -52 * 7), [today]);

  const fetchMeso = async () => {
    const { data } = await supabase
      .from("mesocycles")
      .select("start_date, end_date, goal, name")
      .eq("athlete_id", ATHLETE_ID)
      .lte("start_date", today)
      .gte("end_date", today)
      .order("timestamp", { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      setMeso(data[0] as Meso);
    } else {
      setMeso(null);
    }
  };

  useEffect(() => {
    const fetchAll = async () => {
      const [setsRes, runsRes] = await Promise.all([
        supabase
          .from("sets")
          .select("date, exercise, weight_kg")
          .eq("athlete_id", ATHLETE_ID)
          .gte("date", rangeStart)
          .lte("date", today)
          .order("date", { ascending: true }),
        supabase
          .from("runs")
          .select("date, distance_km")
          .eq("athlete_id", ATHLETE_ID)
          .gte("date", rangeStart)
          .lte("date", today)
          .order("date", { ascending: true }),
      ]);

      // Sets
      const setsData = (setsRes.data ?? []) as SetRow[];
      setSets(setsData);

      // Distinct exercises
      const exNames = Array.from(
        new Set(setsData.map((s) => s.exercise).filter(Boolean))
      ).sort();
      setExercises(exNames);
      if (exNames.length > 0) setSelectedExercise(exNames[0]!);

      // Runs
      const runsData = (runsRes.data ?? []) as RunRow[];
      setRuns(runsData);

      // Activity dates (union of sets + runs dates)
      const dates = new Set<string>();
      setsData.forEach((s) => dates.add(s.date));
      runsData.forEach((r) => dates.add(r.date));
      setActivityDates(dates);

      setLoaded(true);
    };

    fetchMeso();
    fetchAll();

  }, []);

  useEffect(() => {
    const channel = supabase
      .channel('season-meso')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'mesocycles', filter: `athlete_id=eq.${ATHLETE_ID}` },
        () => fetchMeso()
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  // ── Meso progress ───────────────────────────────────────────

  const mesoProgress = useMemo(() => {
    if (!meso) return null;
    const totalWeeks = weeksBetween(isoMonday(meso.start_date), isoMonday(meso.end_date)) + 1;
    const elapsed = weeksBetween(isoMonday(meso.start_date), isoMonday(today));
    const weekNum = Math.min(Math.max(elapsed + 1, 1), totalWeeks);
    const pct = totalWeeks > 0 ? Math.min((elapsed / totalWeeks) * 100, 100) : 0;
    return { weekNum, totalWeeks, pct };
  }, [meso, today]);

  // ── Calendar months ─────────────────────────────────────────

  const calendarMonths = useMemo(() => {
    const d = new Date();
    const thisMonth = d.getMonth();
    const thisYear = d.getFullYear();
    const prevMonth = thisMonth === 0 ? 11 : thisMonth - 1;
    const prevYear = thisMonth === 0 ? thisYear - 1 : thisYear;
    return [
      { year: prevYear, month: prevMonth },
      { year: thisYear, month: thisMonth },
    ];
  }, []);

  // ── Lifting chart data ──────────────────────────────────────

  const liftChartData = useMemo(() => {
    if (!selectedExercise) return [];
    const weeksBack = RANGE_WEEKS[liftRange];
    const cutoff = addDays(today, -weeksBack * 7);

    const filtered = sets.filter(
      (s) => s.exercise === selectedExercise && s.date >= cutoff
    );

    // Group by date, take max weight
    const byDate = new Map<string, number>();
    for (const s of filtered) {
      const prev = byDate.get(s.date) ?? 0;
      if (s.weight_kg > prev) byDate.set(s.date, s.weight_kg);
    }

    return Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, weight]) => ({ date, weight }));
  }, [sets, selectedExercise, liftRange, today]);

  // ── Running volume chart data ───────────────────────────────

  const runChartData = useMemo(() => {
    const weeksBack = RANGE_WEEKS[runRange];
    const cutoff = addDays(today, -weeksBack * 7);

    const filtered = runs.filter((r) => r.date >= cutoff);

    // Group by ISO week Monday
    const byWeek = new Map<string, number>();
    for (const r of filtered) {
      const mon = isoMonday(r.date);
      byWeek.set(mon, (byWeek.get(mon) ?? 0) + r.distance_km);
    }

    return Array.from(byWeek.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, km]) => ({
        week: week.slice(5), // "MM-DD"
        km: Math.round(km * 10) / 10,
      }));
  }, [runs, runRange, today]);

  // ── Render ──────────────────────────────────────────────────

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const DAY_HEADERS = ["M", "T", "W", "T", "F", "S", "S"];

  const sectionGap = 24;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ChatView tab="season" autoOpen={false}>
        {loaded && (
          <div style={{ display: "flex", flexDirection: "column", gap: sectionGap, marginBottom: 24 }}>

            {/* ── Section 1: Meso indicator ── */}
            <div
              style={{
                background: "var(--bg-surface)",
                borderRadius: 12,
                border: "1px solid var(--border-default)",
                padding: "10px 16px",
              }}
            >
              {meso && mesoProgress ? (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <p
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                        margin: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                        marginRight: 12,
                      }}
                    >
                      {meso.name ? meso.name : `${formatMesoDate(meso.start_date)} – ${formatMesoDate(meso.end_date)}`}
                    </p>
                    <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      Week {mesoProgress.weekNum} of {mesoProgress.totalWeeks}
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      height: 3,
                      borderRadius: 2,
                      background: "var(--bg-surface-hover)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${mesoProgress.pct}%`,
                        background: "var(--accent)",
                        borderRadius: 2,
                      }}
                    />
                  </div>
                </>
              ) : (
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                  No active training block
                </p>
              )}
            </div>

            {/* ── Section 2: Training calendar ── */}
            <div style={{ display: "flex", gap: 12 }}>
              {calendarMonths.map(({ year, month }) => {
                const days = daysInMonth(year, month);
                const offset = startDayOffset(year, month);

                return (
                  <div key={`${year}-${month}`} style={{ flex: 1 }}>
                    <p
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                        margin: "0 0 8px 0",
                      }}
                    >
                      {MONTH_NAMES[month]} {year}
                    </p>

                    {/* Day-of-week headers */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                      {DAY_HEADERS.map((d, i) => (
                        <div
                          key={i}
                          style={{
                            textAlign: "center",
                            fontSize: 11,
                            color: "var(--text-muted)",
                            height: 20,
                            lineHeight: "20px",
                          }}
                        >
                          {d}
                        </div>
                      ))}

                      {/* Empty offset cells */}
                      {Array.from({ length: offset }).map((_, i) => (
                        <div key={`blank-${i}`} style={{ height: 32 }} />
                      ))}

                      {/* Day cells */}
                      {Array.from({ length: days }).map((_, i) => {
                        const dayNum = i + 1;
                        const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
                        const hasActivity = activityDates.has(dateStr);
                        const isFuture = dateStr > today;

                        return (
                          <div
                            key={dayNum}
                            style={{
                              height: 32,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              borderRadius: 6,
                              fontSize: 11,
                              background: hasActivity && !isFuture
                                ? "rgba(94,106,210,0.3)"
                                : "transparent",
                              color: isFuture
                                ? "rgba(138,143,152,0.5)"
                                : hasActivity
                                  ? "var(--text-primary)"
                                  : "var(--text-muted)",
                            }}
                          >
                            {dayNum}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── Section 3: Lifting trends ── */}
            {exercises.length > 0 && (
              <div>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    margin: "0 0 12px 0",
                  }}
                >
                  Lifting Trends
                </p>

                {liftChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={liftChartData}>
                      <XAxis
                        dataKey="date"
                        tickFormatter={(v: string) => v.slice(5)}
                        tick={{ fontSize: 11, fill: "#8A8F98" }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: "#8A8F98" }}
                        axisLine={false}
                        tickLine={false}
                        width={35}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#1a1a1c",
                          border: "0.5px solid rgba(255,255,255,0.06)",
                          borderRadius: 8,
                          fontSize: 12,
                          color: "#EDEDEF",
                        }}
                        labelFormatter={(v: any) => String(v)}
                        formatter={(value: any) => [`${value} kg`, "Weight"]}
                      />
                      <Line
                        type="monotone"
                        dataKey="weight"
                        stroke="#5E6AD2"
                        strokeWidth={2}
                        dot={{ r: 3, fill: "#5E6AD2" }}
                        activeDot={{ r: 5 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                    No data for this range
                  </p>
                )}

                {/* Exercise toggles */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  {exercises.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => setSelectedExercise(ex)}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 12,
                        color: ex === selectedExercise ? "var(--text-primary)" : "var(--text-muted)",
                        padding: "2px 0",
                      }}
                    >
                      {ex}
                    </button>
                  ))}
                </div>

                {/* Time range toggle */}
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  {TIME_RANGES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setLiftRange(r)}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 12,
                        color: r === liftRange ? "var(--text-primary)" : "var(--text-muted)",
                        padding: "2px 0",
                      }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Section 4: Running volume ── */}
            {runs.length > 0 && (
              <div>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    margin: "0 0 12px 0",
                  }}
                >
                  Running Volume
                </p>

                {runChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={runChartData}>
                      <XAxis
                        dataKey="week"
                        tick={{ fontSize: 11, fill: "#8A8F98" }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: "#8A8F98" }}
                        axisLine={false}
                        tickLine={false}
                        width={35}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#1a1a1c",
                          border: "0.5px solid rgba(255,255,255,0.06)",
                          borderRadius: 8,
                          fontSize: 12,
                          color: "#EDEDEF",
                        }}
                        formatter={(value: any) => [`${value} km`, "Distance"]}
                      />
                      <Bar
                        dataKey="km"
                        fill="rgba(94,106,210,0.6)"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                    No data for this range
                  </p>
                )}

                {/* Time range toggle */}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  {TIME_RANGES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRunRange(r)}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 12,
                        color: r === runRange ? "var(--text-primary)" : "var(--text-muted)",
                        padding: "2px 0",
                      }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </ChatView>
    </div>
  );
}
