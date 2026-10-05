import Link from "next/link";
import { listTurnRecords } from "@/lib/turnRecords";
import { formatTurnTime, pageStyle, TAB_COLORS } from "./shared";

export const dynamic = "force-dynamic";

function preview(message: string | null): string {
  const text = (message ?? "").trim();
  if (!text) return "(opener — no user message)";
  return text.length > 90 ? text.slice(0, 90) + "…" : text;
}

export default async function TurnsPage() {
  const turns = await listTurnRecords(100);

  return (
    <div style={pageStyle}>
      <div style={{ marginBottom: 16 }}>
        <Link href="/debug" style={{ color: "var(--text-muted)", fontSize: 11 }}>
          ← Debug log
        </Link>
        <h1 style={{ fontSize: 16, fontWeight: 600, margin: "4px 0 0" }}>
          Turns ({turns.length})
        </h1>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          Most recent 100 chat turns. Records older than 30 days are removed daily.
        </div>
      </div>

      {turns.length === 0 && (
        <p style={{ color: "var(--text-muted)" }}>No turns recorded yet.</p>
      )}

      {turns.map((t) => {
        const color = TAB_COLORS[t.tab] ?? "var(--text-muted)";
        return (
          <Link
            key={t.id}
            href={`/debug/turns/${t.id}`}
            style={{
              display: "block",
              background: "var(--bg-surface)",
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 8,
              borderLeft: `3px solid ${t.timing?.error ? "#ef4444" : color}`,
              color: "inherit",
              textDecoration: "none",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 4,
              }}
            >
              <span style={{ color, fontWeight: 600 }}>{t.tab}</span>
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                {formatTurnTime(t.created_at)}
              </span>
            </div>
            <div style={{ marginBottom: 4, wordBreak: "break-word" }}>
              {preview(t.user_message)}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
              {t.timing?.tool_rounds ?? 0} tool rounds ·{" "}
              {t.timing?.total_ms != null
                ? `${(t.timing.total_ms / 1000).toFixed(1)}s`
                : "—"}{" "}
              total
              {t.timing?.error ? " · error" : ""}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
