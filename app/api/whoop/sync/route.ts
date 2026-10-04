import { NextResponse } from "next/server";
import {
  getValidToken,
  getRecentRecoveries,
  getSleepById,
  getAthleteTimezone,
  mapRecoveryToReadiness,
  hasReadinessForDate,
  insertWhoopReadiness,
  todayInTimezone,
} from "@/lib/whoop";
import { pushLog } from "@/lib/debugLog";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

export async function POST() {
  try {
    const token = await getValidToken(ATHLETE_ID);
    if (!token) {
      pushLog("wearable_sync", { provider: "whoop", skipped: "no token" });
      return NextResponse.json({ skipped: "no token" });
    }

    const recoveries = await getRecentRecoveries(token);
    if (recoveries.length === 0) {
      pushLog("wearable_sync", { provider: "whoop", skipped: "no recovery data" });
      return NextResponse.json({ skipped: "no recovery data" });
    }

    // Newest by record creation time — never trust server ordering
    const recovery = [...recoveries].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
    )[0]!;

    const sleep = recovery.sleep_id
      ? await getSleepById(token, recovery.sleep_id)
      : null;
    const timezone = await getAthleteTimezone(ATHLETE_ID);
    const values = mapRecoveryToReadiness(recovery, sleep, timezone);
    if (!values) {
      pushLog("wearable_sync", { provider: "whoop", skipped: "unscored or calibrating" });
      return NextResponse.json({ skipped: "unscored" });
    }

    // Staleness guard: sync exists to fill *today's* readiness. If the
    // newest recovery's wake date is more than 2 days old, the account has
    // no fresh data — never write ancient rows. The logged wake date shows
    // what Whoop considers newest for the authorized account.
    const today = todayInTimezone(timezone);
    const ageDays =
      (Date.parse(today) - Date.parse(values.date)) / 86_400_000;
    if (ageDays > 2) {
      pushLog("wearable_sync", {
        provider: "whoop",
        skipped: "stale recovery",
        newest_wake_date: values.date,
        today,
      });
      return NextResponse.json({ skipped: "stale", newest_wake_date: values.date });
    }

    // Strict no-overwrite: any existing row for the date wins
    if (await hasReadinessForDate(ATHLETE_ID, values.date)) {
      pushLog("wearable_sync", {
        provider: "whoop",
        date: values.date,
        skipped: "existing readiness",
      });
      return NextResponse.json({ skipped: "exists", date: values.date });
    }

    const ok = await insertWhoopReadiness(ATHLETE_ID, values);
    if (!ok) {
      pushLog("error", { message: "whoop sync: readiness insert failed", date: values.date });
      return NextResponse.json({ error: "insert failed" }, { status: 500 });
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
    return NextResponse.json({ written: values.date });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushLog("error", { message: `whoop sync failed: ${message}` });
    console.error("[whoop] sync failed:", message);
    return NextResponse.json({ error: "sync failed" }, { status: 500 });
  }
}
