import type Anthropic from "@anthropic-ai/sdk";
import type { TabType } from "./context";

// Single source of truth for Anthropic model ids and model settings used by
// the API routes. Never hardcode a model id anywhere else.
export const CHAT_PRIMARY = "claude-opus-5-5";
export const CHAT_FALLBACK = "claude-sonnet-4-6";
export const REFLECT = "claude-opus-5-5";
export const SUMMARISE = "claude-opus-5-5";

// Thinking is adaptive on every call: the model decides per turn whether to
// think. Opus 5.5 rejects "enabled"/budget_tokens. display "summarized"
// exists for the Coach cards (reflect streams thinking deltas as the card's
// live text, since on Opus 5.5 the between-tool notes arrive as thinking)
// and the planned live-thinking view. Nothing stores thinking text: it is
// never persisted to messages or turn records, and chat never streams it.
export const ADAPTIVE_THINKING: Anthropic.ThinkingConfigAdaptive = {
  type: "adaptive",
  display: "summarized",
};

// Effort, sent as output_config.effort. Fixed per request path — changing
// it between calls in a request invalidates the prompt cache.
export type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;
export const CHAT_EFFORT: Record<TabType, Effort> = {
  today: "medium",
  week: "medium",
  season: "medium",
  coach: "medium",
};
export const REFLECT_EFFORT: Effort = "medium";
export const SUMMARISE_EFFORT: Effort = "medium";
