"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import ChatView from "@/app/components/ChatView";
import LoadingScreen from "@/app/components/LoadingScreen";
import { formatSessionType } from "@/lib/format";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

interface Plan {
  session_type: string;
  exercises: (string | { name: string })[] | null;
  notes: string | null;
}

function getLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function TodayPage() {
  const [plan, setPlan] = useState<Plan | null>(null);
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
          const exercises =
            typeof raw.exercises === "string"
              ? JSON.parse(raw.exercises)
              : Array.isArray(raw.exercises)
                ? raw.exercises
                : [];
          setPlan({ session_type: raw.session_type, exercises, notes: raw.notes });
        }
      });
  };

  useEffect(() => {
    fetchPlan();
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel('today-plan')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'plans', filter: `athlete_id=eq.${ATHLETE_ID}` },
        () => fetchPlan()
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  // Generate summaries for unsummarised dates, then enable the opener
  useEffect(() => {
    const localDate = getLocalDate();
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
        {plan && (
          <div
            style={{
              background: "var(--bg-surface)",
              borderRadius: 12,
              border: "1px solid var(--border-default)",
              padding: "12px 16px",
              marginBottom: 16,
            }}
          >
            <p
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-primary)",
                margin: 0,
              }}
            >
              {formatSessionType(plan.session_type)}
            </p>
            {plan.exercises && plan.exercises.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {plan.exercises.map((ex, i) => (
                  <p
                    key={i}
                    style={{
                      fontSize: 14,
                      color: "var(--text-primary)",
                      margin: 0,
                      lineHeight: 1.5,
                    }}
                  >
                    {typeof ex === "string" ? ex : ex.name}
                  </p>
                ))}
              </div>
            )}
            {plan.notes && (
              <p
                style={{
                  fontSize: 13,
                  color: "var(--text-muted)",
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                {plan.notes}
              </p>
            )}
          </div>
        )}
      </ChatView>
    </div>
  );
}
