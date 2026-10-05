-- One readiness row per athlete per date, whatever the source.
-- log_readiness merge-upserts on this constraint; the Whoop sync and
-- backfill insert-if-absent on it. Replaces the Whoop-only partial index.
--
-- Step 1 (one-off dedupe, previewed and confirmed 2026-10-05): keep the
-- newest row per date, ties broken by more non-null fields, with two
-- hand-picked exceptions:
--   2026-10-05: keep the Whoop row b6075bce… (the newer manual row was an
--               identical copy; keeping Whoop preserves the source label)
--   2026-06-14: keep the older row 3564b0b7… (the newer one lacked the
--               recovery score of 97)
-- 81 rows across 27 dates collapse to 27; no deleted row held a value its
-- kept row lacks.
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-05 via MCP.
with ranked as (
  select id,
    row_number() over (
      partition by athlete_id, date
      order by
        case when id in (
          'b6075bce-b7bb-4538-852d-c1bbb0b78230',
          '3564b0b7-acfe-4b40-9efb-96f5b23c355e'
        ) then 0 else 1 end,
        timestamp desc nulls last,
        ((hrv is not null)::int + (rhr is not null)::int
          + (recovery_score is not null)::int + (sleep_hours is not null)::int) desc
    ) as rn
  from public.readiness
)
delete from public.readiness r
using ranked
where r.id = ranked.id and ranked.rn > 1;

-- Step 2: the constraint
drop index if exists public.readiness_whoop_one_per_date;

alter table public.readiness
  add constraint readiness_athlete_date_unique unique (athlete_id, date);
