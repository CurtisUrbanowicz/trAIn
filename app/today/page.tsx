"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getLocalDate } from "@/lib/dates";
import { useRealtimeInsert } from "@/lib/useRealtimeInsert";
import ChatView from "@/app/components/ChatView";
import LoadingScreen from "@/app/components/LoadingScreen";
import PlanCard from "@/app/components/PlanCard";
import ReadinessHero from "@/app/components/ReadinessHero";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

interface Plan {
  session_type: string;
  exercises: unknown;
  notes: string | null;
}

interface Readiness {
  recovery_score: number | null;
  hrv: number | null;
  rhr: number | null;
  sleep_hours: number | null;
}

export default function TodayPage() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [ready, setReady] = useState(false);
  const [summariesReady, setSummariesReady] = useState(false);

  // Fetch today's plan
  const fetchPlan = () => {
    const localDate = getLocalDate();
    supabase
      .from("plans")
      .select("session_type, exercises, notes")
      .eq("athlete_id", ATHLETE_ID)
      .eq("date", localDate)
      .order("timestamp", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) {
          const raw = data[0];
          setPlan({
            session_type: raw.session_type,
            exercises: raw.exercises,
            notes: raw.notes,
          });
        }
      });
  };

  // Fetch today's readiness
  const fetchReadiness = () => {
    const localDate = getLocalDate();
    supabase
      .from("readiness")
      .select("recovery_score, hrv, rhr, sleep_hours")
      .eq("athlete_id", ATHLETE_ID)
      .eq("date", localDate)
      .order("timestamp", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) {
          const r = data[0];
          setReadiness({
            recovery_score: r.recovery_score,
            hrv: r.hrv,
            rhr: r.rhr,
            sleep_hours: r.sleep_hours,
          });
        } else {
          setReadiness(null);
        }
      });
  };

  useEffect(() => {
    fetchPlan();
    fetchReadiness();
  }, []);

  useRealtimeInsert("today-plan", "plans", fetchPlan, `athlete_id=eq.${ATHLETE_ID}`);
  useRealtimeInsert("today-readiness", "readiness", fetchReadiness, `athlete_id=eq.${ATHLETE_ID}`);

  // Generate summaries for unsummarised dates, then enable the opener
  useEffect(() => {
    const localDate = getLocalDate();

    // Fire-and-forget Whoop sync — never gates the opener. The readiness
    // realtime subscription above picks up the insert when it lands.
    fetch("/api/whoop/sync", { method: "POST" }).catch(() => {});

    fetch("/api/summarise", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ athleteId: ATHLETE_ID, localDate }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.generated > 0) {
          console.log(`[summarise] generated ${data.generated} summaries`);
        }
      })
      .catch((err) => {
        console.error("[summarise] failed:", err);
      })
      .finally(() => {
        setSummariesReady(true);
      });
  }, []);

  // Listen for opener-started event from useChat
  useEffect(() => {
    const handler = () => setReady(true);
    window.addEventListener("opener-started", handler);
    return () => window.removeEventListener("opener-started", handler);
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <LoadingScreen ready={ready} />
      <ChatView tab="today" enabled={summariesReady}>
        <ReadinessHero readiness={readiness} date={getLocalDate()} />
        <PlanCard plan={plan} />
      </ChatView>
    </div>
  );
}
