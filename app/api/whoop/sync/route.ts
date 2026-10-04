import { NextResponse } from "next/server";
import { syncReadiness } from "@/lib/whoop-sync";
import { pushLog } from "@/lib/debugLog";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

export async function POST() {
  try {
    const result = await syncReadiness(ATHLETE_ID);
    switch (result.outcome) {
      case "written":
        return NextResponse.json({ written: result.date });
      case "skipped-existing":
        return NextResponse.json({ skipped: "exists", date: result.date });
      case "skipped-stale":
        return NextResponse.json({ skipped: "stale", newest_wake_date: result.date });
      case "skipped-unscored":
        return NextResponse.json({ skipped: "unscored" });
      case "skipped-no-data":
        return NextResponse.json({ skipped: "no recovery data" });
      case "skipped-no-token":
        return NextResponse.json({ skipped: "no token" });
      case "error":
        return NextResponse.json({ error: "insert failed" }, { status: 500 });
      default:
        return NextResponse.json({ skipped: result.outcome });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushLog("error", { message: `whoop sync failed: ${message}` });
    console.error("[whoop] sync failed:", message);
    return NextResponse.json({ error: "sync failed" }, { status: 500 });
  }
}
