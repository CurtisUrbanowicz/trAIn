import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildPulseContext,
  buildDeepContext,
  buildPatternsContext,
  type ReflectionType,
  type InsightType,
} from "@/lib/reflection-context";
import { supabase } from "@/lib/supabase";
import { tools } from "@/lib/tools";
import { executeTool, type ToolContext } from "@/lib/tool-executor";
import { pushLog } from "@/lib/debugLog";
import { REFLECT, ADAPTIVE_THINKING, REFLECT_EFFORT } from "@/lib/models";
import { flagIncompleteStop, thinkingTokensFromEvent } from "@/lib/model-response";
import { appendToolResultsWithCache } from "@/lib/cache-helpers";
import {
  getLatestPatterns,
  isPatternsCurrent,
  type PatternsRow,
} from "@/lib/patterns";

export type { ReflectionType };

const MODEL = REFLECT;

const MAX_ITERATIONS: Record<ReflectionType, number> = {
  pulse: 8,
  deep: 20,
  patterns: 15,
};

// Each pass ends with one output tool call: log_insight for pulse and deep,
// write_patterns for the patterns document.
const OUTPUT_TOOL: Record<ReflectionType, string> = {
  pulse: "log_insight",
  deep: "log_insight",
  patterns: "write_patterns",
};

const GUARD_MESSAGE: Record<ReflectionType, string> = {
  pulse:
    "Two rounds left. Call log_insight now with the best insight you've verified so far.",
  deep:
    "Two rounds left. Call log_insight now with the best insight you've verified so far.",
  patterns:
    "Two rounds left. Call write_patterns now with the document as verified so far.",
};

// The patterns pass also reviews the athlete profile, strictly after
// write_patterns has succeeded
const PROFILE_TOOL = "update_athlete_profile";

const PROFILE_BEFORE_PATTERNS =
  "Error: profile not written — write the patterns document with write_patterns first, then review the profile.";

const PROFILE_REVIEW_HANDOFF =
  "Patterns document written. Now the profile review: check <athlete_profile> against <recent_summaries> as the Profile review section describes. Call update_athlete_profile only if a stated fact changed; otherwise end your turn without a tool call.";

export type InsightRow = {
  id: string;
  type: string;
  content: string;
  significance: number;
  created_at: string;
  date?: string;
};

// The patterns pass's weekly profile review: not called, written, or called
// and every attempt rejected by the executor
export type ProfileReviewOutcome = "unchanged" | "written" | "rejected";

export type ReflectionResult =
  | {
      // pulse and deep: the insight row; patterns: null
      insight: InsightRow | null;
      // patterns: the document row; pulse and deep: undefined
      patterns?: PatternsRow | null;
      // patterns, when the pass ran (not cached); pulse and deep: undefined
      profile?: ProfileReviewOutcome;
      iterations: number;
      cached: boolean;
    }
  | { error: string; iterations?: number; profile?: ProfileReviewOutcome };

export type ReflectionOptions = {
  // Skip the idempotency check and run the pass anyway. For dry runs on past
  // dates from a dev script only — no route or the morning chain's webhook
  // path sets it.
  force?: boolean;
};

