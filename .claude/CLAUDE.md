## General usage 
- Always confirm approach before writing any code

## Agent usage
- Use Explore agents for any codebase research spanning more than 3 files.
- Launch independent agents in parallel whenever possible.

## Known issues
- `npm run build` intermittently fails with `EINVAL: invalid argument, readlink '.next\...'` (OneDrive sync interference) — fix: delete `.next` and rebuild. Not a code error.
- Anthropic model ids live ONLY in `lib/models.ts` — never hardcode them in routes.
