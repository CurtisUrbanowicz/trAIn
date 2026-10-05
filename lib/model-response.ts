import type Anthropic from "@anthropic-ai/sdk";
import { pushLog } from "./debugLog";

/**
 * Thinking tokens for one response, from usage.output_tokens_details.
 * SDK 0.80.0 doesn't type the field, and its stream accumulator drops it —
 * streaming callers pass the raw message_delta usage instead. Null when the
 * model didn't report it (e.g. the Sonnet 4.6 fallback). Treat > 0 as
 * "thought"; thinking-block presence is not the signal.
 */
export function thinkingTokensOf(usage: unknown): number | null {
  const n = (usage as {
    output_tokens_details?: { thinking_tokens?: unknown } | null;
  } | null)?.output_tokens_details?.thinking_tokens;
  return typeof n === "number" ? n : null;
}

/** For a streaming for-await loop: thinking tokens from a message_delta event. */
export function thinkingTokensFromEvent(
  event: Anthropic.Messages.RawMessageStreamEvent
): number | null {
  if (event.type !== "message_delta") return null;
  return thinkingTokensOf(event.usage);
}

/**
 * Logs a response that stopped on the token cap or a refusal. Returns true
 * when the response is incomplete and its text must not be trusted as a
 * full result.
 */
export function flagIncompleteStop(
  source: string,
  message: Anthropic.Messages.Message,
  extra: Record<string, unknown> = {}
): boolean {
  const reason = message.stop_reason;
  if (reason !== "max_tokens" && reason !== "refusal") return false;
  // stop_details is populated only on refusal; SDK 0.80.0 doesn't type it
  const stopDetails =
    (message as { stop_details?: unknown }).stop_details ?? null;
  pushLog("error", {
    message: `${source}: stop_reason ${reason}`,
    source,
    stop_reason: reason,
    stop_details: stopDetails,
    model: message.model,
    output_tokens: message.usage.output_tokens,
    ...extra,
  });
  return true;
}
