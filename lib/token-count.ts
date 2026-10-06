import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { CHAT_PRIMARY } from "./models";

/**
 * Real token size of a block of text, as the model would see it in a user
 * message, from the count-tokens API (free, roughly 300ms). Used for debug
 * instrumentation only, off the request path. Never throws: null on failure.
 */
export async function countTextTokens(
  anthropic: Anthropic,
  text: string
): Promise<number | null> {
  if (text.trim() === "") return 0;
  try {
    const result = await anthropic.messages.countTokens({
      model: CHAT_PRIMARY,
      messages: [{ role: "user", content: text }],
    });
    return result.input_tokens;
  } catch (err) {
    console.error(
      "[tokens] countTokens failed:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
