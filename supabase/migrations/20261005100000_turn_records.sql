-- Full record of each chat turn, for /debug/turns. Assembled in memory by
-- /api/chat and inserted after the stream closes (waitUntil), so it adds no
-- latency. Thinking text is deliberately not stored.
-- RLS on with no policies (like wearable_tokens): the record holds the full
-- context block, so only the service-role client reads or writes it.
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-05 via MCP.
create table public.turn_records (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null,
  tab text not null,
  date date not null,
  created_at timestamptz not null default now(),
  user_message text,
  context_block text,
  tool_calls jsonb,
  final_message text,
  model text,
  timing jsonb,
  usage jsonb
);

create index turn_records_created_at_idx on public.turn_records (created_at desc);

alter table public.turn_records enable row level security;
