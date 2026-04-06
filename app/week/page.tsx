"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import ChatView from "@/app/components/ChatView";
import { ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from "lucide-react";

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

function formatMonday(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `Mon, ${months[date.getMonth()]} ${date.getDate()}`;
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

export default function WeekPage() {
  const [weekIndex, setWeekIndex] = useState(0); // 0 = this week, 1 = next week
  const [expanded, setExpanded] = useState(false);
  const [weekData, setWeekData] = useState<Record<number, WeekDays | null>>({});

  const today = getTodayYmd();
  const thisMonday = getMonday(new Date());
  const nextMonday = addDays(thisMonday, 7);
  const mondays = [thisMonday, nextMonday];
  const activeMonday = mondays[weekIndex]!;

  useEffect(() => {
    // Fetch both weeks in parallel
    Promise.all(
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
    ).then((results) => {
      const map: Record<number, WeekDays | null> = {};
      results.forEach((r) => {
        const idx = mondays.indexOf(r.monday);
        if (idx !== -1) map[idx] = r.days;
      });
      setWeekData(map);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const days = weekData[weekIndex] ?? null;
  const trainingCount = days
    ? DAY_KEYS.filter((k) => days[k]?.session_type && days[k]!.session_type !== "rest" && days[k]!.session_type !== "Rest").length
    : 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ChatView tab="week">
        {/* Week bar — always visible */}
        <div
          style={{
            background: "var(--bg-surface)",
            borderRadius: 12,
            border: "0.5px solid var(--border-default)",
            marginBottom: 16,
            overflow: "hidden",
          }}
        >
          {/* Collapsed header row */}
          <button
            type="button"
            onClick={() => days && setExpanded((e) => !e)}
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              padding: "12px 16px",
              background: "transparent",
              border: "none",
              cursor: days ? "pointer" : "default",
              gap: 8,
            }}
          >
            {/* Left/right week arrows */}
            <span
              onClick={(e) => {
                e.stopPropagation();
                if (weekIndex > 0) {
                  setWeekIndex(0);
                  setExpanded(false);
                }
              }}
              style={{
                color: weekIndex > 0 ? "var(--text-primary)" : "var(--text-muted)",
                opacity: weekIndex > 0 ? 1 : 0.3,
                cursor: weekIndex > 0 ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
              }}
            >
              <ChevronLeft size={16} />
            </span>

            {/* Week label */}
            <span
              style={{
                flex: 1,
                fontSize: 13,
                fontWeight: 600,
                color: days ? "var(--text-primary)" : "var(--text-muted)",
                textAlign: "left",
              }}
            >
              Week of {formatMonday(activeMonday)}
              {days
                ? ` — ${trainingCount} session${trainingCount !== 1 ? "s" : ""} planned`
                : " — no sessions planned"}
            </span>

            <span
              onClick={(e) => {
                e.stopPropagation();
                if (weekIndex < 1) {
                  setWeekIndex(1);
                  setExpanded(false);
                }
              }}
              style={{
                color: weekIndex < 1 ? "var(--text-primary)" : "var(--text-muted)",
                opacity: weekIndex < 1 ? 1 : 0.3,
                cursor: weekIndex < 1 ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
              }}
            >
              <ChevronRight size={16} />
            </span>

            {days && (
              <span style={{ color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </span>
            )}
          </button>

          {/* Expanded day list */}
          {expanded && days && (
            <div style={{ padding: "0 8px 8px" }}>
              {DAY_KEYS.map((key, i) => {
                const dateYmd = addDays(activeMonday, i);
                const entry = days[key];
                const isTraining =
                  entry?.session_type &&
                  entry.session_type !== "rest" &&
                  entry.session_type !== "Rest";
                const isToday = dateYmd === today;

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
                      background: isTraining ? "var(--bg-surface)" : "transparent",
                      borderLeft: isToday ? "2px solid var(--accent)" : "2px solid transparent",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        color: isTraining ? "var(--text-primary)" : "var(--text-muted)",
                      }}
                    >
                      {formatDayDate(dateYmd)}
                    </span>
                    <span
                      style={{
                        fontSize: 13,
                        color: isTraining ? "var(--text-primary)" : "var(--text-muted)",
                      }}
                    >
                      {entry?.session_type ?? "Rest"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ChatView>
    </div>
  );
}
