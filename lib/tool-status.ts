/**
 * Code-generated status line shown to the athlete while a chat tool runs.
 * The model writes nothing alongside a tool call; this line is what the
 * athlete sees instead. Sent as an NDJSON {"t":"status"} frame by
 * /api/chat, one per tool_use block, and never persisted.
 */

const HISTORY_STATUS: Record<string, string> = {
  sets: "pulling up your lifting sessions…",
  runs: "pulling up your runs…",
  daily_summaries: "reading back through recent days…",
  readiness: "checking your readiness history…",
};

const TOOL_STATUS: Record<string, string> = {
  get_weekly_plan: "checking this week's plan…",
  get_mesocycles: "looking at your training blocks…",
  log_sets: "logging the session…",
  log_run: "logging the run…",
  log_readiness: "logging your readiness…",
  commit_today_plan: "saving today's plan…",
  commit_weekly_plan: "saving the week's plan…",
  create_mesocycle: "setting up the training block…",
  update_athlete_profile: "updating your profile…",
  update_log_entry: "correcting that entry…",
  delete_log_entry: "removing that entry…",
  days_between: "counting days…",
};

export function describeToolCall(
  name: string,
  input: Record<string, unknown>
): string {
  if (name === "get_history") {
    // Same discriminator reflect's summariseToolInput uses
    const table = typeof input.table === "string" ? input.table : "";
    return HISTORY_STATUS[table] ?? "pulling up your history…";
  }
  return TOOL_STATUS[name] ?? "working…";
}
