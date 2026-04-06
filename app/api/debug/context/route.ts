import { NextResponse } from "next/server";
import {
  buildContext,
  getWeekStartMondayUtc,
  type TabType,
} from "@/lib/context";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

const TAB_VALUES: TabType[] = [
  "coach",
  "today",
  "week",
  "session",
  "season",
];

function todayUtcYmd(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseTab(searchParams: URLSearchParams): TabType {
  const raw = searchParams.get("tab");
  if (raw && TAB_VALUES.includes(raw as TabType)) {
    return raw as TabType;
  }
  return "coach";
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tab = parseTab(searchParams);
    const localDate =
      searchParams.get("localDate")?.trim() || todayUtcYmd();

    const weekStart = getWeekStartMondayUtc(localDate);
    const { systemPrompt, contextBlock } = await buildContext(
      ATHLETE_ID,
      tab,
      localDate
    );

    return NextResponse.json({
      tab,
      localDate,
      weekStart,
      systemPromptLength: systemPrompt.length,
      contextBlockLength: contextBlock.length,
      systemPrompt,
      contextBlock,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
