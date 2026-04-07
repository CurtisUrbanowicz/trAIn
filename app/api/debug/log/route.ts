import { NextResponse } from "next/server";
import { getLog, clearLog } from "@/lib/debugLog";

export async function GET() {
  return NextResponse.json(getLog());
}

export async function POST(request: Request) {
  const body = (await request.json()) as { action?: string };
  if (body.action === "clear") {
    clearLog();
    return NextResponse.json({ cleared: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
