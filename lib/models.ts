import type Anthropic from "@anthropic-ai/sdk";
import type { TabType } from "./context";

// Single source of truth for Anthropic model ids and model settings used by
// the API routes. Never hardcode a model id anywhere else.
export const CHAT_PRIMARY = "claude-opus-5-5";
export const CHAT_FALLBACK = "claude-sonnet-4-6";
export const REFLECT = "claude-opus-5-5";
export const SUMMARISE = "claude-opus-5-5";

// Thinking is adaptive on every call: the model decides per turn whether to
// think. Opus 5.5 rejects "enabled"/budget_tokens. Summaries are returned so
// thinking blocks carry readable text in turn records and logs; they are
// never streamed to the athlete or persisted to messages.
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
