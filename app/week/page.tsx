"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { formatSessionType } from "@/lib/format";
import ChatView from "@/app/components/ChatView";
import { ChevronDown, ChevronUp, Check } from "lucide-react";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type DayEntry = { session_type?: string; notes?: string };
type WeekDays = Record<string, DayEntry>;

function getMonday(date: Date): string {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getTodayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDayDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayIdx = (date.getDay() + 6) % 7; // Mon=0
  return `${SHORT_DAYS[dayIdx]} ${months[date.getMonth()]} ${date.getDate()}`;
}

function isTrainingDay(entry?: DayEntry): boolean {
  return !!entry?.session_type && entry.session_type !== "rest" && entry.session_type !== "Rest";
}

function countPlanned(days: WeekDays | null): number {
  if (!days) return 0;
  return DAY_KEYS.filter((k) => isTrainingDay(days[k])).length;
}

export default function WeekPage() {
  const [thisExpanded, setThisExpanded] = useState(false);
  const [nextExpanded, setNextExpanded] = useState(false);
  const [weekData, setWeekData] = useState<Record<number, WeekDays | null>>({});
  const [completedDates, setCompletedDates] = useState<Set<string>>(new Set());

  const today = getTodayYmd();
  const thisMonday = getMonday(new Date());
  const nextMonday = addDays(thisMonday, 7);
  const nextSunday = addDays(nextMonday, 6);
  const mondays = [thisMonday, nextMonday];

  const fetchWeekData = () => {
    // Fetch both weekly plans
    const plansPromise = Promise.all(
      mondays.map((monday) =>
        supabase
          .from("weekly_plans")
          .select("days")
          .eq("athlete_id", ATHLETE_ID)
          .eq("week_start", monday)
          .order("timestamp", { ascending: false })
          .limit(1)
          .then(({ data }) => {
            const days = data && data.length > 0 ? (data[0].days as WeekDays) : null;
            return { monday, days };
          })
      )
    );

    // Fetch completed sessions across both weeks in a single range per table
    const runsPromise = supabase
      .from("runs")
      .select("date")
      .eq("athlete_id", ATHLETE_ID)
      .gte("date", thisMonday)
      .lte("date", nextSunday);

    const setsPromise = supabase
      .from("sets")
      .select("date")
      .eq("athlete_id", ATHLETE_ID)
      .gte("date", thisMonday)
      .lte("date", nextSunday);

    Promise.all([plansPromise, runsPromise, setsPromise]).then(
      ([planResults, runsResult, setsResult]) => {
        // Week plans
        const map: Record<number, WeekDays | null> = {};
        planResults.forEach((r) => {
          const idx = mondays.indexOf(r.monday);
          if (idx !== -1) map[idx] = r.days;
        });
        setWeekData(map);

        // Auto-expand current week if it has a plan
        if (map[0]) setThisExpanded(true);

        // Completed dates
        const dates = new Set<string>();
        runsResult.data?.forEach((r: { date: string }) => dates.add(r.date));
        setsResult.data?.forEach((r: { date: string }) => dates.add(r.date));
        setCompletedDates(dates);
      }
    );
  };

  useEffect(() => {
    fetchWeekData();
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel('week-plan')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'weekly_plans', filter: `athlete_id=eq.${ATHLETE_ID}` },
        () => fetchWeekData()
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const thisWeekDays = weekData[0] ?? null;
  const nextWeekDays = weekData[1] ?? null;
  const thisCount = countPlanned(thisWeekDays);
  const nextCount = countPlanned(nextWeekDays);

  function renderSection(
    label: string,
    days: WeekDays | null,
    count: number,
    monday: string,
    expanded: boolean,
    setExpanded: (v: boolean) => void
  ) {
    return (
      <div
        style={{
          background: "var(--bg-surface)",
          borderRadius: 12,
          border: "1px solid var(--border-default)",
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            display: "flex",
            alignItems: "center",
            width: "100%",
            padding: "12px 16px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            gap: 8,
          }}
        >
          <span
            style={{
              flex: 1,
              fontSize: 13,
              fontWeight: 600,
              color: days ? "var(--text-primary)" : "var(--text-muted)",
              textAlign: "left",
            }}
          >
            {label} — {count > 0 ? `${count} planned` : "none planned"}
          </span>
          <span style={{ color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </button>

        {expanded && days && (
          <div style={{ padding: "0 8px 8px" }}>
            {DAY_KEYS.map((key, i) => {
              const dateYmd = addDays(monday, i);
              const entry = days[key];
              const training = isTrainingDay(entry);
              const isToday = dateYmd === today;
              const completed = completedDates.has(dateYmd);

              return (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    height: 40,
                    padding: "0 12px",
                    borderRadius: 8,
                    background: training ? "var(--bg-surface)" : "transparent",
                    borderLeft: isToday ? "2px solid var(--accent)" : "2px solid transparent",
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      color: training ? "var(--text-primary)" : "var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {formatDayDate(dateYmd)}
                    {completed && (
                      <Check size={14} style={{ color: "#22c55e" }} strokeWidth={2.5} />
                    )}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      color: training ? "var(--text-primary)" : "var(--text-muted)",
                    }}
                  >
                    {entry?.session_type ? formatSessionType(entry.session_type) : "Rest"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ChatView tab="week">
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
          {renderSection("This week", thisWeekDays, thisCount, thisMonday, thisExpanded, setThisExpanded)}
          {renderSection("Next week", nextWeekDays, nextCount, nextMonday, nextExpanded, setNextExpanded)}
        </div>
      </ChatView>
    </div>
  );
}
