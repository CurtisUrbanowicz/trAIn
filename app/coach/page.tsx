"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import ChatView from "@/app/components/ChatView";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";
const THINKING_DELIMITER = "\x00THINKING\x00";
const FINAL_DELIMITER = "\x00FINAL\x00";

type ReflectionType = "pulse" | "deep";

type Insight = {
  id: string;
  content: string;
  significance: number;
};

type ReflectionCard = {
  status: "idle" | "loading" | "streaming" | "done" | "error" | "cached";
  thinking: string;
  insight: Insight | null;
  error: string | null;
};

const initialCard: ReflectionCard = {
  status: "idle",
  thinking: "",
  insight: null,
  error: null,
};

function getLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function CoachPage() {
  const [pulseCard, setPulseCard] = useState<ReflectionCard>(initialCard);
  const [deepCard, setDeepCard] = useState<ReflectionCard>(initialCard);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const localDate = getLocalDate();

    const setCard = (
      type: ReflectionType,
      updater: (prev: ReflectionCard) => ReflectionCard
    ) => {
      if (type === "pulse") setPulseCard(updater);
      else setDeepCard(updater);
    };

    const runReflection = async (type: ReflectionType) => {
      setCard(type, (p) => ({ ...p, status: "loading" }));
      try {
        const response = await fetch("/api/reflect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ athleteId: ATHLETE_ID, localDate, type }),
        });

        if (!response.ok) {
          const text = await response.text();
          setCard(type, (p) => ({ ...p, status: "error", error: text || `HTTP ${response.status}` }));
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          setCard(type, (p) => ({ ...p, status: "error", error: "No response body" }));
          return;
        }

        const decoder = new TextDecoder();
        let fullText = "";
        let cardStatus: ReflectionCard["status"] = "loading";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullText += decoder.decode(value, { stream: true });

          const thinkIdx = fullText.indexOf(THINKING_DELIMITER);
          const finalIdx = fullText.indexOf(FINAL_DELIMITER);

          if (finalIdx !== -1) {
            const before = fullText.slice(0, finalIdx);
            const thinking =
              thinkIdx !== -1
                ? before.slice(0, thinkIdx) + before.slice(thinkIdx + THINKING_DELIMITER.length)
                : before;
            const finalPayload = fullText.slice(finalIdx + FINAL_DELIMITER.length).trim();
            setCard(type, (p) => ({ ...p, thinking, status: "streaming" }));
            cardStatus = "streaming";

            // Try to parse final payload — may still be arriving
            try {
              const parsed = JSON.parse(finalPayload) as
                | { insight: Insight; iterations: number; cached: boolean }
                | { error: string };
              if ("error" in parsed) {
                setCard(type, (p) => ({
                  ...p,
                  status: "error",
                  error: parsed.error,
                }));
                cardStatus = "error";
              } else {
                setCard(type, (p) => ({
                  ...p,
                  status: "done",
                  insight: parsed.insight,
                  thinking,
                }));
                cardStatus = "done";
              }
            } catch {
              // Payload mid-stream, wait for more
            }
          } else if (thinkIdx !== -1) {
            const thinking =
              fullText.slice(0, thinkIdx) +
              fullText.slice(thinkIdx + THINKING_DELIMITER.length);
            setCard(type, (p) => ({ ...p, thinking, status: "streaming" }));
            cardStatus = "streaming";
          } else {
            // No delimiters seen yet — could be a cached JSON payload
            try {
              const parsed = JSON.parse(fullText) as {
                insight: Insight;
                cached?: boolean;
              };
              if (parsed.insight) {
                setCard(type, (p) => ({
                  ...p,
                  status: parsed.cached ? "cached" : "done",
                  insight: parsed.insight,
                }));
                cardStatus = parsed.cached ? "cached" : "done";
              }
            } catch {
              // not JSON yet, keep reading
            }
          }
        }

        if (cardStatus !== "done" && cardStatus !== "cached" && cardStatus !== "error") {
          setCard(type, (p) => ({
            ...p,
            status: "error",
            error: "Stream ended without final payload",
          }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setCard(type, (p) => ({ ...p, status: "error", error: msg }));
      }
    };

    void (async () => {
      const { data: existing } = await supabase
        .from("insights")
        .select("id, type, content, significance")
        .eq("athlete_id", ATHLETE_ID)
        .eq("date", localDate)
        .in("type", ["pulse", "deep"]);

      const byType = new Map<ReflectionType, Insight>();
      for (const row of (existing ?? []) as Array<{
        id: string;
        type: ReflectionType;
        content: string;
        significance: number;
      }>) {
        byType.set(row.type, {
          id: row.id,
          content: row.content,
          significance: row.significance,
        });
      }

      const pulseExisting = byType.get("pulse");
      const deepExisting = byType.get("deep");

      if (pulseExisting) {
        setPulseCard({
          status: "cached",
          thinking: "",
          insight: pulseExisting,
          error: null,
        });
      } else {
        void runReflection("pulse");
      }

      if (deepExisting) {
        setDeepCard({
          status: "cached",
          thinking: "",
          insight: deepExisting,
          error: null,
        });
      } else {
        void runReflection("deep");
      }
    })();
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ChatView tab="coach" autoOpen={false}>
        <div className="flex flex-col gap-3 pb-4 md:flex-row">
          <ReflectionCardView label="Pulse" card={pulseCard} />
          <ReflectionCardView label="Deep" card={deepCard} />
        </div>
      </ChatView>
    </div>
  );
}

function ReflectionCardView({
  label,
  card,
}: {
  label: string;
  card: ReflectionCard;
}) {
  return (
    <div
      className="flex-1 rounded-lg p-3"
      style={{
        border: "0.5px solid var(--border-default)",
        background: "var(--bg-surface)",
        minHeight: 80,
      }}
    >
      <div className="mb-2 flex items-start justify-between">
        <span
          style={{
            fontSize: 11,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
            fontFamily: "var(--font-inter)",
          }}
        >
          {label}
        </span>
        {card.insight && (
          <span
            style={{
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 4,
              border: "0.5px solid var(--border-default)",
              color: "var(--text-muted)",
              fontFamily: "var(--font-inter)",
            }}
          >
            {card.insight.significance}/10
          </span>
        )}
      </div>

      {card.insight ? (
        <p
          className="whitespace-pre-wrap break-words"
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 15,
            lineHeight: 1.45,
            color: "var(--text-primary)",
          }}
        >
          {card.insight.content}
        </p>
      ) : card.error ? (
        <p
          style={{
            fontSize: 13,
            color: "var(--text-muted)",
            fontFamily: "var(--font-inter)",
          }}
        >
          {card.error}
        </p>
      ) : card.thinking ? (
        <p
          className="whitespace-pre-wrap break-words italic"
          style={{
            fontSize: 13,
            lineHeight: 1.4,
            color: "var(--text-muted)",
            fontFamily: "var(--font-serif)",
          }}
        >
          {card.thinking}
        </p>
      ) : (
        <p
          style={{
            fontSize: 13,
            color: "var(--text-muted)",
            fontFamily: "var(--font-inter)",
          }}
        >
          {card.status === "loading" ? "Thinking…" : ""}
        </p>
      )}
    </div>
  );
}
