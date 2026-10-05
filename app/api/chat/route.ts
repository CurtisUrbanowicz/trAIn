import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { buildContext, type TabType } from "@/lib/context";
import { supabase } from "@/lib/supabase";
import { getToolsForTab } from "@/lib/tools";
import { executeTool, type ToolContext } from "@/lib/tool-executor";
import { pushLog } from "@/lib/debugLog";
import { describeToolCall } from "@/lib/tool-status";
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
// Extended thinking on every tab. Reasoning belongs in thinking, never in
// text — all text is the reply and is persisted. Today gets the smaller
// budget for latency.
const THINKING_BUDGET_TOKENS: Record<TabType, number> = {
  today: 1024,
  week: 2048,
  season: 2048,
  coach: 2048,
};

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
    const thinking: Anthropic.ThinkingConfigParam = {
      type: "enabled",
      budget_tokens: THINKING_BUDGET_TOKENS[tab],
    };

    const readable = new ReadableStream({
      async start(controller) {
        // Request timing — one "timing" entry pushed at the end.
        // first_token_ms = first frame enqueued to the client, whatever it is.
        let firstTokenMs: number | null = null;
        const rounds: Array<{
          round: number;
          api_ms: number;
          tools_ms: number;
          tools: number;
          text_chars: number;
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

        // NDJSON protocol: one JSON object per line.
        //   {"t":"text","v":"…"}    model reply text, every round, as it streams
        //   {"t":"status","v":"…"}  code-generated line per tool call
        //   {"t":"done"}            end of turn
        const encoder = new TextEncoder();
        const send = (
          frame: { t: "text" | "status"; v: string } | { t: "done" }
        ) => {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
          controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
        };

        // Every round's text is the reply and is persisted. Each round's
        // text is trimmed and non-empty rounds are joined with "\n\n" —
        // the text frames are emitted so the client's concatenation is
        // exactly that join, i.e. the bubble equals the persisted row.
        const roundTexts: string[] = [];

        // One streaming call. Used for every round: tool rounds and the
        // safety net (toolChoiceNone) alike.
        const runRound = async (
          toolChoiceNone: boolean
        ): Promise<{ response: Anthropic.Messages.Message; text: string; apiMs: number }> => {
          const apiStart = Date.now();
          let text = "";
          let pendingWs = "";
          let started = false;

          // Trims the round on the fly: leading whitespace is dropped,
          // trailing whitespace is held back until more text follows it.
          const emitText = (delta: string) => {
            let chunk = pendingWs + delta;
            if (!started) chunk = chunk.trimStart();
            const body = chunk.trimEnd();
            pendingWs = chunk.slice(body.length);
            if (!body) return;
            let out = body;
            if (!started) {
              started = true;
              if (roundTexts.length > 0) out = "\n\n" + body;
            }
            text += body;
            send({ t: "text", v: out });
          };

          const response = await createMessage(async (model) => {
            // Reset on retry — overloaded errors fire before any tokens
            // stream, so we re-enter with a clean slate.
            text = "";
            pendingWs = "";
            started = false;
            // tool_use input arrives as JSON deltas; assembled per block so
            // the status line can read it when the block closes.
            const toolInputs = new Map<number, { name: string; json: string }>();

            const stream = anthropic.messages.stream({
              model,
              max_tokens: 10000,
              thinking,
              system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
              messages: apiMessages,
              tools: toolsForRequest,
              ...(toolChoiceNone ? { tool_choice: { type: "none" as const } } : {}),
            });

            for await (const event of stream) {
              if (event.type === "content_block_start") {
                if (event.content_block.type === "tool_use") {
                  toolInputs.set(event.index, {
                    name: event.content_block.name,
                    json: "",
                  });
                }
              } else if (event.type === "content_block_delta") {
                if (event.delta.type === "text_delta") {
                  emitText(event.delta.text);
                } else if (event.delta.type === "input_json_delta") {
                  const t = toolInputs.get(event.index);
                  if (t) t.json += event.delta.partial_json;
                }
              } else if (event.type === "content_block_stop") {
                const t = toolInputs.get(event.index);
                if (t) {
                  let input: Record<string, unknown> = {};
                  try {
                    input = t.json ? JSON.parse(t.json) : {};
                  } catch {
                    // Status line falls back to the tool's default
                  }
                  send({ t: "status", v: describeToolCall(t.name, input) });
                }
              }
            }

            return await stream.finalMessage();
          });

          recordUsage(response.usage);
          if (text) roundTexts.push(text);
          return { response, text, apiMs: Date.now() - apiStart };
        };

        try {
          // answered: the last round ended without tool calls and wrote text
          let answered = false;

          for (let round = 1; round <= MAX_TOOL_ITERATIONS[tab]; round++) {
            const { response, text, apiMs } = await runRound(false);

            if (round === 1) {
              pushLog("cache_usage", {
                input_tokens: response.usage.input_tokens,
                // SDK 0.80.0 has no separate thinking-token field — thinking
                // tokens are counted inside output_tokens.
                output_tokens: response.usage.output_tokens,
                thinking_enabled: true,
                cache_write: response.usage.cache_creation_input_tokens,
                cache_read: response.usage.cache_read_input_tokens,
              });
            }

            const toolUses = response.content.filter(
              (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
            );

            if (toolUses.length === 0) {
              rounds.push({
                round,
                api_ms: apiMs,
                tools_ms: 0,
                tools: 0,
                text_chars: text.length,
                ...(text ? { text } : {}),
              });
              answered = text !== "";
              break;
            }

            // Append the assistant turn (thinking + text + tool_use blocks)
            apiMessages.push({
              role: "assistant" as const,
              content: response.content as Anthropic.Messages.ContentBlockParam[],
            });

            const toolsStart = Date.now();
            const toolResults = await runTools(round, toolUses);
            rounds.push({
              round,
              api_ms: apiMs,
              tools_ms: Date.now() - toolsStart,
              tools: toolResults.length,
              text_chars: text.length,
              ...(text ? { text } : {}),
            });
            appendToolResultsWithCache(apiMessages, toolResults);
          }

          // Safety net: the loop hit its cap with tool results unanswered,
          // or the last round ended with no text. One more call, tools
          // disabled, to get the reply.
          if (!answered) {
            const { text, apiMs } = await runRound(true);
            rounds.push({
              round: rounds.length + 1,
              api_ms: apiMs,
              tools_ms: 0,
              tools: 0,
              text_chars: text.length,
              ...(text ? { text } : {}),
            });
          }

          // Persist the full reply (user message already saved above)
          const fullResponse = roundTexts.join("\n\n");
          if (fullResponse !== "") {
            try {
              await supabase.from("messages").insert({
                athlete_id: ATHLETE_ID,
                date: localDate,
                tab,
                role: "assistant",
                content: fullResponse,
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
            // Round text lives in the turn record; the debug log gets counts
            rounds: rounds.map((r) => ({
              round: r.round,
              api_ms: r.api_ms,
              tools_ms: r.tools_ms,
              tools: r.tools,
              text_chars: r.text_chars,
            })),
            total_ms: Date.now() - t0,
          });

          send({ t: "done" });
          controller.close();
          saveTurnRecord(fullResponse || null);
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
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
