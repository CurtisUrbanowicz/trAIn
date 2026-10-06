-- Opener claims: one row per athlete, date and tab.
-- A tab's opener fires from the client when the day has no saved messages.
-- A remount or reload mid-opener (tab switch, refresh) hydrates nothing —
-- the reply isn't saved yet — and would start a second turn. The claim makes
-- the turn run once: a later request finds it held, returns {"t":"held"}
-- without a turn, and the client waits for the saved reply via realtime.
-- A claim older than 5 minutes (the chat route's maxDuration) is presumed
-- dead and may be reclaimed; claim_token rotates on reclaim so two
-- reclaimers cannot both win. The holder deletes its claim when the turn
-- fails or persists nothing, so the next open can retry. RLS off, like the
-- other app tables (and like morning_chain_runs, the same pattern).
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-06 via MCP.
create table public.opener_claims (
  athlete_id uuid not null,
  date date not null,
  tab text not null,
  claim_token uuid not null default gen_random_uuid(),
  started_at timestamptz not null default now(),
  primary key (athlete_id, date, tab)
);
