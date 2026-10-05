import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildPulseContext,
  buildDeepContext,
  type ReflectionType,
} from "@/lib/reflection-context";
import { supabase } from "@/lib/supabase";
import { tools } from "@/lib/tools";
import { executeTool, type ToolContext } from "@/lib/tool-executor";
import { pushLog } from "@/lib/debugLog";
import { REFLECT, ADAPTIVE_THINKING, REFLECT_EFFORT } from "@/lib/models";
import { flagIncompleteStop, thinkingTokensFromEvent } from "@/lib/model-response";
import { appendToolResultsWithCache } from "@/lib/cache-helpers";

export type { ReflectionType };

const MODEL = REFLECT;

const MAX_ITERATIONS: Record<ReflectionType, number> = {
  pulse: 8,
  deep: 20,
};

const GUARD_MESSAGE =
  "Two rounds left. Call log_insight now with the best insight you've verified so far.";

export type InsightRow = {
  id: string;
  type: string;
  content: string;
  significance: number;
  created_at: string;
  date?: string;
};

export type ReflectionResult =
  | { insight: InsightRow | null; iterations: number; cached: boolean }
  | { error: string; iterations?: number };

export async function getExistingInsight(
  athleteId: string,
  localDate: string,
  type: ReflectionType
): Promise<InsightRow | null> {
  const { data } = await supabase
    .from("insights")
    .select("id, type, content, significance, created_at")
    .eq("athlete_id", athleteId)
    .eq("date", localDate)
    .eq("type", type)
    .maybeSingle();
  return (data as InsightRow | null) ?? null;
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

/**
 * Runs one reflection pass (pulse or deep). The insight is persisted by the
 * model's own log_insight call; this returns the resulting row. Idempotent
 * per (athlete, date, type): an existing insight short-circuits as cached.
 * `onText` receives streamed model text and tool announcements for live UI;
 * the morning chain passes none. Never throws — failures come back as
 * { error } after being logged.
 */
export async function runReflection(
  athleteId: string,
  localDate: string,
  type: ReflectionType,
  onText?: (text: string) => void
): Promise<ReflectionResult> {
  const emit = (text: string) => {
    if (onText) onText(text);
  };
  let iterations = 0;

  try {
    const existing = await getExistingInsight(athleteId, localDate, type);
    if (existing) return { insight: existing, iterations: 0, cached: true };

    const contextStart = Date.now();
    const { systemPrompt, volatileBlock } =
      type === "pulse"
        ? await buildPulseContext(athleteId, localDate)
        : await buildDeepContext(athleteId, localDate);
    const contextMs = Date.now() - contextStart;

    pushLog("context_loaded", {
      tab: `reflect-${type}`,
      type,
      contextBlockLength: volatileBlock.length,
      systemPromptLength: systemPrompt.length,
      context_ms: contextMs,
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
      { role: "user", content: volatileBlock },
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

    let insightLogged = false;
    let lastUsage: Anthropic.Messages.Usage | null = null;
    // Per iteration, from the raw message_delta (the accumulator drops it)
    const thinkingTokensPerIteration: Array<number | null> = [];
    const maxIters = MAX_ITERATIONS[type];

    for (let i = 0; i < maxIters; i++) {
      iterations = i + 1;

      // Loop guard: with exactly two calls remaining and no insight
      // logged, tell the model to commit now. Appended as a trailing
      // text block on the tool-results user turn (tool_result blocks
      // must lead a user message, trailing text is valid).
      if (i === maxIters - 2 && !insightLogged) {
        const last = apiMessages[apiMessages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) {
          (last.content as Anthropic.Messages.ContentBlockParam[]).push({
            type: "text",
            text: GUARD_MESSAGE,
          });
        } else {
          apiMessages.push({ role: "user", content: GUARD_MESSAGE });
        }
        pushLog("guard_fired", { type, iteration: iterations, maxIters });
      }

      let thinkingTokens: number | null = null;
      const finalMsg = await callWithRetry(async () => {
        thinkingTokens = null;
        const stream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          thinking: ADAPTIVE_THINKING,
          output_config: { effort: REFLECT_EFFORT },
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
          const tt = thinkingTokensFromEvent(event);
          if (tt !== null) thinkingTokens = tt;
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            emit(event.delta.text);
          }
        }

        return await stream.finalMessage();
      });

      lastUsage = finalMsg.usage;
      thinkingTokensPerIteration.push(thinkingTokens);
      flagIncompleteStop("reflect", finalMsg, { type, iteration: iterations });

      if (finalMsg.stop_reason !== "tool_use") {
        break;
      }

      apiMessages.push({
        role: "assistant",
        content: finalMsg.content as Anthropic.Messages.ContentBlockParam[],
      });

      const toolUses = finalMsg.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
      );

      // Announce all calls up front, then execute in parallel —
      // results are processed in block order below.
      for (const block of toolUses) {
        const summary = summariseToolInput(
          block.name,
          block.input as Record<string, unknown>
        );
        emit(`\n→ ${block.name}(${summary})\n`);
      }

      const results = await Promise.all(
        toolUses.map((block) =>
          safeExecuteTool(
            block.name,
            block.input as Record<string, unknown>,
            toolContext
          )
        )
      );

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      toolUses.forEach((block, idx) => {
        const result = results[idx]!;

        if (block.name === "log_insight" && !result.startsWith("Error")) {
          insightLogged = true;
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      });

      appendToolResultsWithCache(apiMessages, toolResults);

      if (insightLogged) break;
    }

    if (lastUsage) {
      pushLog("cache_usage", {
        input_tokens: lastUsage.input_tokens,
        // output_tokens includes thinking tokens
        output_tokens: lastUsage.output_tokens,
        thinking_tokens: thinkingTokensPerIteration,
        thinking_tokens_total: thinkingTokensPerIteration.reduce<number>(
          (acc, n) => acc + (n ?? 0),
          0
        ),
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

      return {
        insight: (row as InsightRow | null) ?? null,
        iterations,
        cached: false,
      };
    }

    pushLog("error", {
      message: "Reflection pass ended without logging an insight",
      type,
      iterations,
    });
    return { error: "no_insight_logged", iterations };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushLog("error", { message, type });
    console.error(`[reflect] ${type} pass failed:`, message);
    return { error: message, iterations };
  }
}
