import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { buildContext, type TabType } from "@/lib/context";
import { supabase } from "@/lib/supabase";
import { getToolsForTab } from "@/lib/tools";
import { executeTool, type ToolContext } from "@/lib/tool-executor";
import { pushLog } from "@/lib/debugLog";
import {
  insertTurnRecord,
  type TurnToolCall,
  type TurnUsageRound,
} from "@/lib/turnRecords";
import { CHAT_PRIMARY, CHAT_FALLBACK } from "@/lib/models";
import {
  appendToolResultsWithCache,
  historyWithLastAssistantCached,
} from "@/lib/cache-helpers";

// Vercel Hobby (Fluid compute) cap
export const maxDuration = 300;

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";
const MAX_TOOL_ITERATIONS: Record<TabType, number> = {
  today: 5,
  week: 5,
  season: 10,
  coach: 10,
};
const THINKING_DELIMITER = "\x00THINKING\x00";
const FINAL_DELIMITER = "\x00FINAL\x00";

// Extended thinking — per tab; today stays off for latency.
const THINKING_TABS = new Set<TabType>(["week", "season", "coach"]);
const THINKING_BUDGET_TOKENS = 2048;

const TAB_VALUES = new Set<TabType>([
  "coach",
  "today",
  "week",
  "season",
]);

function parseTab(value: unknown): TabType {
  return typeof value === "string" && TAB_VALUES.has(value as TabType)
    ? (value as TabType)
    : "coach";
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
    console.error(`[chat] tool ${name} failed:`, msg);
    return `Tool execution failed: ${msg}`;
  }
}

