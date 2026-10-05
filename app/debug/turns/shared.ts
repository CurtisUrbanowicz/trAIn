import type { CSSProperties } from "react";

export const TAB_COLORS: Record<string, string> = {
  today: "#22c55e",
  week: "#5e6ad2",
  season: "#f59e0b",
  coach: "#a855f7",
};

export const pageStyle: CSSProperties = {
  background: "var(--bg-base)",
  color: "var(--text-primary)",
  minHeight: "100vh",
  padding: 16,
  fontFamily: "monospace",
  fontSize: 13,
};

export const preStyle: CSSProperties = {
  color: "var(--text-primary)",
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  lineHeight: 1.45,
};

// Rendered on the server (UTC on Vercel), so pin the athlete's zone.
export function formatTurnTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
