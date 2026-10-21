-- Checks for supabase/push.sql. Run with psql on a LOCAL test database only,
-- after supabase_stub.sql, net_stub.sql, schema.sql and push.sql (see README).
\set QUIET on
\pset tuples_only on
\pset format unaligned
\set A 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set B 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set C 'cccccccc-cccc-cccc-cccc-cccccccccccc'

create schema if not exists t;
grant usage on schema t to public;

create or replace function t.fail(q text, label text) returns text language plpgsql as $$
begin
  begin execute q;
  exception when others then return 'PASS  ' || label || '   [blocked: ' || sqlerrm || ']';
  end;
  return 'FAIL  ' || label || '   [was ALLOWED]';
end $$;

create or replace function t.ok(q text, label text) returns text language plpgsql as $$
begin
  execute q;
  return 'PASS  ' || label;
exception when others then return 'FAIL  ' || label || '   [error: ' || sqlerrm || ']';
end $$;

create or replace function t.rows(q text, n int, label text) returns text language plpgsql as $$
declare c int;
begin
  execute 'select count(*) from (' || q || ') s' into c;
  if c = n then return 'PASS  ' || label || '   [' || c || ' rows]'; end if;
  return 'FAIL  ' || label || '   [expected ' || n || ', got ' || c || ']';
exception when others then return 'FAIL  ' || label || '   [error: ' || sqlerrm || ']';
end $$;

create or replace function t.affects(q text, n int, label text) returns text language plpgsql as $$
declare c int;
begin
  execute q; get diagnostics c = row_count;
  if c = n then return 'PASS  ' || label || '   [' || c || ' rows changed]'; end if;
  return 'FAIL  ' || label || '   [expected ' || n || ' changed, got ' || c || ']';
exception when others then
  if n = 0 then return 'PASS  ' || label || '   [blocked: ' || sqlerrm || ']'; end if;
  return 'FAIL  ' || label || '   [error: ' || sqlerrm || ']';
end $$;

insert into auth.users values (:'A','a@x'), (:'B','b@x'), (:'C','c@x') on conflict do nothing;
insert into public.profiles (id, username, display_name) values
  (:'A','ash','Ash'), (:'B','bala','Bala'), (:'C','chen','Chen') on conflict do nothing;

\echo '--- Saving devices'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok($$select public.save_push_subscription('https://push.example/a1', repeat('p', 87), repeat('k', 22), 'Test phone')$$, 'A turns on notifications for a device');
select t.rows('select * from public.push_subscriptions', 1, 'A sees their device');
select t.fail($$insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.example/x', repeat('p', 87), repeat('k', 22))$$, 'Devices can only be saved through the save function');
select t.fail($$select public.save_push_subscription('http://push.example/insecure', repeat('p', 87), repeat('k', 22))$$, 'Non-https push addresses rejected');
select t.ok($$select public.save_push_subscription('https://push.example/a1', repeat('q', 87), repeat('k', 22), 'Test phone')$$, 'Saving the same device again just refreshes it');
select t.rows('select * from public.push_subscriptions', 1, 'Still one row for that device');
reset role;

select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows('select * from public.push_subscriptions', 0, 'B cannot see A''s devices');
select t.affects($$delete from public.push_subscriptions where endpoint = 'https://push.example/a1'$$, 0, 'B cannot remove A''s device');
select t.fail('select * from public.push_log', 'People cannot read the send log');
reset role;

\echo '--- Shared phone: device moves to whoever signs in'
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select public.save_push_subscription('https://push.example/a1', repeat('p', 87), repeat('k', 22), 'Shared phone');
select t.rows('select * from public.push_subscriptions', 1, 'B now owns the shared device');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.rows('select * from public.push_subscriptions', 0, 'A no longer gets notifications on it');

\echo '--- Device limit'
select public.save_push_subscription('https://push.example/a-' || g, repeat('p', 87), repeat('k', 22)) from generate_series(1, 12) g;
select t.rows('select * from public.push_subscriptions', 10, 'Only the 10 newest devices are kept');
select t.affects($$delete from public.push_subscriptions where endpoint = 'https://push.example/a-12'$$, 1, 'A can remove their own device');
reset role;

\echo '--- Logged out'
select set_config('request.jwt.claim.sub', '', false); set role anon;
select t.fail($$select public.save_push_subscription('https://push.example/anon', repeat('p', 87), repeat('k', 22))$$, 'Logged out: cannot save a device');
select t.fail('select * from public.push_subscriptions', 'Logged out: cannot list devices');
reset role;

\echo '--- New message pings send-push'
truncate net.calls;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select public.get_or_create_dm(:'B') as conv \gset
select t.ok(format($$insert into public.messages (conversation_id, body) values (%L, 'ping')$$, :'conv'), 'A sends a message');
reset role;
select case when (select count(*) from net.calls) = 1
             and (select url from net.calls limit 1) = 'https://obzxdtgfsyidbnjwpmub.supabase.co/functions/v1/send-push'
             and (select (body->>'message_id')::bigint from net.calls limit 1) = (select max(id) from public.messages)
            then 'PASS  Each message calls send-push once, with its id'
            else 'FAIL  send-push call wrong: ' || coalesce((select string_agg(url || ' ' || body::text, '; ') from net.calls), 'none') end;

\echo '--- Notifications failing never blocks messages'
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
returns bigint language plpgsql as $$ begin raise exception 'pretend network is down'; end $$;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$insert into public.messages (conversation_id, body) values (%L, 'still works')$$, :'conv'), 'Message still sends when notifications fail');
reset role;

\echo '--- Server key can read what it needs'
set role service_role;
select t.ok('select count(*) from public.push_subscriptions', 'send-push can read devices');
select t.ok(format('insert into public.push_log (message_id) values (%s)', (select max(id) from public.messages)), 'send-push can record a sent message');
select t.fail(format('insert into public.push_log (message_id) values (%s)', (select max(id) from public.messages)), 'The same message can only be sent once');
select t.fail('insert into public.push_log (message_id) values (999999)', 'Made-up message ids are rejected');
reset role;
