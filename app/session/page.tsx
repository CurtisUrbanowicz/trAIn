"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import ChatView from "@/app/components/ChatView";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

interface Plan {
  session_type: string;
  exercises: { name: string }[] | null;
}

export default function SessionPage() {
  const [plan, setPlan] = useState<Plan | null>(null);

  useEffect(() => {
    const today = new Date();
    const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    supabase
      .from("plans")
      .select("session_type, exercises")
      .eq("athlete_id", ATHLETE_ID)
      .eq("date", localDate)
      .order("timestamp", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) {
          setPlan(data[0]);
        }
      });
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ChatView tab="session">
        {plan && (
          <div
            style={{
              background: "var(--bg-surface)",
              borderRadius: 12,
              border: "0.5px solid var(--border-default)",
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
              {plan.session_type}
            </p>
            {plan.exercises && plan.exercises.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {plan.exercises.map((ex, i) => (
                  <p
                    key={i}
                    style={{
                      fontSize: 13,
                      color: "var(--text-muted)",
                      margin: 0,
                      lineHeight: 1.5,
                    }}
                  >
                    {ex.name}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </ChatView>
    </div>
  );
}
