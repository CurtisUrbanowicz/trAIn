import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import {
  getValidToken,
  getRecoveriesInRange,
  getSleepsInRange,
  getAthleteTimezone,
  mapRecoveryToReadiness,
  hasReadinessForDate,
  insertWhoopReadiness,
  type WhoopSleep,
} from "@/lib/whoop";
import { pushLog } from "@/lib/debugLog";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

// Vercel Hobby (Fluid compute) cap — a long backfill pages many requests
export const maxDuration = 300;

function secretMatches(provided: string, expected: string): boolean {
  // Hash both sides so timingSafeEqual gets equal-length buffers
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  const expected = process.env.INGEST_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }
  if (!secretMatches(url.searchParams.get("secret") ?? "", expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const daysRaw = parseInt(url.searchParams.get("days") ?? "90", 10);
  const days = Math.min(Math.max(Number.isNaN(daysRaw) ? 90 : daysRaw, 1), 365);

  try {
    const token = await getValidToken(ATHLETE_ID);
    if (!token) {
      pushLog("wearable_sync", { provider: "whoop", skipped: "no token", backfill_days: days });
      return NextResponse.json({ skipped: "no token" });
    }

    const end = new Date().toISOString();
    const start = new Date(Date.now() - days * 86_400_000).toISOString();

    const [recoveries, sleeps] = await Promise.all([
      getRecoveriesInRange(token, start, end),
      getSleepsInRange(token, start, end),
    ]);
    const sleepById = new Map<string, WhoopSleep>(sleeps.map((s) => [s.id, s]));
    const timezone = await getAthleteTimezone(ATHLETE_ID);

    let written = 0;
    let skippedExisting = 0;
    let skippedUnscored = 0;
    const seenDates = new Set<string>();

    for (const recovery of recoveries) {
      const values = mapRecoveryToReadiness(
        recovery,
        sleepById.get(recovery.sleep_id) ?? null,
        timezone
      );
      if (!values) {
        skippedUnscored++;
        continue;
      }
      // Recoveries come newest-first; first record per date wins
      if (seenDates.has(values.date)) continue;
      seenDates.add(values.date);

      // Strict no-overwrite: any existing row (manual or whoop) wins
      if (await hasReadinessForDate(ATHLETE_ID, values.date)) {
        skippedExisting++;
        continue;
      }
      if (await insertWhoopReadiness(ATHLETE_ID, values)) {
        written++;
      }
    }

    pushLog("wearable_sync", {
      provider: "whoop",
      backfill_days: days,
      written,
      skipped_existing: skippedExisting,
      skipped_unscored: skippedUnscored,
    });
    return NextResponse.json({
      written,
      skipped_existing: skippedExisting,
      skipped_unscored: skippedUnscored,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushLog("error", { message: `whoop backfill failed: ${message}` });
    console.error("[whoop] backfill failed:", message);
    return NextResponse.json({ error: "backfill failed" }, { status: 500 });
  }
}
