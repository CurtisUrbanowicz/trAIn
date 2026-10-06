-- training_state: a computed intermediate layer between the raw tables and
-- the brain. Every tab's context carries a <training_state> block built from
-- this one call (lib/context.ts getTrainingState), so "recent" means weeks,
-- not the last three daily summaries. No model call, no new table.
--
-- p_today is the client's local date — the app's clock everywhere else; the
-- database clock is UTC and disagrees with the phone around midnight. Every
-- row is bounded by p_today, so a run for a past date sees nothing later.
--
--   runs           per run_type: last 3 (date, distance_km, avg_pace, avg_hr),
--                  6-month longest (max distance) and fastest (min avg_pace,
--                  "M:SS" parsed to seconds)
--   lifts          per exercise with >= 3 distinct session dates in the last
--                  56 days: last 3 top sets (heaviest set of the session,
--                  ties by reps) and the all-time heaviest top set
--   lifts_last_seen exercises seen in the last 84 days but under the
--                  threshold: last-seen date only, 10 most recent
--   weeks          last 6 Monday-start weeks: km, sessions (distinct dates
--                  across runs + sets), partial flag on the current week
--   readiness_28d  medians over the 28 calendar days ending today
--   last_run, last_lift
--
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-06 via MCP.
-- Revisions the same day: last-seen cap 8 -> 10; rows bounded by p_today.
create or replace function public.get_training_state(
  p_athlete_id uuid,
  p_today date default current_date
)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
with
  run_rows as (
    select date, run_type, distance_km, avg_pace, avg_hr, timestamp,
      case
        when avg_pace ~ '^[0-9]{1,2}:[0-9]{2}$'
        then split_part(avg_pace, ':', 1)::int * 60 + split_part(avg_pace, ':', 2)::int
      end as pace_s
    from runs
    where athlete_id = p_athlete_id
      and date <= p_today
      and run_type is not null and run_type <> ''
  ),
  run_last3 as (
    select run_type,
      jsonb_agg(
        jsonb_build_object(
          'date', to_char(date, 'YYYY-MM-DD'),
          'distance_km', distance_km,
          'avg_pace', avg_pace,
          'avg_hr', avg_hr
        ) order by date desc, timestamp desc
      ) as last3
    from (
      select *,
        row_number() over (partition by run_type order by date desc, timestamp desc) as rn
      from run_rows
    ) r
    where rn <= 3
    group by run_type
  ),
  run_6mo as (
    select run_type,
      (array_agg(
        jsonb_build_object('date', to_char(date, 'YYYY-MM-DD'), 'distance_km', distance_km)
        order by distance_km desc, date desc
      ) filter (where distance_km is not null))[1] as longest,
      (array_agg(
        jsonb_build_object('date', to_char(date, 'YYYY-MM-DD'), 'avg_pace', avg_pace)
        order by pace_s asc, date desc
      ) filter (where pace_s is not null))[1] as fastest
    from run_rows
    where date > p_today - interval '6 months'
    group by run_type
  ),
  runs_json as (
    select coalesce(
      jsonb_object_agg(
        l.run_type,
        jsonb_build_object('last3', l.last3, 'longest', m.longest, 'fastest', m.fastest)
      ),
      '{}'::jsonb
    ) as v
    from run_last3 l
    left join run_6mo m using (run_type)
  ),

  set_rows as (
    select date, exercise, weight_kg, reps, rir, timestamp
    from sets
    where athlete_id = p_athlete_id
      and date <= p_today
      and exercise is not null and exercise <> ''
  ),
  top_sets as (
    -- one row per exercise per session: heaviest set, ties broken by reps
    select distinct on (exercise, date) exercise, date, weight_kg, reps, rir
    from set_rows
    order by exercise, date, weight_kg desc nulls last, reps desc nulls last
  ),
  ex_stats as (
    select exercise,
      count(distinct date) filter (where date > p_today - 56) as sessions_56d,
      max(date) as last_seen
    from set_rows
    group by exercise
  ),
  lifts_tracked as (
    select e.exercise,
      (
        select jsonb_agg(
          jsonb_build_object(
            'date', to_char(t.date, 'YYYY-MM-DD'),
            'weight_kg', t.weight_kg,
            'reps', t.reps,
            'rir', t.rir
          ) order by t.date desc
        )
        from (
          select * from top_sets t
          where t.exercise = e.exercise
          order by t.date desc
          limit 3
        ) t
      ) as last3,
      (
        select jsonb_build_object(
          'date', to_char(t.date, 'YYYY-MM-DD'),
          'weight_kg', t.weight_kg,
          'reps', t.reps
        )
        from top_sets t
        where t.exercise = e.exercise and t.weight_kg is not null
        order by t.weight_kg desc, t.reps desc nulls last, t.date desc
        limit 1
      ) as best
    from ex_stats e
    where e.sessions_56d >= 3
  ),
  lifts_json as (
    select coalesce(
      jsonb_object_agg(exercise, jsonb_build_object('last3', last3, 'best', best)),
      '{}'::jsonb
    ) as v
    from lifts_tracked
  ),
  last_seen_json as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object('exercise', exercise, 'date', to_char(last_seen, 'YYYY-MM-DD'))
        order by last_seen desc, exercise
      ),
      '[]'::jsonb
    ) as v
    from (
      select exercise, last_seen
      from ex_stats
      where sessions_56d < 3 and last_seen > p_today - 84
      order by last_seen desc, exercise
      limit 10
    ) q
  ),

  week_starts as (
    select (date_trunc('week', p_today)::date - 7 * g) as week_start
    from generate_series(0, 5) g
  ),
  weeks_json as (
    select jsonb_agg(
      jsonb_build_object(
        'week_start', to_char(ws.week_start, 'YYYY-MM-DD'),
        'km', coalesce((
          select round(sum(distance_km), 1) from runs r
          where r.athlete_id = p_athlete_id
            and r.date >= ws.week_start and r.date < ws.week_start + 7
            and r.date <= p_today
        ), 0),
        'sessions', (
          select count(*) from (
            select date from runs r
            where r.athlete_id = p_athlete_id
              and r.date >= ws.week_start and r.date < ws.week_start + 7
              and r.date <= p_today
            union
            select date from sets s
            where s.athlete_id = p_athlete_id
              and s.date >= ws.week_start and s.date < ws.week_start + 7
              and s.date <= p_today
          ) u
        ),
        'partial', ws.week_start + 7 > p_today
      ) order by ws.week_start desc
    ) as v
    from week_starts ws
  ),

  readiness_json as (
    select jsonb_build_object(
      'hrv', round((percentile_cont(0.5) within group (order by hrv))::numeric),
      'rhr', round((percentile_cont(0.5) within group (order by rhr))::numeric),
      'sleep_hours', round((percentile_cont(0.5) within group (order by sleep_hours))::numeric, 1),
      'days', count(*)
    ) as v
    from readiness
    where athlete_id = p_athlete_id
      and date > p_today - 28 and date <= p_today
  )

select jsonb_build_object(
  'today', to_char(p_today, 'YYYY-MM-DD'),
  'runs', (select v from runs_json),
  'lifts', (select v from lifts_json),
  'lifts_last_seen', (select v from last_seen_json),
  'weeks', (select v from weeks_json),
  'readiness_28d', (select v from readiness_json),
  'last_run', (select to_char(max(date), 'YYYY-MM-DD') from runs where athlete_id = p_athlete_id and date <= p_today),
  'last_lift', (select to_char(max(date), 'YYYY-MM-DD') from sets where athlete_id = p_athlete_id and date <= p_today)
);
$$;
