import "server-only";
import type Anthropic from "@anthropic-ai/sdk";

const EPHEMERAL_1H: Anthropic.CacheControlEphemeral = {
  type: "ephemeral",
  ttl: "1h",
};

export function historyWithLastAssistantCached(
  history: Array<{ role: "user" | "assistant"; content: string }>
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = history.map((h) => ({
    role: h.role,
    content: h.content,
  }));
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i]!;
    if (msg.role === "assistant") {
      const text = typeof msg.content === "string" ? msg.content : "";
      out[i] = {
        role: "assistant",
        content: [{ type: "text", text, cache_control: EPHEMERAL_1H }],
      };
      break;
    }
  }
  return out;
}

export function appendToolResultsWithCache(
  apiMessages: Anthropic.MessageParam[],
  toolResults: Anthropic.Messages.ToolResultBlockParam[]
): void {
  if (toolResults.length === 0) return;

  for (const msg of apiMessages) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        const mutable = block as Anthropic.Messages.ToolResultBlockParam & {
          cache_control?: Anthropic.CacheControlEphemeral;
        };
        if (mutable.cache_control) delete mutable.cache_control;
      }
    }
  }

  const last = toolResults[toolResults.length - 1]!;
  (
    last as Anthropic.Messages.ToolResultBlockParam & {
      cache_control?: Anthropic.CacheControlEphemeral;
    }
  ).cache_control = EPHEMERAL_1H;

  apiMessages.push({ role: "user", content: toolResults });
}
