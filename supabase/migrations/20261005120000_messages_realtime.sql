-- Chat replies are delivered by Supabase realtime as well as by the
-- response stream: a turn now finishes and saves its reply whether or not
-- the app is still open, and the client upserts the saved row by id.
-- RLS on messages is unchanged (off, like the other app tables).
-- Applied to project fyivrsmbvdvcjxissifw on 2026-10-05 via MCP.
alter publication supabase_realtime add table public.messages;
