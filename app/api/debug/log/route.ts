import { NextResponse } from "next/server";
import { getLog, clearLog } from "@/lib/debugLog";

export async function GET() {
  const log = await getLog();
  return NextResponse.json(log);
}

export async function POST(request: Request) {
  const body = (await request.json()) as { action?: string };
  if (body.action === "clear") {
    await clearLog();
    return NextResponse.json({ cleared: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
