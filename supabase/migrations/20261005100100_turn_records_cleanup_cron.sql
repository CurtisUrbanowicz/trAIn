-- Daily cleanup: drop turn records older than 30 days (03:15 UTC).
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-05 via MCP.
create extension if not exists pg_cron;

select cron.schedule(
  'turn_records_cleanup',
  '15 3 * * *',
  $$delete from public.turn_records where created_at < now() - interval '30 days'$$
);
