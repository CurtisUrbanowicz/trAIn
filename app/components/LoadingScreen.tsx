"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";
const FALLBACK = "Catching up on your training...";

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function daysBetween(a: string, b: string): number {
  return Math.floor(
    (new Date(b).getTime() - new Date(a).getTime()) / 86400000
  );
}

export default function LoadingScreen() {
  const [state, setState] = useState<"pending" | "visible" | "fading" | "hidden">("pending");
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const dismissed = useRef(false);

  const dismiss = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    localStorage.setItem("lastOpenDate", todayStr());
    setState("fading");
    setTimeout(() => setState("hidden"), 300);
  }, []);

  useEffect(() => {
    const lastOpen = localStorage.getItem("lastOpenDate");
    if (lastOpen === todayStr()) {
      setState("hidden");
      return;
    }

    setState("visible");

    // Show fallback immediately, then try to upgrade with Supabase data
    const timeout = setTimeout(() => {
      setSubtitle(FALLBACK);
    }, 300);

    const today = todayStr();
    Promise.all([
      supabase
        .from("sets")
        .select("date")
        .eq("athlete_id", ATHLETE_ID)
        .order("date", { ascending: false })
        .limit(1),
      supabase
        .from("runs")
        .select("date")
        .eq("athlete_id", ATHLETE_ID)
        .order("date", { ascending: false })
        .limit(1),
      supabase
        .from("mesocycles")
        .select("start_date, end_date")
        .eq("athlete_id", ATHLETE_ID)
        .lte("start_date", today)
        .gte("end_date", today)
        .order("start_date", { ascending: false })
        .limit(1),
    ])
      .then(([setsResult, runsResult, mesoResult]) => {
        clearTimeout(timeout);

        const setsDate = setsResult.data?.[0]?.date as string | undefined;
        const runsDate = runsResult.data?.[0]?.date as string | undefined;
        const lastDate = setsDate && runsDate
          ? (setsDate > runsDate ? setsDate : runsDate)
          : setsDate || runsDate;

        if (lastDate) {
          const gap = daysBetween(lastDate, today);
          if (gap === 1) { setSubtitle("Catching up on yesterday's session..."); return; }
          if (gap >= 3) { setSubtitle("Been a few days — let's see where you're at..."); return; }
        }

        const meso = mesoResult.data?.[0];
        if (meso) {
          const weekNum = Math.ceil(
            (daysBetween(meso.start_date as string, today) + 1) / 7
          );
          setSubtitle(`Week ${weekNum} of your block...`);
          return;
        }

        setSubtitle(FALLBACK);
      })
      .catch(() => {
        clearTimeout(timeout);
        setSubtitle(FALLBACK);
      });

    return () => clearTimeout(timeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-dismiss 2s after subtitle renders
  useEffect(() => {
    if (!subtitle) return;
    const timer = setTimeout(dismiss, 3000);
    return () => clearTimeout(timer);
  }, [subtitle, dismiss]);

  if (state === "hidden") return null;

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center"
      style={{
        zIndex: 9999,
        background: "var(--bg-base)",
        opacity: state === "fading" ? 0 : 1,
        transition: "opacity 300ms ease-out",
        animation: "fadeIn 300ms ease-out",
      }}
    >
      <h1 style={{ fontSize: "30px", fontWeight: 600, letterSpacing: "-0.02em" }}>
        <span style={{ color: "var(--text-primary)" }}>tr</span>
        <span style={{ color: "var(--accent)" }}>ai</span>
        <span style={{ color: "var(--text-primary)" }}>n</span>
      </h1>
      {subtitle && (
        <p
          style={{
            color: "var(--text-muted)",
            fontSize: "14px",
            marginTop: "12px",
            animation: "fadeIn 300ms ease-out",
          }}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}