export async function getExistingInsight(
  athleteId: string,
  localDate: string,
  type: InsightType
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
  if (name === "write_patterns") {
    const words =
      typeof input.content === "string"
        ? input.content.trim().split(/\s+/).length
        : 0;
    return `through_date=${input.through_date ?? "?"}, ${words} words`;
  }
  if (name === "update_athlete_profile") {
    const words =
      typeof input.content === "string"
        ? input.content.trim().split(/\s+/).length
        : 0;
    return `${words} words`;
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
 * Runs one reflection pass (pulse, deep or patterns). The output is written
 * by the model's own tool call — log_insight for pulse and deep, write_patterns
 * for the patterns document — and this returns the resulting row. Idempotent:
 * an existing insight for (athlete, date, type) short-circuits as cached, and
 * a patterns document already covering the latest summary does too. `onText`
 * receives streamed model text and tool announcements for live UI; the
 * morning chain passes none. Never throws — failures come back as { error }
 * after being logged.
 */
export async function runReflection(
  athleteId: string,
  localDate: string,
  type: ReflectionType,
  onText?: (text: string) => void,
  options: ReflectionOptions = {}
): Promise<ReflectionResult> {
  const emit = (text: string) => {
    if (onText) onText(text);
  };
  let iterations = 0;
  const outputTool = OUTPUT_TOOL[type];
  // Patterns only: the profile review after the document is written
  const reviewsProfile = type === "patterns";
  let profileAttempted = false;
  let profileWritten = false;
  const profileOutcome = (): ProfileReviewOutcome | undefined =>
    !reviewsProfile
      ? undefined
      : profileWritten
        ? "written"
        : profileAttempted
          ? "rejected"
          : "unchanged";

  try {
    if (options.force) {
      // Dry run: no idempotency check
    } else if (type === "patterns") {
      const { current, latest } = await isPatternsCurrent(athleteId, localDate);
      if (current) {
        return { insight: null, patterns: latest, iterations: 0, cached: true };
      }
    } else {
      const existing = await getExistingInsight(athleteId, localDate, type);
      if (existing) return { insight: existing, iterations: 0, cached: true };
    }

    const contextStart = Date.now();
    const { systemPrompt, volatileBlock } =
      type === "pulse"
        ? await buildPulseContext(athleteId, localDate)
        : type === "deep"
          ? await buildDeepContext(athleteId, localDate)
          : await buildPatternsContext(athleteId, localDate);
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
      .filter(
        (t) =>
          t.name === "get_history" ||
          t.name === outputTool ||
          (reviewsProfile && t.name === PROFILE_TOOL)
      )
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

    // The output tool has been called and accepted
    let outputWritten = false;
    let lastUsage: Anthropic.Messages.Usage | null = null;
    // Per iteration, from the raw message_delta (the accumulator drops it)
    const thinkingTokensPerIteration: Array<number | null> = [];
    const maxIters = MAX_ITERATIONS[type];

    for (let i = 0; i < maxIters; i++) {
      iterations = i + 1;

      // Loop guard: with exactly two calls remaining and no output written,
      // tell the model to commit now. Appended as a trailing text block on
      // the tool-results user turn (tool_result blocks must lead a user
      // message, trailing text is valid).
      if (i === maxIters - 2 && !outputWritten) {
        const last = apiMessages[apiMessages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) {
          (last.content as Anthropic.Messages.ContentBlockParam[]).push({
            type: "text",
            text: GUARD_MESSAGE[type],
          });
        } else {
          apiMessages.push({ role: "user", content: GUARD_MESSAGE[type] });
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

        // On Opus 5.5 the notes between tool calls arrive as thinking
        // blocks, not text — with display "summarized" they carry readable
        // text, so forward them too and the Coach cards keep their live
        // feed. One blank line after each thinking block.
        const thinkingBlocks = new Set<number>();
        for await (const event of stream) {
          const tt = thinkingTokensFromEvent(event);
          if (tt !== null) thinkingTokens = tt;
          if (event.type === "content_block_start") {
            if (event.content_block.type === "thinking") {
              thinkingBlocks.add(event.index);
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              emit(event.delta.text);
            } else if (event.delta.type === "thinking_delta") {
              emit(event.delta.thinking);
            }
          } else if (
            event.type === "content_block_stop" &&
            thinkingBlocks.has(event.index)
          ) {
            emit("\n");
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

      // Profile calls wait for the rest of the round, so a write_patterns in
      // the same response lands first; before any successful write_patterns
      // they are refused — the document always comes before the review.
      const outputWasWritten = outputWritten;
      const results: string[] = new Array(toolUses.length);
      await Promise.all(
        toolUses.map(async (block, idx) => {
          if (block.name === PROFILE_TOOL) return;
          results[idx] = await safeExecuteTool(
            block.name,
            block.input as Record<string, unknown>,
            toolContext
          );
          if (block.name === outputTool && !results[idx]!.startsWith("Error")) {
            outputWritten = true;
          }
        })
      );
      let profileRanThisRound = false;
      for (let idx = 0; idx < toolUses.length; idx++) {
        const block = toolUses[idx]!;
        if (block.name !== PROFILE_TOOL) continue;
        if (!outputWritten) {
          results[idx] = PROFILE_BEFORE_PATTERNS;
          continue;
        }
        profileAttempted = true;
        profileRanThisRound = true;
        results[idx] = await safeExecuteTool(
          block.name,
          block.input as Record<string, unknown>,
          toolContext
        );
        if (!results[idx]!.startsWith("Error")) profileWritten = true;
      }

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = toolUses.map(
        (block, idx) => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: results[idx]!,
        })
      );

      appendToolResultsWithCache(apiMessages, toolResults);

      if (outputWritten && !reviewsProfile) break;
      // The document just landed: hand over to the profile review, unless
      // the model already reviewed it in the same round
      if (outputWritten && !outputWasWritten && !profileRanThisRound) {
        const last = apiMessages[apiMessages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) {
          (last.content as Anthropic.Messages.ContentBlockParam[]).push({
            type: "text",
            text: PROFILE_REVIEW_HANDOFF,
          });
        }
      }
      if (profileWritten) break;
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

    if (outputWritten) {
      if (type === "patterns") {
        const row = await getLatestPatterns(athleteId);
        return {
          insight: null,
          patterns: row,
          profile: profileOutcome(),
          iterations,
          cached: false,
        };
      }

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
      message: `Reflection pass ended without calling ${outputTool}`,
      type,
      iterations,
    });
    return {
      error: type === "patterns" ? "no_patterns_written" : "no_insight_logged",
      iterations,
      profile: profileOutcome(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushLog("error", { message, type });
    console.error(`[reflect] ${type} pass failed:`, message);
    return { error: message, iterations, profile: profileOutcome() };
  }
}
