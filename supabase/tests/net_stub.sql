-- Test-only: stands in for Supabase's pg_net extension and records calls.
-- NEVER run this against your real Supabase project.
create schema if not exists net;
create table if not exists net.calls (url text, body jsonb, headers jsonb, at timestamptz default now());
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
returns bigint language plpgsql as $$
begin
  insert into net.calls (url, body, headers) values (url, body, headers);
  return 1;
end $$;
-- push.sql creates the real extension; locally there's nothing to install.
create schema if not exists extensions;
