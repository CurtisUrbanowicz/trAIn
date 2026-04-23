import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import {
  buildPulseContext,
  buildDeepContext,
} from "@/lib/reflection-context";
import { supabase } from "@/lib/supabase";
import { tools } from "@/lib/tools";
import { executeTool, type ToolContext } from "@/lib/tool-executor";
import { pushLog } from "@/lib/debugLog";

const THINKING_DELIMITER = "\x00THINKING\x00";
const FINAL_DELIMITER = "\x00FINAL\x00";
const MODEL = "claude-opus-4-7";

type ReflectionType = "pulse" | "deep";

const MAX_ITERATIONS: Record<ReflectionType, number> = {
  pulse: 8,
  deep: 15,
};

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "…" : value;
}

function summariseToolInput(name: string, input: Record<string, unknown>): string {
  if (name === "get_history") {
    const parts: string[] = [];
    if (input.table) parts.push(String(input.table));
    if (input.date_from || input.date_to) {
      parts.push(`${input.date_from ?? ""}..${input.date_to ?? ""}`);
    }
    if (input.exercise) parts.push(`exercise=${input.exercise}`);
    if (input.run_type) parts.push(`run_type=${input.run_type}`);
    if (input.limit != null) parts.push(`limit=${input.limit}`);
    return parts.join(", ");
  }
  if (name === "log_insight") {
    const sig = input.significance;
    return `significance=${sig ?? "?"}`;
  }
  return "";
}

async function safeExecuteTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  try {
    return await executeTool(name, input, context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reflect] tool ${name} failed:`, msg);
    return `Tool execution failed: ${msg}`;
  }
}

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
    if (body.type !== "pulse" && body.type !== "deep") {
      return NextResponse.json(
        { error: 'type must be "pulse" or "deep"' },
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
    // Idempotency: an insight already exists for this date/type
    const { data: existing } = await supabase
      .from("insights")
      .select("id, type, content, significance, created_at")
      .eq("athlete_id", athleteId)
      .eq("date", localDate)
      .eq("type", type)
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ insight: existing, cached: true });
    }

    const { systemPrompt, contextBlock } =
      type === "pulse"
        ? await buildPulseContext(athleteId, localDate)
        : await buildDeepContext(athleteId, localDate);

    pushLog("context_loaded", {
      tab: `reflect-${type}`,
      type,
      contextBlockLength: contextBlock.length,
      systemPromptLength: systemPrompt.length,
    });
    pushLog("model_used", { model: MODEL, type });

    const reflectionTools = tools
      .filter((t) => t.name === "get_history" || t.name === "log_insight")
      .map((t, i, arr) =>
        i === arr.length - 1
          ? { ...t, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }
          : t
      ) as Anthropic.Tool[];

    const anthropic = new Anthropic();
    const toolContext: ToolContext = { athleteId, localDate };
    const apiMessages: Anthropic.MessageParam[] = [
      { role: "user", content: contextBlock },
    ];

    const callWithRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes("overloaded")) throw err;
        await new Promise((r) => setTimeout(r, 2000));
        return await fn();
      }
    };

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        const writeFinal = (payload: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(FINAL_DELIMITER));
          controller.enqueue(encoder.encode(JSON.stringify(payload)));
        };

        try {
          controller.enqueue(encoder.encode(THINKING_DELIMITER));

          let insightLogged = false;
          let lastUsage: Anthropic.Messages.Usage | null = null;
          const maxIters = MAX_ITERATIONS[type];
          let iterations = 0;

          for (let i = 0; i < maxIters; i++) {
            iterations = i + 1;

            const finalMsg = await callWithRetry(async () => {
              const stream = anthropic.messages.stream({
                model: MODEL,
                max_tokens: 10000,
                system: [
                  {
                    type: "text",
                    text: systemPrompt,
                    cache_control: { type: "ephemeral", ttl: "1h" },
                  },
                ],
                messages: apiMessages,
                tools: reflectionTools,
              });

              for await (const event of stream) {
                if (
                  event.type === "content_block_delta" &&
                  event.delta.type === "text_delta"
                ) {
                  controller.enqueue(encoder.encode(event.delta.text));
                }
              }

              return await stream.finalMessage();
            });

            lastUsage = finalMsg.usage;

            if (finalMsg.stop_reason !== "tool_use") {
              break;
            }

            apiMessages.push({
              role: "assistant",
              content:
                finalMsg.content as Anthropic.Messages.ContentBlockParam[],
            });

            const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
            for (const block of finalMsg.content) {
              if (block.type !== "tool_use") continue;

              const input = block.input as Record<string, unknown>;
              const summary = summariseToolInput(block.name, input);
              controller.enqueue(
                encoder.encode(`\n→ ${block.name}(${summary})\n`)
              );

              const result = await safeExecuteTool(
                block.name,
                input,
                toolContext
              );

              pushLog("tool_call", {
                name: block.name,
                input: truncate(JSON.stringify(input), 200),
                result: truncate(result, 200),
              });

              if (
                block.name === "log_insight" &&
                !result.startsWith("Error")
              ) {
                insightLogged = true;
              }

              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: result,
              });
            }

            apiMessages.push({ role: "user", content: toolResults });

            if (insightLogged) break;
          }

          if (lastUsage) {
            pushLog("cache_usage", {
              input_tokens: lastUsage.input_tokens,
              cache_write: lastUsage.cache_creation_input_tokens,
              cache_read: lastUsage.cache_read_input_tokens,
            });
          }

          if (insightLogged) {
            const { data: row } = await supabase
              .from("insights")
              .select("id, type, content, significance, created_at, date")
              .eq("athlete_id", athleteId)
              .eq("date", localDate)
              .eq("type", type)
              .maybeSingle();

            writeFinal({
              insight: row,
              iterations,
              cached: false,
            });
          } else {
            pushLog("error", {
              message: "Reflection pass ended without logging an insight",
              type,
              iterations,
            });
            writeFinal({ error: "no_insight_logged", iterations });
          }

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
