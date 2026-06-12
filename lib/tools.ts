import type Anthropic from "@anthropic-ai/sdk";
import type { TabType } from "@/lib/context";

const daySchema = {
  type: "object" as const,
  properties: {
    session_type: {
      type: "string" as const,
      description: "Type of session (e.g. upper, lower, easy run, rest)",
    },
    notes: {
      type: "string" as const,
      description: "Session details and notes",
    },
  },
  required: ["session_type"],
};

export const tools: Anthropic.Tool[] = [
  // ── Retrieval tools (3) ──────────────────────────────────────────
  {
    name: "get_history",
    description:
      "Retrieve training history. For sets, limit means number of sessions (distinct dates) — all sets from each session are returned. For runs, summaries, and readiness, limit means number of rows. Results ordered newest first. Match exercise and run_type names exactly as they appear in the context index vocabulary. Set limit based on what you need — don't pull 20 every time. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          enum: ["sets", "runs", "daily_summaries", "readiness"],
          description: "Which table to query",
        },
        date_from: {
          type: "string",
          description: "Start date filter (inclusive)",
        },
        date_to: {
          type: "string",
          description: "End date filter (inclusive)",
        },
        exercise: {
          type: "string",
          description: "Filter by exercise name (only for sets table)",
        },
        run_type: {
          type: "string",
          description: "Filter by run type (only for runs table)",
        },
        limit: {
          type: "integer",
          description: "Max results to return (default 20)",
        },
      },
      required: ["table"],
    },
  },
  {
    name: "get_weekly_plan",
    description:
      "Get the committed weekly plan for a given week. Requires a specific Monday date as week_start — reference dates are provided in the context block. Always confirm the Monday date with the athlete before retrieving. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        week_start: {
          type: "string",
          description: "Monday date for the target week (YYYY-MM-DD)",
        },
      },
      required: ["week_start"],
    },
  },
  {
    name: "get_mesocycles",
    description:
      "Get all mesocycles for the athlete, ordered newest first. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ── Write tools (10) ────────────────────────────────────────────
  {
    name: "log_sets",
    description:
      "Log completed sets only — never log planned or discussed training. Match exercise names to the vocabulary in the context index. If a name doesn't match existing vocabulary, it will be treated as a new exercise — ensure it's a clear canonical name. Confirm the date with the athlete if logging for any date other than today. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        sets: {
          type: "array",
          description: "Array of completed sets",
          items: {
            type: "object",
            properties: {
              exercise: {
                type: "string",
                description: "Exercise name",
              },
              weight_kg: {
                type: "number",
                description: "Weight in kilograms",
              },
              reps: {
                type: "integer",
                description: "Number of reps completed",
              },
              rir: {
                type: "integer",
                description: "Reps in reserve",
              },
              notes: {
                type: "string",
                description: "Notes on this set",
              },
            },
            required: ["exercise", "weight_kg", "reps"],
          },
        },
        date: {
          type: "string",
          description: "Date the sets were performed (defaults to today)",
        },
      },
      required: ["sets"],
    },
  },
  {
    name: "log_run",
    description:
      "Log a completed run only — never log planned or discussed runs. Match run_type to existing vocabulary in the context index. Before calling, check for existing runs on the same date via get_history. If one exists, confirm with the athlete before logging a second. Confirm the date with the athlete if logging for any date other than today. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        distance_km: {
          type: "number",
          description: "Distance in kilometres",
        },
        duration_min: {
          type: "number",
          description: "Duration in minutes",
        },
        avg_pace: {
          type: "string",
          description: 'Average pace (e.g. "6:03")',
        },
        avg_hr: {
          type: "number",
          description: "Average heart rate",
        },
        run_type: {
          type: "string",
          description: "Type of run",
        },
        notes: {
          type: "string",
          description: "Notes on the run",
        },
        date: {
          type: "string",
          description: "Date the run was completed (defaults to today)",
        },
      },
      required: ["distance_km", "run_type"],
    },
  },
  {
    name: "commit_weekly_plan",
    description:
      "Commit or update the weekly plan. Requires a specific Monday date as week_start — reference dates are provided in the context block. State the Monday date when committing — e.g. 'Locked in for the week of April 6.' The athlete's approval of the plan is sufficient confirmation; don't ask to confirm the date separately. Newest row per week wins — previous versions preserved as history. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        week_start: {
          type: "string",
          description: "Monday date for the target week (YYYY-MM-DD)",
        },
        days: {
          type: "object",
          description: "Plan for each day of the week",
          properties: {
            monday: daySchema,
            tuesday: daySchema,
            wednesday: daySchema,
            thursday: daySchema,
            friday: daySchema,
            saturday: daySchema,
            sunday: daySchema,
          },
          required: [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
          ],
        },
      },
      required: ["week_start", "days"],
    },
  },
  {
    name: "commit_today_plan",
    description:
      "Commit what the athlete has agreed to do today. This only writes for today's date. If the athlete changes their mind later, calling again creates a new version — newest wins. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        session_type: {
          type: "string",
          description: "Type of session planned",
        },
        notes: {
          type: "string",
          description:
            "Optional brief context for the session. Omit if the exercises list speaks for itself.",
        },
        exercises: {
          type: "array",
          description:
            "The session plan as a list of short factual lines, one item per line, under ~8 words each. Use this for all sessions regardless of type.",
          items: { type: "string" },
        },
      },
      required: ["session_type"],
    },
  },
  {
    name: "log_readiness",
    description:
      "Log readiness data parsed from conversation. Only log values the athlete actually mentioned — don't infer or fill in missing fields. When logging for any date other than today, confirm the date with the athlete first. No notes field. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        hrv: { type: "number", description: "Heart rate variability" },
        rhr: { type: "number", description: "Resting heart rate" },
        recovery_score: {
          type: "number",
          description:
            "Composite readiness score (0-100) provided by the athlete's wearable (Oura, Whoop, Garmin). User-reported, not computed. Do not infer or estimate if absent.",
        },
        sleep_hours: { type: "number", description: "Hours of sleep" },
        date: {
          type: "string",
          description: "Date for readiness data (defaults to today)",
        },
      },
      required: [],
    },
  },
  {
    name: "update_athlete_profile",
    description:
      "Write a new version of the athlete profile. Only call after the observe-surface-confirm loop — the athlete must have seen and confirmed the update. The profile loads on every request — only include information that actively changes coaching decisions right now. This means: current goals, active injury constraints, recovery baselines, persistent training tendencies, and key current patterns. Dated observations, resolved injuries, and one-off incidents belong in daily summaries, not the profile — they can be retrieved via get_history when relevant. When updating, prune observations that are outdated, resolved, or superseded. Consolidate rather than append. Aim for under 200 words. Previous versions preserved as history. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Full updated athlete profile in natural language",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "update_user_preferences",
    description:
      "Write a new version of user preferences. Only call after the observe-surface-confirm loop. Capture how this athlete prefers to be coached: communication style, depth, tone, coaching approach, and planning preferences. When updating, consolidate related preferences — if a new preference refines or replaces an existing one, keep only the stronger version. Aim for under 150 words. Previous versions preserved as history. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Full updated user preferences in natural language",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "delete_log_entry",
    description:
      "Delete a logged entry. Before calling, confirm with the athlete what is being deleted and why. Always call get_history first to find the correct row ID. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          enum: ["sets", "runs"],
          description: "Which table the entry is in",
        },
        id: {
          type: "string",
          description: "UUID of the entry to delete",
        },
      },
      required: ["table", "id"],
    },
  },
  {
    name: "update_log_entry",
    description:
      "Update fields on a logged entry. Before calling, confirm with the athlete what is being changed and why. Call get_history first to find the row ID. Only include fields that are actually changing. Invalid field names will be rejected. Fields are validated against the actual table schema. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          enum: ["sets", "runs"],
          description: "Which table the entry is in",
        },
        id: {
          type: "string",
          description: "UUID of the entry to update",
        },
        updates: {
          type: "object",
          description:
            "Fields to update (key-value pairs, only changed fields)",
        },
      },
      required: ["table", "id", "updates"],
    },
  },
  {
    name: "create_mesocycle",
    description:
      "Create a new mesocycle. Only call when you have name, goal, structure, and any relevant guardrails. Propose the name yourself as a synthesis of the conversation — evocative, not generic. Never put session-level prescriptions (specific paces, distances, rep schemes, weekly km targets) in any field — those emerge in weekly planning, not here. All dates use YYYY-MM-DD format.",
    input_schema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Block start date",
        },
        end_date: {
          type: "string",
          description: "Block end date",
        },
        name: {
          type: "string",
          description:
            "Short evocative label for this block. Required. Strict max 4 words, max 30 characters. Should feel specific to this block's intent. Propose it yourself after hearing the athlete's goals.",
        },
        goal: {
          type: "string",
          description:
            "What this block is trying to achieve. Required. Aspiration, key race targets with dates, non-negotiable intent. The what and why. Under 60 words.",
        },
        structure: {
          type: "string",
          description:
            "The shape of the block. Required. Training frequency, split, block duration, arc of intensity (build/deload pattern). The how it's organised. Do not include specific paces, distances, or session prescriptions — those belong in weekly planning. Under 60 words.",
        },
        notes: {
          type: "string",
          description:
            "Guardrails only. Optional. Injuries, life/travel constraints, coaching emphasis, things to protect. Not session plans, not week-by-week prescriptions. Under 60 words.",
        },
      },
      required: ["start_date", "end_date", "name", "goal", "structure"],
    },
  },
  {
    name: "log_insight",
    description:
      "Log a reflection insight — one per reflection pass. Call exactly once at the end of the pass with the insight that cleared the bar. The tool call is the output of the pass.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["pulse", "deep"],
          description: "Type of reflection pass.",
        },
        content: {
          type: "string",
          description:
            "The insight in plain first-person coach prose. No markdown. Pulse: under 60 words. Deep: under 100 words.",
        },
        significance: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Significance score 1-10 per the scale in the pulse/deep brain.",
        },
      },
      required: ["type", "content", "significance"],
    },
  },
  {
    name: "days_between",
    description:
      "Returns the number of days between two dates. Use this to verify any time gap before stating it.",
    input_schema: {
      type: "object",
      properties: {
        date_from: {
          type: "string",
          description: "Start date (YYYY-MM-DD)",
        },
        date_to: {
          type: "string",
          description: "End date (YYYY-MM-DD)",
        },
      },
      required: ["date_from", "date_to"],
    },
  },
];

