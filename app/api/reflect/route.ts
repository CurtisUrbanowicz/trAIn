import { NextResponse } from "next/server";
import {
  getExistingInsight,
  runReflection,
  type ReflectionType,
} from "@/lib/reflect";
import { pushLog } from "@/lib/debugLog";

// Vercel Hobby (Fluid compute) cap
export const maxDuration = 300;

const THINKING_DELIMITER = "\x00THINKING\x00";
const FINAL_DELIMITER = "\x00FINAL\x00";

export async function POST(request: Request) {
  let athleteId: string;
  let localDate: string;
  let type: ReflectionType;

  try {
    const body = (await request.json()) as {
      athleteId?: unknown;
      localDate?: unknown;
      type?: unknown;
    };

    if (typeof body.athleteId !== "string" || body.athleteId.trim() === "") {
      return NextResponse.json(
        { error: "athleteId must be a non-empty string" },
        { status: 400 }
      );
    }
    if (typeof body.localDate !== "string" || body.localDate.trim() === "") {
      return NextResponse.json(
        { error: "localDate must be a non-empty string" },
        { status: 400 }
      );
    }
    if (
      body.type !== "pulse" &&
      body.type !== "deep" &&
      body.type !== "patterns"
    ) {
      return NextResponse.json(
        { error: 'type must be "pulse", "deep" or "patterns"' },
        { status: 400 }
      );
    }

    athleteId = body.athleteId;
    localDate = body.localDate;
    type = body.type;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    // Idempotency: an insight already exists for this date/type. The
    // patterns pass checks its own currency inside runReflection.
    if (type !== "patterns") {
      const existing = await getExistingInsight(athleteId, localDate, type);
      if (existing) {
        return NextResponse.json({ insight: existing, cached: true });
      }
    }

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        const writeFinal = (payload: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(FINAL_DELIMITER));
          controller.enqueue(encoder.encode(JSON.stringify(payload)));
        };

        try {
          controller.enqueue(encoder.encode(THINKING_DELIMITER));

          const result = await runReflection(athleteId, localDate, type, (text) =>
            controller.enqueue(encoder.encode(text))
          );

          writeFinal(result);
          controller.close();
        } catch (streamErr) {
          const errMsg =
            streamErr instanceof Error ? streamErr.message : String(streamErr);
          pushLog("error", { message: errMsg, type });
          console.error("[reflect] streaming failed:", streamErr);
          try {
            writeFinal({ error: errMsg });
          } catch {
            // controller may already be closed
          }
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushLog("error", { message, type });
    console.error("[reflect] route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
