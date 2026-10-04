import "server-only";
import {
  getValidToken,
  getRecentRecoveries,
  getSleepById,
  getRecoveryForCycle,
  getAthleteTimezone,
  mapRecoveryToReadiness,
  hasReadinessForDate,
  insertWhoopReadiness,
  todayInTimezone,
  type WhoopRecovery,
  type WhoopSleep,
  type ReadinessValues,
} from "./whoop";
import { pushLog } from "./debugLog";

export type SyncOutcome =
  | "written"
  | "skipped-existing"
  | "skipped-stale"
  | "skipped-unscored"
  | "skipped-no-data"
  | "skipped-no-token"
  | "error";

export type SyncResult = {
  outcome: SyncOutcome;
  /**
   * Wake date derived from Whoop's own timezone offset on the sleep.
   * Null when no scored recovery could be resolved.
   */
  date: string | null;
  values?: ReadinessValues;
  message?: string;
};

/** Wake dates older than this (days) are treated as stale and never written. */
export const STALE_AFTER_DAYS = 2;

type Resolved = { recovery: WhoopRecovery; sleep: WhoopSleep | null };

/**
 * Picks the recovery to sync. With a sleep id (webhook) the lookup is exact:
 * sleep → cycle_id → that cycle's recovery. Without one (on-mount sync) the
 * newest recovery by created_at wins.
 */
async function resolveRecovery(
  token: string,
  sleepId?: string
): Promise<Resolved | null> {
  if (sleepId) {
    const sleep = await getSleepById(token, sleepId);
    if (sleep?.cycle_id != null) {
      const recovery = await getRecoveryForCycle(token, sleep.cycle_id);
      if (recovery) return { recovery, sleep };
    }
    // Exact lookup failed — fall back to the recent collection, but only
    // accept the recovery for *this* sleep. Never substitute another one.
    const recent = await getRecentRecoveries(token);
    const match = recent.find((r) => r.sleep_id === sleepId);
    if (!match) return null;
    return { recovery: match, sleep: sleep ?? (await getSleepById(token, sleepId)) };
  }

  const recoveries = await getRecentRecoveries(token);
  if (recoveries.length === 0) return null;

  // Newest by record creation time — never trust server ordering
  const recovery = [...recoveries].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
  )[0]!;
  const sleep = recovery.sleep_id
    ? await getSleepById(token, recovery.sleep_id)
    : null;
  return { recovery, sleep };
}

/**
 * Syncs one Whoop recovery into `readiness`. Strict no-overwrite: any
 * existing row for the date wins, and the partial unique index
 * readiness_whoop_one_per_date makes concurrent runs safe. Shared by
 * POST /api/whoop/sync (newest recovery) and the morning chain (the
 * recovery named by a webhook's sleep id).
 */
export async function syncReadiness(
  athleteId: string,
  opts: { sleepId?: string } = {}
): Promise<SyncResult> {
  const token = await getValidToken(athleteId);
  if (!token) {
    pushLog("wearable_sync", { provider: "whoop", skipped: "no token" });
    return { outcome: "skipped-no-token", date: null };
  }

  const resolved = await resolveRecovery(token, opts.sleepId);
  if (!resolved) {
    pushLog("wearable_sync", {
      provider: "whoop",
      skipped: "no recovery data",
      sleep_id: opts.sleepId,
    });
    return { outcome: "skipped-no-data", date: null };
  }

  const timezone = await getAthleteTimezone(athleteId);
  const values = mapRecoveryToReadiness(resolved.recovery, resolved.sleep, timezone);
  if (!values) {
    pushLog("wearable_sync", { provider: "whoop", skipped: "unscored or calibrating" });
    return { outcome: "skipped-unscored", date: null };
  }

  // Staleness guard: sync exists to fill *today's* readiness. If the
  // recovery's wake date is more than 2 days old, the account has no fresh
  // data (or an old recovery was re-fired) — never write ancient rows.
  const today = todayInTimezone(timezone);
  const ageDays = (Date.parse(today) - Date.parse(values.date)) / 86_400_000;
  if (ageDays > STALE_AFTER_DAYS) {
    pushLog("wearable_sync", {
      provider: "whoop",
      skipped: "stale recovery",
      newest_wake_date: values.date,
      today,
    });
    return { outcome: "skipped-stale", date: values.date };
  }

  // Strict no-overwrite: any existing row for the date wins
  if (await hasReadinessForDate(athleteId, values.date)) {
    pushLog("wearable_sync", {
      provider: "whoop",
      date: values.date,
      skipped: "existing readiness",
    });
    return { outcome: "skipped-existing", date: values.date };
  }

  const outcome = await insertWhoopReadiness(athleteId, values);
  if (outcome === "error") {
    pushLog("error", { message: "whoop sync: readiness insert failed", date: values.date });
    return { outcome: "error", date: values.date, message: "readiness insert failed" };
  }
  if (outcome === "duplicate") {
    // A concurrent sync won the race — same data, nothing to do
    pushLog("wearable_sync", {
      provider: "whoop",
      date: values.date,
      skipped: "existing readiness",
    });
    return { outcome: "skipped-existing", date: values.date };
  }

  pushLog("wearable_sync", {
    provider: "whoop",
    date: values.date,
    fields: {
      recovery_score: values.recovery_score,
      hrv: values.hrv,
      rhr: values.rhr,
      sleep_hours: values.sleep_hours,
    },
  });
  return { outcome: "written", date: values.date, values };
}
