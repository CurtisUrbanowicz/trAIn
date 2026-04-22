"use client";

interface Readiness {
  recovery_score: number | null;
  hrv: number | null;
  rhr: number | null;
  sleep_hours: number | null;
}

const DASH = "—";

function OrbRing({
  score,
  size = 60,
  strokeW = 3,
  fontSize = 20,
}: {
  score: number | null;
  size?: number;
  strokeW?: number;
  fontSize?: number;
}) {
  const r = (size - strokeW) / 2;
  const c = 2 * Math.PI * r;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const color =
    score == null
      ? "var(--text-muted)"
      : `oklch(${0.5 + pct * 0.25} ${pct * 0.14} 150)`;
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border-default)"
        strokeWidth={strokeW}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={strokeW}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 600ms ease-out" }}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontFamily: "var(--font-serif)",
          fontSize,
          fontWeight: 500,
          fill: "var(--text-primary)",
          letterSpacing: "-0.01em",
        }}
      >
        {score ?? DASH}
      </text>
    </svg>
  );
}

const DOW_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_ABBR = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function DateLabel({ date }: { date: string }) {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(y!, m! - 1, d!).getDay();
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.04em",
        lineHeight: 1,
      }}
    >
      <span style={{ color: "var(--text-primary)" }}>{DOW_ABBR[dow]}</span>{" "}
      <span style={{ color: "var(--text-muted)" }}>
        {MONTH_ABBR[m! - 1]} {d}
      </span>
    </div>
  );
}

export default function ReadinessHero({
  readiness,
  date,
}: {
  readiness: Readiness | null;
  date: string;
}) {
  const score = readiness?.recovery_score ?? null;
  const hrv = readiness?.hrv ?? null;
  const rhr = readiness?.rhr ?? null;
  const sleep = readiness?.sleep_hours ?? null;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "14px 20px 10px",
        borderBottom: "0.5px solid var(--border-default)",
      }}
    >
      <DateLabel date={date} />
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <OrbRing score={score} />
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <Stat k="HRV" v={hrv} />
          <Stat k="RHR" v={rhr} />
          <Stat k="Sleep" v={sleep == null ? DASH : `${sleep}h`} />
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: number | string | null }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 14,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontWeight: 600,
        }}
      >
        {k}
      </span>
      <span
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 14,
          fontWeight: 500,
          color: "var(--text-primary)",
          letterSpacing: "-0.005em",
          lineHeight: 1,
        }}
      >
        {v ?? DASH}
      </span>
    </div>
  );
}
