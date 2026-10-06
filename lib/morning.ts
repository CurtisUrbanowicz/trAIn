import "server-only";
import { randomUUID } from "crypto";
import { supabase } from "./supabase";
import { pushLog, pushLogAsync } from "./debugLog";
import { syncReadiness } from "./whoop-sync";
import {
  summariseMissing,
  hasSummaryForDate,
  addUtcCalendarDays,
} from "./summarise";
import {
  runReflection,
  getExistingInsight,
} from "./reflect";
import type { InsightType } from "./reflection-context";
import { patternsDue } from "./patterns";

/**
 * The morning chain. Whoop scoring a recovery is the "they woke up" signal;
 * this runs the expensive pre-open work in the background so Today and Coach
 * open fast:
 *
 *   1. readiness for the wake date (reuses the sync logic; the wake date
 *      comes from Whoop's own timezone offset — nothing else is a clock)
 *   2. yesterday's daily summary if missing
 *   3. pulse and deep reflections for the wake date if missing, and the
 *      weekly patterns pass when due — all three in parallel
 *
 * Every step is idempotent by date, logged as a morning_chain debug entry,
 * and failure in one step never stops the next. Chat messages and today's
 * opener are never generated or touched here. The on-mount fallbacks on
 * Today and Coach remain the safety nets.
 */

export type MorningStep =
  | "trigger"
  | "readiness"
  | "claim"
  | "summarise"
  | "pulse"
  | "deep"
  | "patterns"
  | "done";

export type MorningOutcome =
  | "received"
  | "written"
  | "skipped-existing"
  | "skipped-stale"
  | "skipped-unscored"
  | "skipped-no-data"
  | "skipped-no-token"
  | "skipped-running"
  | "skipped-done"
  | "claimed"
  | "reclaimed"
  | "complete"
  | "aborted"
  | "error";

/** A run "running" longer than this is presumed dead and may be reclaimed. */
const RUNNING_STALE_MS = 6 * 60_000;

function logStep(
  step: MorningStep,
  date: string | null,
  outcome: MorningOutcome,
  extra: Record<string, unknown> = {}
) {
  pushLog("morning_chain", { step, date, outcome, ...extra });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Run claim ───────────────────────────────────────────────────
//
// Whoop may deliver several recovery.updated events for one recovery, and
// deliveries can overlap. The per-date claim row makes steps 2–3 run once
// per wake date; the unique indexes on readiness, daily_summaries and
// insights remain the DB-level backstop.

type ClaimOutcome = "claimed" | "reclaimed" | "running" | "done" | "error";

async function claimRun(
  athleteId: string,
  wakeDate: string,
  traceId: string | undefined
): Promise<ClaimOutcome> {
  const { error: insertError } = await supabase
    .from("morning_chain_runs")
    .insert({
      athlete_id: athleteId,
      wake_date: wakeDate,
      status: "running",
      trace_id: traceId ?? null,
    });
  if (!insertError) return "claimed";
  if (insertError.code !== "23505") {
    console.error("[morning] claim insert failed:", insertError.message);
    return "error";
  }

  const { data: row } = await supabase
    .from("morning_chain_runs")
    .select("status, started_at, claim_token")
    .eq("athlete_id", athleteId)
    .eq("wake_date", wakeDate)
    .maybeSingle();
  if (!row) return "error";

  if (row.status === "done") return "done";
  if (
    row.status === "running" &&
    Date.now() - Date.parse(row.started_at) < RUNNING_STALE_MS
  ) {
    return "running";
  }

  // Failed or stale run: reclaim. Matching on claim_token means only one of
  // two concurrent reclaimers wins.
  const { data: updated } = await supabase
    .from("morning_chain_runs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      steps: null,
      claim_token: randomUUID(),
      trace_id: traceId ?? null,
    })
    .eq("athlete_id", athleteId)
    .eq("wake_date", wakeDate)
    .eq("claim_token", row.claim_token)
    .select("athlete_id");
  return (updated ?? []).length > 0 ? "reclaimed" : "running";
}

async function finishRun(
  athleteId: string,
  wakeDate: string,
  status: "done" | "error",
  steps: Record<string, string>
): Promise<void> {
  const { error } = await supabase
    .from("morning_chain_runs")
    .update({ status, finished_at: new Date().toISOString(), steps })
    .eq("athlete_id", athleteId)
    .eq("wake_date", wakeDate);
  if (error) console.error("[morning] finish update failed:", error.message);
}

// ── The chain ───────────────────────────────────────────────────

/**
 * `sleepId` is the UUID carried by a Whoop v2 recovery.updated event.
 * Never throws.
 */
