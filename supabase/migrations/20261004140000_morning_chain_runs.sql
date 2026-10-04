-- Morning chain run claims: one row per athlete per wake date.
-- The Whoop webhook can deliver several recovery.updated events for one
-- recovery (re-scores, retries) and deliveries can overlap. The claim makes
-- the expensive steps (summarise, pulse, deep) run once per wake date; the
-- unique indexes on readiness, daily_summaries and insights remain the
-- DB-level backstop. claim_token is rotated on reclaim so two reclaimers of a
-- stale/failed run cannot both win.
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-04 via MCP.
create table public.morning_chain_runs (
  athlete_id uuid not null,
  wake_date date not null,
  status text not null check (status in ('running', 'done', 'error')),
  claim_token uuid not null default gen_random_uuid(),
  trace_id text,
  steps jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (athlete_id, wake_date)
);