// Write tools whose successful execution should be recorded in the
// actions table. Kept separate from the tool objects because the
// Anthropic Tool type rejects extra fields. log_insight is a reflection
// output, not a state-mutating action — excluded by design.
export const MUTATING_TOOLS = new Set<string>([
  "log_sets",
  "log_run",
  "log_readiness",
  "commit_today_plan",
  "commit_weekly_plan",
  "create_mesocycle",
  "update_athlete_profile",
  "update_user_preferences",
  "delete_log_entry",
  "update_log_entry",
]);

const HOT_TOOLS: Record<TabType, Set<string>> = {
  today: new Set(["get_history", "log_sets", "log_run", "commit_today_plan", "log_readiness", "days_between"]),
  week: new Set(["get_history", "commit_weekly_plan", "get_weekly_plan", "days_between"]),
  season: new Set(["get_history", "get_mesocycles", "create_mesocycle", "days_between"]),
  coach: new Set(["get_history"]),
};

// log_insight is reflection-only (see app/api/reflect/route.ts). Excluded
// from chat so the chat brain can't discover it via tool_search and call
// it outside a reflection pass.
const CHAT_EXCLUDED_TOOLS = new Set(["log_insight"]);

export function getToolsForTab(tab: TabType): Anthropic.ToolUnion[] {
  const hot = HOT_TOOLS[tab];
  const searchTool: Anthropic.ToolSearchToolRegex20251119 = {
    type: "tool_search_tool_regex_20251119",
    name: "tool_search_tool_regex",
  };
  const chatTools = tools.filter((t) => !CHAT_EXCLUDED_TOOLS.has(t.name));
  const regular: Anthropic.Tool[] = chatTools.map((t) =>
    hot.has(t.name) ? t : { ...t, defer_loading: true }
  );
  let lastHotIdx = -1;
  for (let i = regular.length - 1; i >= 0; i--) {
    if (!regular[i]!.defer_loading) {
      lastHotIdx = i;
      break;
    }
  }
  if (lastHotIdx !== -1) {
    regular[lastHotIdx] = {
      ...regular[lastHotIdx]!,
      cache_control: { type: "ephemeral", ttl: "1h" },
    };
  }
  return [searchTool, ...regular];
}