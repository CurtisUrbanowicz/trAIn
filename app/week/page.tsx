"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  addDays,
  formatDayDate,
  formatShortDate,
  getLocalDate,
  isoMonday,
} from "@/lib/dates";
import { useRealtimeInsert } from "@/lib/useRealtimeInsert";
import { formatSessionType } from "@/lib/format";
import ChatView from "@/app/components/ChatView";
import { ChevronDown, Check } from "lucide-react";

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

type DayEntry = { session_type?: string; notes?: string };
type WeekDays = Record<string, DayEntry>;

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
  const [shouldNudge, setShouldNudge] = useState(false);

  const today = getLocalDate();
  const thisMonday = isoMonday(today);
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

        const dow = (new Date().getDay() + 6) % 7;
        if (dow >= 3 && map[1] == null) setShouldNudge(true);

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

  useRealtimeInsert("week-plan", "weekly_plans", fetchWeekData, `athlete_id=eq.${ATHLETE_ID}`);

  const thisWeekDays = weekData[0] ?? null;
  const nextWeekDays = weekData[1] ?? null;
  const thisCount = countPlanned(thisWeekDays);
  const nextCount = countPlanned(nextWeekDays);
  const thisDoneCount = thisWeekDays
    ? DAY_KEYS.filter(
        (k, i) =>
          isTrainingDay(thisWeekDays[k]) &&
          completedDates.has(addDays(thisMonday, i))
      ).length
    : 0;

  function DayRow({
    dateYmd,
    entry,
    isFirst,
    isNext,
  }: {
    dateYmd: string;
    entry: DayEntry | undefined;
    isFirst: boolean;
    isNext: boolean;
  }) {
    const training = isTrainingDay(entry);
    const isToday = dateYmd === today;
    const completed = completedDates.has(dateYmd);
    const dayNum = Number(dateYmd.split("-")[2]);
    const weekday = formatDayDate(dateYmd).slice(0, 3).toUpperCase();

    let dayNumColor = "var(--text-primary)";
    if (isToday) dayNumColor = "var(--accent)";
    else if (!training || isNext) dayNumColor = "var(--text-muted)";

    let weekdayColor = "var(--text-muted)";
    if (isToday) weekdayColor = "var(--accent)";

    let typeColor = "var(--text-primary)";
    if (!training) typeColor = "var(--text-muted)";
    else if (completed || isNext) typeColor = "var(--text-muted)";

    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "44px 1fr auto",
          gap: 12,
          alignItems: "center",
          padding: "0 14px 0 12px",
          height: 28,
          borderTop: isFirst ? "none" : "0.5px solid var(--border-default)",
          borderLeft: isToday
            ? "2px solid var(--accent)"
            : "2px solid transparent",
          background: isToday
            ? "linear-gradient(to right, rgba(94,106,210,0.14), transparent 60%)"
            : "transparent",
          overflow: "hidden",
          lineHeight: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 4,
            lineHeight: 1,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 14,
              fontWeight: 500,
              letterSpacing: "-0.005em",
              color: dayNumColor,
            }}
          >
            {dayNum}
          </span>
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: weekdayColor,
            }}
          >
            {weekday}
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            minWidth: 0,
            overflow: "hidden",
            lineHeight: 1,
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              fontWeight: training ? 500 : 400,
              letterSpacing: "-0.003em",
              color: typeColor,
              fontStyle: training ? "normal" : "italic",
              opacity: training ? 1 : 0.7,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 0,
              lineHeight: 1,
            }}
          >
            {entry?.session_type
              ? formatSessionType(entry.session_type)
              : "Rest"}
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            minWidth: 16,
          }}
        >
          {completed && (
            <span
              aria-label="Completed"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "rgba(94, 234, 154, 0.18)",
                color: "#5BD0A0",
              }}
            >
              <Check size={12} strokeWidth={3} />
            </span>
          )}
        </div>
      </div>
    );
  }

  function renderSection(
    label: string,
    days: WeekDays | null,
    plannedCount: number,
    doneCount: number,
    monday: string,
    expanded: boolean,
    setExpanded: (v: boolean) => void,
    isNext: boolean
  ) {
    const subtitle = `${formatShortDate(monday)} — ${formatShortDate(addDays(monday, 6))}`;
    const countText = isNext
      ? plannedCount > 0
        ? `${plannedCount} planned`
        : "none planned"
      : `${doneCount}/${plannedCount}`;

    return (
      <section
        style={{
          background: isNext ? "transparent" : "var(--bg-surface)",
          border: "0.5px solid var(--border-default)",
          borderStyle: isNext ? "dashed" : "solid",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            height: 26,
            padding: "0 14px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            color: "inherit",
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              minWidth: 0,
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-muted)",
                transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
                transition: "transform 180ms ease",
                alignSelf: "center",
              }}
            >
              <ChevronDown size={12} strokeWidth={2.5} />
            </span>
            <span
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: 15,
                fontWeight: 500,
                letterSpacing: "-0.005em",
                color: isNext ? "var(--text-muted)" : "var(--text-primary)",
                lineHeight: 1,
              }}
            >
              {label}
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--text-muted)",
                opacity: 0.65,
                lineHeight: 1,
              }}
            >
              {subtitle}
            </span>
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              color: "var(--text-muted)",
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
            }}
          >
            {countText}
          </span>
        </button>

        {expanded && days && (
          <div
            style={{
              padding: 0,
              borderTop: "0.5px solid var(--border-default)",
              borderTopStyle: isNext ? "dashed" : "solid",
            }}
          >
            {DAY_KEYS.map((key, i) => (
              <DayRow
                key={key}
                dateYmd={addDays(monday, i)}
                entry={days[key]}
                isFirst={i === 0}
                isNext={isNext}
              />
            ))}
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ChatView tab="week" autoOpen={shouldNudge}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
          {renderSection(
            "This week",
            thisWeekDays,
            thisCount,
            thisDoneCount,
            thisMonday,
            thisExpanded,
            setThisExpanded,
            false
          )}
          {renderSection(
            "Next week",
            nextWeekDays,
            nextCount,
            0,
            nextMonday,
            nextExpanded,
            setNextExpanded,
            true
          )}
        </div>
      </ChatView>
    </div>
  );
}
