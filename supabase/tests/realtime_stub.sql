-- Test-only: stands in for Supabase Realtime's authorization table.
-- NEVER run this against your real Supabase project.
create schema if not exists realtime;
create table if not exists realtime.messages (
  id bigint generated always as identity primary key,
  topic text not null,
  extension text not null,
  payload jsonb
);
create or replace function realtime.topic() returns text language sql stable as $$
  select current_setting('realtime.topic', true)
$$;
alter table realtime.messages enable row level security;
grant usage on schema realtime to anon, authenticated;
grant select, insert on realtime.messages to anon, authenticated;
