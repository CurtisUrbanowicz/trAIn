-- Single round-trip replacement for the 13 per-request queries in
-- getContextIndexCounts (lib/context.ts). Shape mirrors ContextIndexCounts.
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-04 via MCP.
create or replace function public.get_context_index(p_athlete_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'summaries', (
      select jsonb_build_object(
        'count', count(*),
        'earliest', to_char(min(date), 'YYYY-MM-DD'),
        'latest', to_char(max(date), 'YYYY-MM-DD')
      ) from daily_summaries where athlete_id = p_athlete_id
    ),
    'runs', (
      select jsonb_build_object(
        'count', count(*),
        'earliest', to_char(min(date), 'YYYY-MM-DD'),
        'latest', to_char(max(date), 'YYYY-MM-DD')
      ) from runs where athlete_id = p_athlete_id
    ),
    'sets', (
      select jsonb_build_object(
        'count', count(*),
        'earliest', to_char(min(date), 'YYYY-MM-DD'),
        'latest', to_char(max(date), 'YYYY-MM-DD')
      ) from sets where athlete_id = p_athlete_id
    ),
    'mesocycles', (
      select jsonb_build_object('count', count(*))
      from mesocycles where athlete_id = p_athlete_id
    ),
    'weeklyPlans', (
      select jsonb_build_object('count', count(*))
      from weekly_plans where athlete_id = p_athlete_id
    ),
    'exercises', (
      select coalesce(jsonb_agg(e order by e), '[]'::jsonb)
      from (
        select distinct exercise as e
        from sets
        where athlete_id = p_athlete_id
          and exercise is not null and exercise <> ''
      ) s
    ),
    'runTypes', (
      select coalesce(jsonb_agg(rt order by rt), '[]'::jsonb)
      from (
        select distinct run_type as rt
        from runs
        where athlete_id = p_athlete_id
          and run_type is not null and run_type <> ''
      ) r
    )
  );
$$;
