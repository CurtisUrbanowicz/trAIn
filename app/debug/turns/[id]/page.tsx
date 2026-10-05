import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getTurnRecord } from "@/lib/turnRecords";
import { formatTurnTime, pageStyle, preStyle, TAB_COLORS } from "../shared";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Section({
  title,
  meta,
  open = true,
  children,
}: {
  title: string;
  meta?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      style={{
        background: "var(--bg-surface)",
        borderRadius: 8,
        padding: "10px 12px",
        marginBottom: 10,
      }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        {title}
        {meta && (
          <span
            style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 8 }}
          >
            {meta}
          </span>
        )}
      </summary>
      <div style={{ marginTop: 10 }}>{children}</div>
    </details>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div style={{ color: "var(--text-muted)", fontSize: 11, margin: "8px 0 4px" }}>
      {children}
    </div>
  );
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

export default async function TurnPage({ params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) notFound();
  const turn = await getTurnRecord(params.id);
  if (!turn) notFound();

  const color = TAB_COLORS[turn.tab] ?? "var(--text-muted)";
  const timing = turn.timing;
  const usage = turn.usage;
  const toolCalls = turn.tool_calls ?? [];
  const rounds = timing?.rounds ?? [];

  return (
    <div style={pageStyle}>
      <div style={{ marginBottom: 16 }}>
        <Link href="/debug/turns" style={{ color: "var(--text-muted)", fontSize: 11 }}>
          ← All turns
        </Link>
        <h1 style={{ fontSize: 16, fontWeight: 600, margin: "4px 0 0" }}>
          <span style={{ color }}>{turn.tab}</span> ·{" "}
          {formatTurnTime(turn.created_at)}
        </h1>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          {turn.model} · local date {turn.date} · {timing?.tool_rounds ?? 0} tool
          rounds · {toolCalls.length} tool calls ·{" "}
          {timing ? `${(timing.total_ms / 1000).toFixed(1)}s total` : "no timing"}
        </div>
        {timing?.error && (
          <div style={{ fontSize: 12, color: "#ef4444", marginTop: 6 }}>
            Error: {timing.error}
          </div>
        )}
      </div>

      <Section title="User message">
        <pre style={preStyle}>
          {turn.user_message?.trim() ? turn.user_message : "(opener — no user message)"}
        </pre>
      </Section>

      <Section
        title="Context block"
        meta={`${(turn.context_block ?? "").length.toLocaleString()} chars`}
        open={false}
      >
        <pre style={{ ...preStyle, color: "var(--text-muted)" }}>
          {turn.context_block}
        </pre>
      </Section>

      <Section title="Tool calls" meta={`${toolCalls.length}`}>
        {toolCalls.length === 0 && (
          <div style={{ color: "var(--text-muted)" }}>No tools called.</div>
        )}
        {rounds
          .filter((r) => r.tools > 0)
          .map((r) => (
            <div key={r.round} style={{ marginBottom: 14 }}>
              <div style={{ color: "#5e6ad2", fontWeight: 600 }}>
                Round {r.round}
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                  {" "}
                  · api {r.api_ms}ms · tools {r.tools_ms}ms
                </span>
              </div>
              {r.text && (
                <>
                  <Label>Text alongside tool calls</Label>
                  <pre style={preStyle}>{r.text}</pre>
                </>
              )}
              {toolCalls
                .filter((c) => c.round === r.round)
                .map((c, i) => (
                  <details
                    key={`${c.round}-${c.index ?? i}`}
                    style={{
                      borderLeft: "2px solid var(--border-strong)",
                      paddingLeft: 10,
                      marginTop: 8,
                    }}
                  >
                    <summary style={{ cursor: "pointer" }}>
                      {c.name}
                      <span style={{ color: "var(--text-muted)" }}>
                        {" "}
                        → {c.result.length > 80 ? c.result.slice(0, 80) + "…" : c.result}
                      </span>
                    </summary>
                    <Label>Input</Label>
                    <pre style={preStyle}>{formatInput(c.input)}</pre>
                    <Label>Result</Label>
                    <pre style={preStyle}>{c.result}</pre>
                  </details>
                ))}
            </div>
          ))}
      </Section>

      <Section title="Final message">
        <pre style={preStyle}>
          {turn.final_message ?? "(no final message)"}
        </pre>
      </Section>

      <Section title="Timing and usage" open={false}>
        <Label>Timing</Label>
        <pre style={{ ...preStyle, color: "var(--text-muted)" }}>
          {JSON.stringify(timing, null, 2)}
        </pre>
        <Label>Usage</Label>
        <pre style={{ ...preStyle, color: "var(--text-muted)" }}>
          {JSON.stringify(usage, null, 2)}
        </pre>
      </Section>
    </div>
  );
}
