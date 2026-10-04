-- One whoop-sourced readiness row per athlete per date. Makes the
-- backfill/sync check-then-insert race impossible at the DB level
-- (two concurrent backfill runs double-inserted 15 dates on 2026-10-04).
-- Manual rows (source is null) are unaffected — multiple per date allowed.
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-04 via MCP.
create unique index readiness_whoop_one_per_date
  on public.readiness (athlete_id, date)
  where source = 'whoop';
