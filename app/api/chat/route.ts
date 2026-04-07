import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { buildContext, type TabType } from "@/lib/context";
import { supabase } from "@/lib/supabase";
import { tools } from "@/lib/tools";
import { executeTool, type ToolContext } from "@/lib/tool-executor";

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
      tab?: string;
      history?: Array<{ role: string; content: string }>;
    };

    const message = body.message;
    const localDate = body.localDate;
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

    const { systemPrompt, contextBlock } = await buildContext(
      ATHLETE_ID,
      tab,
      localDate
    );

    const messagesForApi =
      message.trim() === ""
        ? [{ role: "user" as const, content: contextBlock }]
        : [
            { role: "user" as const, content: contextBlock },
            ...history,
            { role: "user" as const, content: message },
          ];

    const anthropic = new Anthropic();
    const toolContext: ToolContext = { athleteId: ATHLETE_ID, localDate };

    console.log("=== RAW API CALL ===");
    console.log("MODEL:", "claude-sonnet-4-6");
    console.log("MAX_TOKENS:", 10000);
    console.log("SYSTEM PROMPT:", JSON.stringify(systemPrompt));
    console.log("MESSAGES:", JSON.stringify(messagesForApi));

    // Mutable copy — tool results get appended during the loop
    const apiMessages: Anthropic.MessageParam[] = [...messagesForApi];

    const readable = new ReadableStream({
      async start(controller) {
        try {
          // fullResponse: only the final coaching text, persisted to DB
          let fullResponse = "";

          // ── Initial call: stream to client ──────────────────────
          // Text deltas pipe directly to the frontend. If the model
          // triggers tool use we detect it here and drop into the
          // non-streaming create() loop below.
          const initialStream = anthropic.messages.stream({
            model: "claude-sonnet-4-6",
            max_tokens: 10000,
            system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
            messages: apiMessages,
            tools,
          });

          let hasToolUse = false;
          let streamedText = "";

          for await (const event of initialStream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              streamedText += event.delta.text;
              controller.enqueue(
                new TextEncoder().encode(event.delta.text)
              );
            }
            if (
              event.type === "content_block_start" &&
              event.content_block.type === "tool_use"
            ) {
              hasToolUse = true;
            }
          }

          if (!hasToolUse) {
            // No tools — streamed text is the final response
            fullResponse = streamedText;
          } else {
            // ── Tool-use loop (non-streaming) ────────────────────
            controller.enqueue(
              new TextEncoder().encode(THINKING_DELIMITER)
            );

            const initialMessage = await initialStream.finalMessage();

            // Append the assistant turn (text + tool_use blocks)
            apiMessages.push({
              role: "assistant" as const,
              content:
                initialMessage.content as Anthropic.Messages.ContentBlockParam[],
            });

            // Execute the tool calls from the initial response
            const initialToolResults: Anthropic.Messages.ToolResultBlockParam[] =
              [];
            for (const block of initialMessage.content) {
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
            apiMessages.push({
              role: "user" as const,
              content: initialToolResults,
            });

            // Subsequent iterations use create() — no streaming
            for (let i = 1; i < MAX_TOOL_ITERATIONS; i++) {
              const response = await anthropic.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 10000,
                system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
                messages: apiMessages,
                tools,
              });

              const hasMoreTools = response.content.some(
                (b) => b.type === "tool_use"
              );

              if (!hasMoreTools) {
                // Final response — extract text, send to client, log it
                controller.enqueue(
                  new TextEncoder().encode(FINAL_DELIMITER)
                );
                for (const block of response.content) {
                  if (block.type === "text") {
                    fullResponse += block.text;
                    controller.enqueue(
                      new TextEncoder().encode(block.text)
                    );
                  }
                }
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
              apiMessages.push({
                role: "user" as const,
                content: loopToolResults,
              });
            }

            // Safety net: if loop exhausted without a final text
            // response, the AI never responded to the last tool
            // results. One more call to get the answer.
            if (fullResponse === "") {
              controller.enqueue(
                new TextEncoder().encode(FINAL_DELIMITER)
              );
              const finalResponse = await anthropic.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 10000,
                system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
                messages: apiMessages,
                tools,
              });
              for (const block of finalResponse.content) {
                if (block.type === "text") {
                  fullResponse += block.text;
                  controller.enqueue(
                    new TextEncoder().encode(block.text)
                  );
                }
              }
            }
          }

          controller.close();

          // Persist only the user message and final assistant text
          try {
            await supabase.from("messages").insert([
              {
                athlete_id: ATHLETE_ID,
                date: localDate,
                tab,
                role: "user",
                content: message,
                timestamp: new Date().toISOString(),
              },
              {
                athlete_id: ATHLETE_ID,
                date: localDate,
                tab,
                role: "assistant",
                content: fullResponse,
                timestamp: new Date().toISOString(),
              },
            ]);
          } catch (saveError) {
            console.error("[chat] failed to save messages:", saveError);
          }
        } catch (streamErr) {
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
