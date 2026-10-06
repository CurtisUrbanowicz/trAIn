import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { waitUntil } from "@vercel/functions";
import { buildContext, type TabType } from "@/lib/context";
import { supabase } from "@/lib/supabase";
import { getToolsForTab } from "@/lib/tools";
import { executeTool, type ToolContext } from "@/lib/tool-executor";
import { pushLog, pushLogAsync } from "@/lib/debugLog";
import { countTextTokens } from "@/lib/token-count";
import { describeToolCall } from "@/lib/tool-status";
import { claimOpener, releaseOpener, type OpenerClaim } from "@/lib/openerClaim";
import {
  insertTurnRecord,
  type TurnToolCall,
  type TurnUsageRound,
} from "@/lib/turnRecords";
import {
  CHAT_PRIMARY,
  CHAT_FALLBACK,
  ADAPTIVE_THINKING,
  CHAT_EFFORT,
} from "@/lib/models";
import {
  flagIncompleteStop,
  stopDetailsOf,
  thinkingTokensFromEvent,
} from "@/lib/model-response";
import {
  appendToolResultsWithCache,
  historyWithLastAssistantCached,
} from "@/lib/cache-helpers";

// Vercel Hobby (Fluid compute) cap
export const maxDuration = 300;

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOOL_ITERATIONS: Record<TabType, number> = {
  today: 5,
  week: 5,
  season: 10,
  coach: 10,
};

