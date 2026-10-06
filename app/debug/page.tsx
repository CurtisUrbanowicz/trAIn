"use client";

import { useEffect, useState, useCallback } from "react";

interface DebugEntry {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

const TYPE_COLORS: Record<string, string> = {
  tool_call: "#5e6ad2",
  tool_result: "#5e6ad2",
  context_loaded: "#8a8f98",
  summary_generated: "#22c55e",
  error: "#ef4444",
  timing: "#f59e0b",
  wearable_sync: "#14b8a6",
  morning_chain: "#a855f7",
  opener_claim: "#f472b6",
};

type MorningChainData = {
  step?: string;
  date?: string | null;
  outcome?: string;
  steps?: Record<string, string>;
};

function describeMorningChain(entry: DebugEntry): string {
  const d = entry.data as MorningChainData;
  const steps = d.steps
    ? " · " +
      Object.entries(d.steps)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    : "";
  return `${new Date(entry.timestamp).toLocaleString()} · ${d.date ?? "—"} · ${d.step ?? "?"}: ${d.outcome ?? "?"}${steps}`;
}

export default function DebugPage() {
  const [entries, setEntries] = useState<DebugEntry[]>([]);

  const fetchLog = useCallback(() => {
    fetch("/api/debug/log")
      .then((r) => r.json())
      .then((data: DebugEntry[]) => setEntries([...data].reverse()))
      .catch(() => {});
  }, []);

  const clearLog = () => {
    fetch("/api/debug/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" }),
    }).then(() => setEntries([]));
  };

  useEffect(() => {
    fetchLog();
    const interval = setInterval(fetchLog, 2000);
    return () => clearInterval(interval);
  }, [fetchLog]);

  return (
    <div
      style={{
        background: "var(--bg-base)",
        color: "var(--text-primary)",
        minHeight: "100vh",
        padding: 16,
        fontFamily: "monospace",
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <div>
          <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
            Debug Log ({entries.length})
          </h1>
          <a href="/debug/turns" style={{ fontSize: 11, color: "var(--accent)" }}>
            Turn records →
          </a>
          <div style={{ fontSize: 11, color: "#14b8a6", marginTop: 2 }}>
            Last Whoop sync:{" "}
            {(() => {
              // entries render oldest → newest, so the last match is latest
              const sync = entries
                .filter((e) => e.type === "wearable_sync")
                .pop();
              return sync
                ? new Date(sync.timestamp).toLocaleString()
                : "none in log";
            })()}
          </div>
          <div style={{ fontSize: 11, color: "#a855f7", marginTop: 2 }}>
            Last morning chain:{" "}
            {(() => {
              const chain = entries
                .filter((e) => e.type === "morning_chain")
                .pop();
              return chain ? describeMorningChain(chain) : "none in log";
            })()}
          </div>
        </div>
        <button
          onClick={clearLog}
          style={{
            background: "var(--bg-surface)",
            color: "var(--text-muted)",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            padding: "6px 12px",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Clear
        </button>
      </div>

      {entries.length === 0 && (
        <p style={{ color: "var(--text-muted)" }}>No log entries yet.</p>
      )}

      {entries.map((entry, i) => (
        <div
          key={`${entry.timestamp}-${i}`}
          style={{
            background: "var(--bg-surface)",
            borderRadius: 8,
            padding: "10px 12px",
            marginBottom: 8,
            borderLeft: `3px solid ${TYPE_COLORS[entry.type] ?? "var(--text-muted)"}`,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 4,
            }}
          >
            <span
              style={{
                color: TYPE_COLORS[entry.type] ?? "var(--text-muted)",
                fontWeight: 600,
              }}
            >
              {entry.type}
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
          </div>
          <pre
            style={{
              color: "var(--text-muted)",
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              lineHeight: 1.4,
            }}
          >
            {JSON.stringify(entry.data, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