export async function POST(request: Request) {
  const t0 = Date.now();
  try {
    const body = (await request.json()) as {
      message?: string;
      localDate?: string;
      localTime?: string;
      tab?: string;
      history?: Array<{ role: string; content: string }>;
    };

    const message = body.message;
    const localDate = body.localDate;
    const localTime = body.localTime;
    const tab = parseTab(body.tab);

    if (typeof message !== "string") {
      throw new Error("message must be a string");
    }
    if (typeof localDate !== "string" || !localDate) {
      throw new Error("localDate is required (YYYY-MM-DD)");
    }

    const rawHistory = Array.isArray(body.history) ? body.history : [];
    const history = rawHistory
      .filter(
        (h): h is { role: "user" | "assistant"; content: string } =>
          (h.role === "user" || h.role === "assistant") &&
          typeof h.content === "string"
      )
      .map((h) => ({ role: h.role, content: h.content }));

    const contextStart = Date.now();
    const { systemPrompt, volatileBlock } = await buildContext(
      ATHLETE_ID,
      tab,
      localDate,
      localTime
    );
    const contextMs = Date.now() - contextStart;

    pushLog("context_loaded", { tab, contextBlockLength: volatileBlock.length });

    const messagesForApi: Anthropic.MessageParam[] =
      message.trim() === ""
        ? [{ role: "user" as const, content: volatileBlock }]
        : [
            ...historyWithLastAssistantCached(history),
            {
              role: "user" as const,
              content: `<message>\n\n${message}\n\n</message>\n\n${volatileBlock}`,
            },
          ];

    // Save user message immediately (don't wait for AI response)
    if (message.trim() !== "") {
      try {
        await supabase.from("messages").insert({
          athlete_id: ATHLETE_ID,
          date: localDate,
          tab,
          role: "user",
          content: message,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[chat] failed to save user message:", err);
      }
    }

    const anthropic = new Anthropic();
    const toolContext: ToolContext = { athleteId: ATHLETE_ID, localDate, localTime };

    // Model selection: try Opus, retry once on overloaded, then fall back
    // to Sonnet. The fallback decision is made on the first call only — every
    // subsequent call in this request reuses the model the first call settled
    // on, so we never switch mid-tool-loop.
    type ModelName = typeof CHAT_PRIMARY | typeof CHAT_FALLBACK;
    let currentModel: ModelName = CHAT_PRIMARY;
    let firstCallComplete = false;

    const createMessage = async <T>(
      fn: (model: ModelName) => Promise<T>
    ): Promise<T> => {
      if (firstCallComplete) {
        const result = await fn(currentModel);
        pushLog("model_used", { model: currentModel, attempt: 1 });
        return result;
      }

      try {
        const result = await fn(CHAT_PRIMARY);
        pushLog("model_used", { model: CHAT_PRIMARY, attempt: 1 });
        firstCallComplete = true;
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes("overloaded")) {
          firstCallComplete = true;
          throw err;
        }

        await new Promise((r) => setTimeout(r, 2000));

        try {
          const result = await fn(CHAT_PRIMARY);
          pushLog("model_used", { model: CHAT_PRIMARY, attempt: 2 });
          firstCallComplete = true;
          return result;
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          if (!msg2.toLowerCase().includes("overloaded")) {
            firstCallComplete = true;
            throw err2;
          }

          currentModel = CHAT_FALLBACK;
          const result = await fn(currentModel);
          pushLog("model_used", { model: currentModel, attempt: 3 });
          firstCallComplete = true;
          return result;
        }
      }
    }

    // Mutable copy — tool results get appended during the loop
    const apiMessages: Anthropic.MessageParam[] = [...messagesForApi];

    const toolsForRequest = getToolsForTab(tab);

    // Decided once per request and applied to every call in the tool loop —
    // never toggled mid-loop, so thinking blocks in earlier assistant turns
    // stay valid for subsequent calls.
    const thinking: Anthropic.ThinkingConfigParam | undefined =
      THINKING_TABS.has(tab)
        ? { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS }
        : undefined;

    const readable = new ReadableStream({
      async start(controller) {
        // Request timing — one "timing" entry pushed at the end.
        // first_token_ms = first byte enqueued to the client, whatever it is.
        let firstTokenMs: number | null = null;
        const rounds: Array<{
          round: number;
          api_ms: number;
          tools_ms: number;
          tools: number;
          text?: string;
        }> = [];

        // Turn record (turn_records): assembled from what's already in
        // memory and inserted after the stream closes. No thinking text.
        const turnToolCalls: TurnToolCall[] = [];
        const usageRounds: TurnUsageRound[] = [];
        const recordUsage = (usage: Anthropic.Messages.Usage) => {
          usageRounds.push({
            round: usageRounds.length + 1,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read: usage.cache_read_input_tokens ?? 0,
            cache_write: usage.cache_creation_input_tokens ?? 0,
          });
        };
        const roundText = (blocks: Anthropic.Messages.Message["content"]) =>
          blocks
            .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim() || undefined;
        const runTools = (
          round: number,
          toolUses: Anthropic.Messages.ToolUseBlock[]
        ): Promise<Anthropic.Messages.ToolResultBlockParam[]> =>
          // Parallel; map preserves result order against block order, and
          // safeExecuteTool never rejects.
          Promise.all(
            toolUses.map(async (block, idx) => {
              const result = await safeExecuteTool(
                block.name,
                block.input as Record<string, unknown>,
                toolContext
              );
              turnToolCalls.push({
                round,
                index: idx,
                name: block.name,
                input: block.input,
                result,
              });
              return {
                type: "tool_result" as const,
                tool_use_id: block.id,
                content: result,
              };
            })
          );
        const saveTurnRecord = (finalMessage: string | null, error?: string) => {
          // Tool calls finish in parallel; restore block order.
          turnToolCalls.sort((a, b) => a.round - b.round || a.index - b.index);
          const sum = (k: keyof Omit<TurnUsageRound, "round">) =>
            usageRounds.reduce((acc, r) => acc + r[k], 0);
          waitUntil(
            insertTurnRecord({
              athlete_id: ATHLETE_ID,
              tab,
              date: localDate,
              user_message: message,
              context_block: volatileBlock,
              tool_calls: turnToolCalls,
              final_message: finalMessage,
              model: currentModel,
              timing: {
                context_ms: contextMs,
                first_token_ms: firstTokenMs,
                tool_rounds: rounds.filter((r) => r.tools > 0).length,
                rounds,
                total_ms: Date.now() - t0,
                ...(error ? { error } : {}),
              },
              usage: {
                input_tokens: sum("input_tokens"),
                output_tokens: sum("output_tokens"),
                cache_read: sum("cache_read"),
                cache_write: sum("cache_write"),
                rounds: usageRounds,
              },
            })
          );
        };
        const enqueue = (chunk: Uint8Array) => {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
          controller.enqueue(chunk);
        };
        try {
          // fullResponse: only the final coaching text, persisted to DB
          let fullResponse = "";

          // Atomic final emission: the FINAL delimiter and its text are
          // always enqueued together, or neither. A zero-text response
          // cannot leak a naked delimiter to the client.
          const emitFinalTurn = (
            blocks: Anthropic.Messages.Message["content"]
          ): boolean => {
            let text = "";
            for (const block of blocks) {
              if (block.type === "text") {
                text += block.text;
              }
            }
            text = text.trimStart();
            if (!text) return false;
            enqueue(new TextEncoder().encode(FINAL_DELIMITER));
            enqueue(new TextEncoder().encode(text));
            fullResponse += text;
            return true;
          };

          // ── Initial call: stream to client ──────────────────────
          // Text deltas pipe directly to the frontend. If the model
          // triggers tool use we detect it here and drop into the
          // non-streaming create() loop below.
          let hasToolUse = false;
          let streamedText = "";
          let sawNonWhitespace = false;

          const initialApiStart = Date.now();
          const initialFinalMsg = await createMessage(async (model) => {
            // Reset on retry — overloaded errors fire before any tokens
            // stream, so we should be re-entering with a clean slate.
            streamedText = "";
            hasToolUse = false;
            sawNonWhitespace = false;

            const stream = anthropic.messages.stream({
              model,
              max_tokens: 10000,
              ...(thinking ? { thinking } : {}),
              system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
              messages: apiMessages,
              tools: toolsForRequest,
            });

            for await (const event of stream) {
              if (
                event.type === "content_block_delta" &&
                event.delta.type === "text_delta"
              ) {
                streamedText += event.delta.text;
                if (!sawNonWhitespace) {
                  const trimmed = event.delta.text.trimStart();
                  if (trimmed === "") continue;
                  enqueue(new TextEncoder().encode(trimmed));
                  sawNonWhitespace = true;
                } else {
                  enqueue(new TextEncoder().encode(event.delta.text));
                }
              }
              if (
                event.type === "content_block_start" &&
                event.content_block.type === "tool_use"
              ) {
                hasToolUse = true;
              }
            }

            return await stream.finalMessage();
          });
          const initialApiMs = Date.now() - initialApiStart;
          recordUsage(initialFinalMsg.usage);

          pushLog("cache_usage", {
            input_tokens: initialFinalMsg.usage.input_tokens,
            // SDK 0.80.0 has no separate thinking-token field — thinking
            // tokens are counted inside output_tokens.
            output_tokens: initialFinalMsg.usage.output_tokens,
            thinking_enabled: thinking !== undefined,
            cache_write: initialFinalMsg.usage.cache_creation_input_tokens,
            cache_read: initialFinalMsg.usage.cache_read_input_tokens,
          });

          if (!hasToolUse) {
            // No tools — streamed text is the final response
            rounds.push({ round: 1, api_ms: initialApiMs, tools_ms: 0, tools: 0 });
            fullResponse = streamedText;
          } else {
            // ── Tool-use loop (non-streaming) ────────────────────
            enqueue(new TextEncoder().encode(THINKING_DELIMITER));

            // Append the assistant turn (text + tool_use blocks)
            apiMessages.push({
              role: "assistant" as const,
              content:
                initialFinalMsg.content as Anthropic.Messages.ContentBlockParam[],
            });

            // Execute the tool calls from the initial response in parallel
            const initialToolsStart = Date.now();
            const initialToolUses = initialFinalMsg.content.filter(
              (b): b is Anthropic.Messages.ToolUseBlock =>
                b.type === "tool_use"
            );
            const initialToolResults = await runTools(1, initialToolUses);
            rounds.push({
              round: 1,
              text: roundText(initialFinalMsg.content),
              api_ms: initialApiMs,
              tools_ms: Date.now() - initialToolsStart,
              tools: initialToolResults.length,
            });
            appendToolResultsWithCache(apiMessages, initialToolResults);

            // Subsequent iterations use create() — no streaming
            for (let i = 1; i < MAX_TOOL_ITERATIONS[tab]; i++) {
              const apiStart = Date.now();
              const response = await createMessage((model) =>
                anthropic.messages.create({
                  model,
                  max_tokens: 10000,
                  ...(thinking ? { thinking } : {}),
                  system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
                  messages: apiMessages,
                  tools: toolsForRequest,
                })
              );
              const apiMs = Date.now() - apiStart;
              recordUsage(response.usage);
              const roundNo = rounds.length + 1;

              const hasMoreTools = response.content.some(
                (b) => b.type === "tool_use"
              );

              if (!hasMoreTools) {
                // Final response — emit atomically. If the model returned
                // no text, fullResponse stays empty and the safety net
                // below will make one more call.
                rounds.push({ round: roundNo, api_ms: apiMs, tools_ms: 0, tools: 0 });
                emitFinalTurn(response.content);
                break;
              }

              // Intermediate response with text + tool_use:
              // stream text to client (visible) but don't persist
              for (const block of response.content) {
                if (block.type === "text" && block.text) {
                  enqueue(new TextEncoder().encode(block.text));
                }
              }

              apiMessages.push({
                role: "assistant" as const,
                content:
                  response.content as Anthropic.Messages.ContentBlockParam[],
              });

              const loopToolsStart = Date.now();
              const loopToolUses = response.content.filter(
                (b): b is Anthropic.Messages.ToolUseBlock =>
                  b.type === "tool_use"
              );
              const loopToolResults = await runTools(roundNo, loopToolUses);
              rounds.push({
                round: roundNo,
                text: roundText(response.content),
                api_ms: apiMs,
                tools_ms: Date.now() - loopToolsStart,
                tools: loopToolResults.length,
              });
              appendToolResultsWithCache(apiMessages, loopToolResults);
            }

            // Safety net: fullResponse === "" means emitFinalTurn never
            // succeeded — either the loop exhausted without reaching
            // !hasMoreTools, or it reached it but the model returned no
            // text. One more call to get the answer.
            if (fullResponse === "") {
              const finalApiStart = Date.now();
              const finalResponse = await createMessage((model) =>
                anthropic.messages.create({
                  model,
                  max_tokens: 10000,
                  ...(thinking ? { thinking } : {}),
                  system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
                  messages: apiMessages,
                  tools: toolsForRequest,
                })
              );
              recordUsage(finalResponse.usage);
              rounds.push({
                round: rounds.length + 1,
                api_ms: Date.now() - finalApiStart,
                tools_ms: 0,
                tools: 0,
              });
              emitFinalTurn(finalResponse.content);
            }
          }

          // Persist assistant response (user message already saved above)
          const persistedResponse = fullResponse.trimStart();
          if (persistedResponse.trim() !== "") {
            try {
              await supabase.from("messages").insert({
                athlete_id: ATHLETE_ID,
                date: localDate,
                tab,
                role: "assistant",
                content: persistedResponse,
                timestamp: new Date().toISOString(),
              });
            } catch (saveError) {
              console.error("[chat] failed to save assistant message:", saveError);
            }
          }

          pushLog("timing", {
            tab,
            context_ms: contextMs,
            first_token_ms: firstTokenMs,
            tool_rounds: rounds.filter((r) => r.tools > 0).length,
            rounds,
            total_ms: Date.now() - t0,
          });

          controller.close();
          saveTurnRecord(persistedResponse || null);
        } catch (streamErr) {
          const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
          pushLog("error", { message: errMsg, total_ms: Date.now() - t0 });
          saveTurnRecord(null, errMsg);
          console.error("[chat] streaming failed:", streamErr);
          controller.error(streamErr);
        }
      },
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
