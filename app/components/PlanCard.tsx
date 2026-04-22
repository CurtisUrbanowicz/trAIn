import { formatSessionType } from "@/lib/format";

interface Plan {
  session_type: string;
  exercises: unknown;
  notes: string | null;
}

function normalizeExercises(raw: unknown): string[] {
  if (!raw) return [];
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((e) =>
      typeof e === "string"
        ? e
        : e && typeof e === "object" && "name" in e
          ? String((e as { name: unknown }).name ?? "")
          : ""
    )
    .filter(Boolean);
}

export default function PlanCard({ plan }: { plan: Plan | null }) {
  if (!plan) return null;
  const items = normalizeExercises(plan.exercises);

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "0.5px solid var(--border-strong)",
        borderLeft: "1px solid var(--accent)",
        borderRadius: 8,
        overflow: "hidden",
        boxShadow:
          "0 2px 8px rgba(0,0,0,0.25), 0 0 0 0.5px rgba(94,106,210,0.12)",
      }}
    >
      <div
        style={{
          padding: "8px 14px",
          background: "var(--bg-surface-2)",
          lineHeight: 1,
        }}
      >
        <span
          style={{
            display: "block",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
            marginBottom: 4,
            lineHeight: 1,
          }}
        >
          Today&apos;s plan
        </span>
        <h3
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 15,
            fontWeight: 500,
            letterSpacing: "-0.005em",
            color: "var(--text-primary)",
            lineHeight: 1,
            margin: 0,
          }}
        >
          {formatSessionType(plan.session_type)}
        </h3>
      </div>

      {items.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            padding: "10px 14px 12px",
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {items.map((text, i) => (
            <li
              key={i}
              style={{
                position: "relative",
                paddingLeft: 14,
                fontSize: 14,
                lineHeight: 1.45,
                color: "var(--text-primary)",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  top: "0.55em",
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: "var(--text-muted)",
                }}
              />
              {text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
