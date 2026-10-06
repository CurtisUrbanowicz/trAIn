-- athlete_patterns: the weekly-maintained, evidence-backed long-term
-- behavioural picture of the athlete — three to five verified patterns plus
-- a training arc, written by the patterns reflection pass
-- (prompts/reflection/patterns.md) through the write_patterns tool.
-- Append-only: the newest row is the current document and older rows are
-- the version history (/debug). through_date is the latest daily summary
-- the pass verified against; the morning chain re-runs the pass once seven
-- or more summaries post-date it. Separate from athlete_profile, which stays
-- chat-owned (observe, surface, confirm, store). RLS off, like the other app
-- tables.
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-06 via MCP.
create table public.athlete_patterns (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.athletes(id),
  content text not null,
  through_date date not null,
  timestamp timestamptz not null default now()
);

create index athlete_patterns_athlete_timestamp_idx
  on public.athlete_patterns (athlete_id, timestamp desc);
