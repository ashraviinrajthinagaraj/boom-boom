-- Test-only: imitates a fresh Supabase project on a local PostgreSQL.
-- NEVER run this against your real Supabase project.
-- Minimal imitation of a fresh Supabase project, enough to test schema.sql
do $$ begin
  -- roles are shared across a whole PostgreSQL server, so only create them once
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;

grant usage on schema public to anon, authenticated;
-- Supabase grants everything in public to these roles by default; mimic it so
-- the schema's explicit revokes are actually exercised.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create publication supabase_realtime;
