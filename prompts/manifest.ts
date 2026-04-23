import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TabType } from "@/lib/context";
import type { ReflectionType } from "@/lib/reflection-context";

export type PromptPath = string;

export const promptPaths = {
  chat: {
    base: "prompts/chat/base.md",
    tabs: {
      coach: "prompts/chat/tabs/coach.md",
      today: "prompts/chat/tabs/today.md",
      week: "prompts/chat/tabs/week.md",
      season: "prompts/chat/tabs/season.md",
    } satisfies Record<TabType, PromptPath>,
  },
  reflection: {
    pulse: "prompts/reflection/pulse.md",
    deep: "prompts/reflection/deep.md",
  } satisfies Record<ReflectionType, PromptPath>,
  summarise: {
    base: "prompts/summarise/base.md",
  },
} as const;

const cache = new Map<PromptPath, string>();

export async function readPrompt(relPath: PromptPath): Promise<string> {
  const hit = cache.get(relPath);
  if (hit !== undefined) return hit;
  const abs = path.join(process.cwd(), relPath);
  const value = await fs.readFile(abs, "utf8");
  cache.set(relPath, value);
  return value;
}

export async function loadChatSystemPrompt(tab: TabType): Promise<string> {
  const [base, tabInstr] = await Promise.all([
    readPrompt(promptPaths.chat.base),
    readPrompt(promptPaths.chat.tabs[tab]),
  ]);
  return `${base}\n${tabInstr}`;
}

export async function loadReflectionSystemPrompt(
  type: ReflectionType
): Promise<string> {
  return readPrompt(promptPaths.reflection[type]);
}

export async function loadSummariserSystemPrompt(): Promise<string> {
  return readPrompt(promptPaths.summarise.base);
}
