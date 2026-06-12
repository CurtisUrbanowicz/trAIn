import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { buildContext, type TabType } from "@/lib/context";
import { supabase } from "@/lib/supabase";
import { getToolsForTab } from "@/lib/tools";
import { executeTool, type ToolContext } from "@/lib/tool-executor";
import { pushLog } from "@/lib/debugLog";
import {
  appendToolResultsWithCache,
  historyWithLastAssistantCached,
} from "@/lib/cache-helpers";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";
const MAX_TOOL_ITERATIONS = 5;
const THINKING_DELIMITER = "\x00THINKING\x00";
const FINAL_DELIMITER = "\x00FINAL\x00";

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

    const { systemPrompt, volatileBlock } = await buildContext(
      ATHLETE_ID,
      tab,
      localDate,
      localTime
    );

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
    const toolContext: ToolContext = { athleteId: ATHLETE_ID, localDate };

    // Model selection: try Opus, retry once on overloaded, then fall back
    // to Sonnet. The fallback decision is made on the first call only — every
    // subsequent call in this request reuses the model the first call settled
    // on, so we never switch mid-tool-loop.
    type ModelName = "claude-opus-4-6" | "claude-sonnet-4-6";
    let currentModel: ModelName = "claude-opus-4-6";
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
        const result = await fn("claude-opus-4-6");
        pushLog("model_used", { model: "claude-opus-4-6", attempt: 1 });
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
          const result = await fn("claude-opus-4-6");
          pushLog("model_used", { model: "claude-opus-4-6", attempt: 2 });
          firstCallComplete = true;
          return result;
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          if (!msg2.toLowerCase().includes("overloaded")) {
            firstCallComplete = true;
            throw err2;
          }

          currentModel = "claude-sonnet-4-6";
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

    const readable = new ReadableStream({
      async start(controller) {
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
            controller.enqueue(new TextEncoder().encode(FINAL_DELIMITER));
            controller.enqueue(new TextEncoder().encode(text));
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

          const initialFinalMsg = await createMessage(async (model) => {
            // Reset on retry — overloaded errors fire before any tokens
            // stream, so we should be re-entering with a clean slate.
            streamedText = "";
            hasToolUse = false;
            sawNonWhitespace = false;

            const stream = anthropic.messages.stream({
              model,
              max_tokens: 10000,
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
                  controller.enqueue(new TextEncoder().encode(trimmed));
                  sawNonWhitespace = true;
                } else {
                  controller.enqueue(
                    new TextEncoder().encode(event.delta.text)
                  );
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

          pushLog("cache_usage", {
            input_tokens: initialFinalMsg.usage.input_tokens,
            cache_write: initialFinalMsg.usage.cache_creation_input_tokens,
            cache_read: initialFinalMsg.usage.cache_read_input_tokens,
          });

          if (!hasToolUse) {
            // No tools — streamed text is the final response
            fullResponse = streamedText;
          } else {
            // ── Tool-use loop (non-streaming) ────────────────────
            controller.enqueue(
              new TextEncoder().encode(THINKING_DELIMITER)
            );

            // Append the assistant turn (text + tool_use blocks)
            apiMessages.push({
              role: "assistant" as const,
              content:
                initialFinalMsg.content as Anthropic.Messages.ContentBlockParam[],
            });

            // Execute the tool calls from the initial response
            const initialToolResults: Anthropic.Messages.ToolResultBlockParam[] =
              [];
            for (const block of initialFinalMsg.content) {
              if (block.type === "tool_use") {
                const result = await safeExecuteTool(
                  block.name,
                  block.input as Record<string, unknown>,
                  toolContext
                );
                initialToolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: result,
                });
              }
            }
            appendToolResultsWithCache(apiMessages, initialToolResults);

            // Subsequent iterations use create() — no streaming
            for (let i = 1; i < MAX_TOOL_ITERATIONS; i++) {
              const response = await createMessage((model) =>
                anthropic.messages.create({
                  model,
                  max_tokens: 10000,
                  system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
                  messages: apiMessages,
                  tools: toolsForRequest,
                })
              );

              const hasMoreTools = response.content.some(
                (b) => b.type === "tool_use"
              );

              if (!hasMoreTools) {
                // Final response — emit atomically. If the model returned
                // no text, fullResponse stays empty and the safety net
                // below will make one more call.
                emitFinalTurn(response.content);
                break;
              }

              // Intermediate response with text + tool_use:
              // stream text to client (visible) but don't persist
              for (const block of response.content) {
                if (block.type === "text" && block.text) {
                  controller.enqueue(
                    new TextEncoder().encode(block.text)
                  );
                }
              }

              apiMessages.push({
                role: "assistant" as const,
                content:
                  response.content as Anthropic.Messages.ContentBlockParam[],
              });

              const loopToolResults: Anthropic.Messages.ToolResultBlockParam[] =
                [];
              for (const block of response.content) {
                if (block.type === "tool_use") {
                  const result = await safeExecuteTool(
                    block.name,
                    block.input as Record<string, unknown>,
                    toolContext
                  );
                  loopToolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: result,
                  });
                }
              }
              appendToolResultsWithCache(apiMessages, loopToolResults);
            }

            // Safety net: fullResponse === "" means emitFinalTurn never
            // succeeded — either the loop exhausted without reaching
            // !hasMoreTools, or it reached it but the model returned no
            // text. One more call to get the answer.
            if (fullResponse === "") {
              const finalResponse = await createMessage((model) =>
                anthropic.messages.create({
                  model,
                  max_tokens: 10000,
                  system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
                  messages: apiMessages,
                  tools: toolsForRequest,
                })
              );
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

          controller.close();
        } catch (streamErr) {
          const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
          pushLog("error", { message: errMsg });
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