// Trailing text block on the last user turn before the safety-net call
// (same pattern as reflect's guard): tools are off, so answer now.
const SAFETY_NET_NUDGE = "No more lookups this turn. Reply with what you have.";
// Streamed, never persisted, when a turn ends with no reply text
// (refusal, empty safety net) so the athlete never sees a silent turn.
const EMPTY_TURN_FALLBACK = "Lost my thread there — send that again?";

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
  // Set for an opener once claimed; released if the turn never persists
  let claim: OpenerClaim | null = null;
  let releaseClaim: () => Promise<void> = async () => {};
  try {
    const body = (await request.json()) as {
      message?: string;
      localDate?: string;
      localTime?: string;
      tab?: string;
      history?: Array<{ role: string; content: string }>;
      userMessageId?: string;
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

    // Every message has an id from the start: the athlete's comes from the
    // phone (so its bubble and the row are one message), the reply's is
    // minted here and sent as the first frame.
    const userMessageId =
      typeof body.userMessageId === "string" && UUID_RE.test(body.userMessageId)
        ? body.userMessageId
        : randomUUID();
    const assistantId = randomUUID();

    const rawHistory = Array.isArray(body.history) ? body.history : [];
    const history = rawHistory
      .filter(
        (h): h is { role: "user" | "assistant"; content: string } =>
          (h.role === "user" || h.role === "assistant") &&
          typeof h.content === "string" &&
          // An empty entry (a turn that produced no text) would become an
          // empty cached text block, which the API rejects
          h.content.trim() !== ""
      )
      .map((h) => ({ role: h.role, content: h.content }));

    // The opener (empty message) runs once per athlete, date and tab. A
    // remount or reload mid-opener hydrates nothing and asks again: it is
    // told "held" and waits for the saved reply via realtime. A claim
    // older than this route's 5-minute limit is reclaimed. On a claim
    // error the turn runs anyway — an opener is better than none.
    if (message.trim() === "") {
      claim = await claimOpener(ATHLETE_ID, localDate, tab);
      pushLog("opener_claim", { tab, date: localDate, outcome: claim.outcome });
      if (claim.outcome === "held") {
        return new Response(JSON.stringify({ t: "held" }) + "\n", {
          headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
        });
      }
      const token = claim.token;
      if (token) {
        releaseClaim = () => releaseOpener(ATHLETE_ID, localDate, tab, token);
      }
    }

    const contextStart = Date.now();
    const { systemPrompt, volatileBlock, trainingStateBlock, patternsBlock } =
      await buildContext(ATHLETE_ID, tab, localDate, localTime);
    const contextMs = Date.now() - contextStart;

    const anthropic = new Anthropic();

    // context_loaded carries character lengths and real token sizes per
    // tab. The counts come from the count-tokens API (free, ~300ms each),
    // so they run off the request path and the entry is written once they
    // are in; a failed count logs as null, never delays the turn.
    waitUntil(
      (async () => {
        const [
          systemPromptTokens,
          contextBlockTokens,
          trainingStateTokens,
          patternsTokens,
        ] = await Promise.all([
          countTextTokens(anthropic, systemPrompt),
          countTextTokens(anthropic, volatileBlock),
          countTextTokens(anthropic, trainingStateBlock),
          countTextTokens(anthropic, patternsBlock),
        ]);
        await pushLogAsync("context_loaded", {
          tab,
          contextBlockLength: volatileBlock.length,
          trainingStateLength: trainingStateBlock.length,
          patternsLength: patternsBlock.length,
          systemPromptLength: systemPrompt.length,
          contextBlockTokens,
          trainingStateTokens,
          patternsTokens,
          systemPromptTokens,
        });
      })()
    );

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
        const { error: userInsertError } = await supabase.from("messages").insert({
          id: userMessageId,
          athlete_id: ATHLETE_ID,
          date: localDate,
          tab,
          role: "user",
          content: message,
          timestamp: new Date().toISOString(),
        });
        if (userInsertError) {
          console.error("[chat] failed to save user message:", userInsertError.message);
          pushLog("error", {
            message: "chat: user message insert failed",
            code: userInsertError.code,
            detail: userInsertError.message,
          });
        }
      } catch (err) {
        console.error("[chat] failed to save user message:", err);
      }
    }

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

    // Adaptive thinking on every call; reasoning belongs in thinking, never
    // in text — all text is the reply and is persisted. Effort is fixed for
    // the whole request (changing it between calls breaks the prompt cache).
    const effort = CHAT_EFFORT[tab];

    // ── Stream plumbing ──────────────────────────────────────────────
    // The turn runs under waitUntil, independent of the connection. The
    // response is a window onto it: frames are best-effort, and the first
    // failed enqueue (or a cancel/abort) marks the client gone. The turn
    // keeps going and persists its reply — closing the app never cancels a
    // turn, by design; the saved row reaches the client via realtime.
    //
    // NDJSON protocol: one JSON object per line.
    //   {"t":"start","id":"…"}  first frame: the reply's message id
    //   {"t":"text","v":"…"}    model reply text, every round, as it streams
    //   {"t":"status","v":"…"}  code-generated line per tool call
    //   {"t":"done"}            end of turn
    //   {"t":"error"}           the turn failed while the client was connected
    type Frame =
      | { t: "start"; id: string }
      | { t: "text" | "status"; v: string }
      | { t: "done" }
      | { t: "error" };
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let clientGone = false;
    let clientLeftMs: number | null = null;
    // first_token_ms = first content frame (text or status) enqueued
    let firstTokenMs: number | null = null;
    const markClientGone = () => {
      if (clientGone) return;
      clientGone = true;
      clientLeftMs = Date.now() - t0;
    };
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      // Next cancels the readable when the socket closes
      cancel() {
        markClientGone();
      },
    });
    try {
      request.signal.addEventListener("abort", markClientGone);
    } catch {
      // no abort signal in this runtime
    }
    const send = (frame: Frame) => {
      if (clientGone || !controller) return;
      if (firstTokenMs === null && (frame.t === "text" || frame.t === "status")) {
        firstTokenMs = Date.now() - t0;
      }
      try {
        controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
      } catch {
        markClientGone();
      }
    };
    const closeStream = () => {
      if (clientGone || !controller) return;
      try {
        controller.close();
      } catch {
        markClientGone();
      }
    };

    send({ t: "start", id: assistantId });

    const runTurn = async (): Promise<void> => {
      // Request timing — one "timing" entry pushed at the end.
      const rounds: Array<{
        round: number;
        api_ms: number;
        tools_ms: number;
        tools: number;
        text_chars: number;
        thinking_tokens: number | null;
        // Cut off by max_tokens mid-tool-use; tools not executed
        truncated?: boolean;
        text?: string;
      }> = [];

      // Turn record (turn_records): assembled from what's already in
      // memory and inserted after the stream closes. No thinking text.
      const turnToolCalls: TurnToolCall[] = [];
      const usageRounds: TurnUsageRound[] = [];
      const recordUsage = (
        usage: Anthropic.Messages.Usage,
        thinkingTokens: number | null
      ) => {
        usageRounds.push({
          round: usageRounds.length + 1,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          thinking_tokens: thinkingTokens,
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
        const sum = (
          k: "input_tokens" | "output_tokens" | "thinking_tokens" | "cache_read" | "cache_write"
        ) => usageRounds.reduce((acc, r) => acc + (r[k] ?? 0), 0);
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
              client_connected: !clientGone,
              client_left_ms: clientLeftMs,
              ...(error ? { error } : {}),
            },
            usage: {
              input_tokens: sum("input_tokens"),
              output_tokens: sum("output_tokens"),
              thinking_tokens: sum("thinking_tokens"),
              cache_read: sum("cache_read"),
              cache_write: sum("cache_write"),
              rounds: usageRounds,
            },
          })
        );
      };

      // Every round's text is the reply and is persisted. Each round's
      // text is trimmed and non-empty rounds are joined with "\n\n" —
      // the text frames are emitted so the client's concatenation is
      // exactly that join, i.e. the bubble equals the persisted row.
      const roundTexts: string[] = [];
      // Ref object: assigned inside runRound's closure, read after it
      const lastResponse: { current: Anthropic.Messages.Message | null } = {
        current: null,
      };

      // One streaming call. Used for every round: tool rounds and the
      // safety net (toolChoiceNone) alike.
      const runRound = async (
        toolChoiceNone: boolean
      ): Promise<{
        response: Anthropic.Messages.Message;
        text: string;
        apiMs: number;
        thinkingTokens: number | null;
      }> => {
        const apiStart = Date.now();
        let text = "";
        let thinkingTokens: number | null = null;
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
          thinkingTokens = null;
          // tool_use input arrives as JSON deltas; assembled per block so
          // the status line can read it when the block closes.
          const toolInputs = new Map<number, { name: string; json: string }>();

          const stream = anthropic.messages.stream({
            model,
            max_tokens: 10000,
            thinking: ADAPTIVE_THINKING,
            output_config: { effort },
            system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } }],
            messages: apiMessages,
            tools: toolsForRequest,
            ...(toolChoiceNone ? { tool_choice: { type: "none" as const } } : {}),
          });

          for await (const event of stream) {
            // The accumulator drops output_tokens_details; read it raw
            const tt = thinkingTokensFromEvent(event);
            if (tt !== null) thinkingTokens = tt;
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

        lastResponse.current = response;
        flagIncompleteStop("chat", response, { tab, round: usageRounds.length + 1 });
        recordUsage(response.usage, thinkingTokens);
        if (text) roundTexts.push(text);
        return { response, text, apiMs: Date.now() - apiStart, thinkingTokens };
      };

      try {
        // answered: the last round ended without tool calls and wrote text
        let answered = false;

        for (let round = 1; round <= MAX_TOOL_ITERATIONS[tab]; round++) {
          const { response, text, apiMs, thinkingTokens } = await runRound(false);

          if (round === 1) {
            pushLog("cache_usage", {
              input_tokens: response.usage.input_tokens,
              // output_tokens includes thinking_tokens
              output_tokens: response.usage.output_tokens,
              thinking_tokens: thinkingTokens,
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
              thinking_tokens: thinkingTokens,
              ...(text ? { text } : {}),
            });
            answered = text !== "";
            break;
          }

          // Cut off by the token cap mid-tool-use: the inputs may be
          // incomplete, so neither execute them nor replay the turn.
          // Straight to the safety net.
          if (response.stop_reason === "max_tokens") {
            rounds.push({
              round,
              api_ms: apiMs,
              tools_ms: 0,
              tools: 0,
              text_chars: text.length,
              thinking_tokens: thinkingTokens,
              truncated: true,
              ...(text ? { text } : {}),
            });
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
            thinking_tokens: thinkingTokens,
            ...(text ? { text } : {}),
          });
          appendToolResultsWithCache(apiMessages, toolResults);
        }

        // Safety net: the loop hit its cap with tool results unanswered,
        // or the last round ended with no text. One more call, tools
        // disabled, to get the reply.
        if (!answered) {
          // Nudge as a trailing text block on the last user turn (tool_result
          // blocks must lead a user message; trailing text is valid), or a
          // new user turn when the last turn is plain text.
          const last = apiMessages[apiMessages.length - 1];
          if (last?.role === "user" && Array.isArray(last.content)) {
            (last.content as Anthropic.Messages.ContentBlockParam[]).push({
              type: "text",
              text: SAFETY_NET_NUDGE,
            });
          } else {
            apiMessages.push({ role: "user", content: SAFETY_NET_NUDGE });
          }
          const { text, apiMs, thinkingTokens } = await runRound(true);
          rounds.push({
            round: rounds.length + 1,
            api_ms: apiMs,
            tools_ms: 0,
            tools: 0,
            text_chars: text.length,
            thinking_tokens: thinkingTokens,
            ...(text ? { text } : {}),
          });
        }

        const fullResponse = roundTexts.join("\n\n");

        // Never a silent turn: streamed only, not persisted, not part of
        // fullResponse, so the next request's history still carries text.
        if (fullResponse === "") {
          send({ t: "text", v: EMPTY_TURN_FALLBACK });
          pushLog("error", {
            message: "chat: turn ended with no reply text",
            tab,
            stop_reason: lastResponse.current?.stop_reason ?? null,
            stop_details: stopDetailsOf(lastResponse.current),
            rounds: rounds.length,
          });
        }

        // Persist the full reply under the id the start frame announced
        // (user message already saved above). Realtime delivers this row
        // to the client — the canonical copy, also when the stream died.
        let persisted = false;
        if (fullResponse !== "") {
          try {
            const { error: replyInsertError } = await supabase.from("messages").insert({
              id: assistantId,
              athlete_id: ATHLETE_ID,
              date: localDate,
              tab,
              role: "assistant",
              content: fullResponse,
              timestamp: new Date().toISOString(),
            });
            if (replyInsertError) {
              console.error("[chat] failed to save assistant message:", replyInsertError.message);
              pushLog("error", {
                message: "chat: assistant message insert failed",
                code: replyInsertError.code,
                detail: replyInsertError.message,
              });
            } else {
              persisted = true;
            }
          } catch (saveError) {
            console.error("[chat] failed to save assistant message:", saveError);
          }
        }
        // Nothing saved: a reopen would find no messages and ask for the
        // opener again, so let it run
        if (!persisted) await releaseClaim();

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
            thinking_tokens: r.thinking_tokens,
            ...(r.truncated ? { truncated: true } : {}),
          })),
          total_ms: Date.now() - t0,
          client_connected: !clientGone,
          client_left_ms: clientLeftMs,
        });

        send({ t: "done" });
        closeStream();
        saveTurnRecord(fullResponse || null);
      } catch (streamErr) {
        const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        pushLog("error", { message: errMsg, total_ms: Date.now() - t0 });
        saveTurnRecord(null, errMsg);
        await releaseClaim();
        console.error("[chat] turn failed:", streamErr);
        // Still connected: tell the client now. Otherwise it finds out
        // through its 5-minute timeout.
        send({ t: "error" });
        closeStream();
      }
    };

    // Completes within maxDuration even if the client has gone
    waitUntil(runTurn());

    return new Response(readable, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    });
  } catch (error) {
    // Failed before the turn started (context build, bad body)
    await releaseClaim();
    const message =
      error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