export async function runMorningChain(
  athleteId: string,
  sleepId: string,
  traceId?: string
): Promise<void> {
  const chainStart = Date.now();
  const steps: Record<string, string> = {};
  logStep("trigger", null, "received", { sleep_id: sleepId, trace_id: traceId });

  // Step 1 — readiness. Also the only source of the wake date.
  let wakeDate: string | null = null;
  const t1 = Date.now();
  try {
    const sync = await syncReadiness(athleteId, { sleepId });
    wakeDate = sync.date;
    steps.readiness = sync.outcome;
    logStep("readiness", wakeDate, sync.outcome, {
      ms: Date.now() - t1,
      message: sync.message,
    });

    if (sync.outcome === "skipped-stale") {
      // An old recovery re-fired. Summaries and insights are today-artefacts;
      // never generate them for the past.
      for (const step of ["summarise", "pulse", "deep", "patterns"] as const) {
        steps[step] = "skipped-stale";
        logStep(step, wakeDate, "skipped-stale");
      }
      await pushLogAsync("morning_chain", {
        step: "done",
        date: wakeDate,
        outcome: "aborted",
        reason: "stale",
        steps,
        total_ms: Date.now() - chainStart,
      });
      return;
    }
  } catch (err) {
    steps.readiness = "error";
    logStep("readiness", null, "error", {
      ms: Date.now() - t1,
      message: errorMessage(err),
    });
  }

  if (!wakeDate) {
    // No scored recovery resolved (no token, unscored, not found, or the
    // sync threw). Without a wake date there is nothing to chain on;
    // Whoop fires again when the recovery is scored.
    await pushLogAsync("morning_chain", {
      step: "done",
      date: null,
      outcome: "aborted",
      reason: steps.readiness,
      steps,
      total_ms: Date.now() - chainStart,
    });
    return;
  }
  const date: string = wakeDate;

  // Claim the date before the expensive steps.
  let claim: ClaimOutcome = "error";
  try {
    claim = await claimRun(athleteId, date, traceId);
  } catch (err) {
    console.error("[morning] claim threw:", errorMessage(err));
  }
  if (claim === "running" || claim === "done") {
    await pushLogAsync("morning_chain", {
      step: "claim",
      date,
      outcome: claim === "running" ? "skipped-running" : "skipped-done",
      steps,
    });
    return;
  }
  // On a claim error, continue anyway — the unique indexes still backstop.
  logStep("claim", date, claim === "error" ? "error" : claim);

  // Step 2 — yesterday's daily summary.
  const yesterday = addUtcCalendarDays(date, -1);
  const t2 = Date.now();
  try {
    if (await hasSummaryForDate(athleteId, yesterday)) {
      steps.summarise = "skipped-existing";
      logStep("summarise", yesterday, "skipped-existing", { ms: Date.now() - t2 });
    } else {
      const result = await summariseMissing(athleteId, date);
      const outcome: MorningOutcome =
        result.generated > 0
          ? "written"
          : result.errors > 0
            ? "error"
            : "skipped-no-data";
      steps.summarise = outcome;
      logStep("summarise", yesterday, outcome, {
        ms: Date.now() - t2,
        generated: result.generated,
        errors: result.errors,
      });
    }
  } catch (err) {
    steps.summarise = "error";
    logStep("summarise", yesterday, "error", {
      ms: Date.now() - t2,
      message: errorMessage(err),
    });
  }

  // Step 3 — pulse, deep and patterns, in parallel. Independent of each
  // other; all read the summaries step 2 just wrote. Patterns is weekly: due
  // when no document exists or seven or more summaries post-date the current
  // one, so pulse and deep usually read last week's document — fine for a
  // long-term layer, and sequencing it first would risk the 300s budget.
  const reflect = async (type: InsightType) => {
    const t3 = Date.now();
    try {
      if (await getExistingInsight(athleteId, date, type)) {
        steps[type] = "skipped-existing";
        logStep(type, date, "skipped-existing", { ms: Date.now() - t3 });
        return;
      }
      const result = await runReflection(athleteId, date, type);
      if ("error" in result) {
        steps[type] = "error";
        logStep(type, date, "error", {
          ms: Date.now() - t3,
          message: result.error,
          iterations: result.iterations,
        });
        return;
      }
      const outcome: MorningOutcome = result.cached ? "skipped-existing" : "written";
      steps[type] = outcome;
      logStep(type, date, outcome, {
        ms: Date.now() - t3,
        iterations: result.iterations,
        significance: result.insight?.significance,
      });
    } catch (err) {
      steps[type] = "error";
      logStep(type, date, "error", {
        ms: Date.now() - t3,
        message: errorMessage(err),
      });
    }
  };
  const patterns = async () => {
    const t3 = Date.now();
    try {
      const due = await patternsDue(athleteId, date);
      if (!due.due) {
        steps.patterns = "skipped-existing";
        logStep("patterns", date, "skipped-existing", {
          ms: Date.now() - t3,
          reason: due.reason,
        });
        return;
      }
      const result = await runReflection(athleteId, date, "patterns");
      if ("error" in result) {
        steps.patterns = "error";
        logStep("patterns", date, "error", {
          ms: Date.now() - t3,
          message: result.error,
          iterations: result.iterations,
        });
        return;
      }
      const outcome: MorningOutcome = result.cached ? "skipped-existing" : "written";
      steps.patterns = outcome;
      logStep("patterns", date, outcome, {
        ms: Date.now() - t3,
        iterations: result.iterations,
        through_date: result.patterns?.through_date ?? null,
        reason: due.reason,
      });
    } catch (err) {
      steps.patterns = "error";
      logStep("patterns", date, "error", {
        ms: Date.now() - t3,
        message: errorMessage(err),
      });
    }
  };
  await Promise.all([reflect("pulse"), reflect("deep"), patterns()]);

  const failed = Object.values(steps).includes("error");
  if (claim !== "error") {
    try {
      await finishRun(athleteId, date, failed ? "error" : "done", steps);
    } catch (err) {
      console.error("[morning] finish threw:", errorMessage(err));
    }
  }
  await pushLogAsync("morning_chain", {
    step: "done",
    date,
    outcome: failed ? "error" : "complete",
    steps,
    total_ms: Date.now() - chainStart,
  });
}
