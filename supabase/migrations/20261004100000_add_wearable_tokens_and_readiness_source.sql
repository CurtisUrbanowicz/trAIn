-- Whoop integration: token storage, readiness provenance, athlete timezone.
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-04 via MCP.

create table public.wearable_tokens (
  athlete_id uuid not null,
  provider text not null,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scopes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (athlete_id, provider)
);

-- Deny-all RLS: no policies defined. The browser's anon key cannot read or
-- write tokens; server routes use the service-role client (lib/whoop.ts).
alter table public.wearable_tokens enable row level security;

-- null = manually logged; 'whoop' = synced from Whoop
alter table public.readiness add column if not exists source text;

-- Fallback timezone for wake-date derivation when Whoop's own
-- timezone_offset is unavailable
alter table public.athletes add column if not exists timezone text not null default 'Europe/London';
