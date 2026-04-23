# Prompts

System prompts loaded by the chat and reflect API routes.

## Layout

- `chat/base.md` — shared coaching voice, prepended to every chat request.
- `chat/tabs/{coach,today,week,season}.md` — per-tab overlay concatenated after `base.md`.
- `reflection/{pulse,deep}.md` — standalone system prompts for each reflection pass.

## Loading

All files are loaded through `manifest.ts`:

- `promptPaths` — typed registry. Adding a tab to `TabType` without a corresponding entry here fails the build (via `satisfies Record<TabType, …>`).
- `loadChatSystemPrompt(tab)` — returns `base.md + tabs/{tab}.md`.
- `loadReflectionSystemPrompt(type)` — returns `reflection/{type}.md`.
- `readPrompt(path)` — cached reader. Each file is read once per process lifetime.

## Adding a new prompt

1. Add the `.md` file under the right subdirectory.
2. Register it in `promptPaths` in `manifest.ts`.
3. Update the relevant `TabType` / `ReflectionType` union if it's a new slot.
4. If it's a new kind of prompt entirely, add a loader function mirroring the two existing ones.
