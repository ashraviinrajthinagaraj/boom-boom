-- Test-only: stands in for Supabase Cron (pg_cron). Records scheduled jobs.
-- NEVER run this against your real Supabase project.
create schema if not exists cron;
create table if not exists cron.job (jobname text primary key, schedule text, command text);
create table if not exists cron.job_run_details (runid bigint generated always as identity, end_time timestamptz);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $$
begin
  insert into cron.job values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command;
  return 1;
end $$;
