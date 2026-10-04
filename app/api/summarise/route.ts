import { NextResponse } from "next/server";
import { summariseMissing } from "@/lib/summarise";

// Vercel Hobby (Fluid compute) cap
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { athleteId, localDate } = (await request.json()) as {
      athleteId: string;
      localDate: string;
    };

    if (!athleteId || !localDate) {
      return NextResponse.json(
        { error: "athleteId and localDate are required" },
        { status: 400 }
      );
    }

    const { generated } = await summariseMissing(athleteId, localDate);
    return NextResponse.json({ generated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[summarise] route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
