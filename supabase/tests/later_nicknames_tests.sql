-- Checks for supabase/send-later-nicknames.sql. LOCAL test database only.
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

insert into auth.users values (:'A','a@x'), (:'B','b@x'), (:'C','c@x') on conflict do nothing;
insert into public.profiles (id, username, display_name) values
  (:'A','ash','Ash'), (:'B','bala','Bala'), (:'C','chen','Chen') on conflict do nothing;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select public.get_or_create_dm(:'B') as ab \gset
insert into public.messages (conversation_id, body) values (:'ab', 'hi') returning id as m1 \gset
reset role;
truncate net.calls;

\echo '--- Send later'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select public.schedule_message(:'ab', 'Happy birthday!! 🎂', now() + interval '2 hours') as s1 \gset
select public.schedule_message(:'ab', 'reply later', now() + interval '3 hours', :m1) as s2 \gset
select t.rows('select * from public.scheduled_messages', 2, 'A schedules two messages and sees them');
select t.fail(format($$select public.schedule_message(%L, 'oops', now() - interval '1 minute')$$, :'ab'), 'Times in the past are refused');
select t.fail(format($$select public.schedule_message(%L, 'far', now() + interval '2 years')$$, :'ab'), 'More than a year ahead is refused');
select t.fail(format($$select public.schedule_message(%L, '   ', now() + interval '1 hour')$$, :'ab'), 'Blank messages are refused');
select t.fail(format($$insert into public.scheduled_messages (conversation_id, body, send_at) values (%L, 'x', now())$$, :'ab'), 'Scheduling only works through schedule_message()');
select t.fail('select public.deliver_scheduled()', 'People can''t trigger the timer themselves');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows('select * from public.scheduled_messages', 0, 'B can''t see A''s scheduled messages (no spoilers)');
select t.rows($$select * from public.messages where body like 'Happy%'$$, 0, 'Nothing has been sent yet');
select case when not public.cancel_scheduled(:s1) then 'PASS  B can''t cancel A''s scheduled message' else 'FAIL  B cancelled it' end;
reset role;
select case when (select status from public.scheduled_messages where id = :s1) = 'waiting' then 'PASS  A''s message is still waiting after B tried' else 'FAIL  B changed it' end;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.fail(format($$select public.schedule_message(%L, 'sneaky', now() + interval '1 hour')$$, :'ab'), 'C can''t schedule into the A–B chat');
reset role;

-- time passes: make the first one due
update public.scheduled_messages set send_at = now() - interval '1 second' where id = :s1;
select case when public.deliver_scheduled() = 1 then 'PASS  The timer sends the due message' else 'FAIL  deliver_scheduled' end;
select case when public.deliver_scheduled() = 0 then 'PASS  Running the timer again sends nothing twice' else 'FAIL  sent twice' end;
select case when (select count(*) from public.messages where body = 'Happy birthday!! 🎂' and sender_id = :'A') = 1
            then 'PASS  It arrives as a normal message from A' else 'FAIL  message not delivered' end;
select case when (select status = 'sent' and body = '' and message_id is not null from public.scheduled_messages where id = :s1)
            then 'PASS  The waiting copy is wiped once sent' else 'FAIL  waiting copy kept' end;
select case when (select count(*) from net.calls) = 1 then 'PASS  It triggers a notification like any message' else 'FAIL  push calls: ' || (select count(*) from net.calls) end;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format('select public.send_scheduled_now(%s)', :s2), 'A sends the other one now');
select t.rows(format('select * from public.messages where body = %L and reply_to = %s', 'reply later', :m1), 1, 'Send now keeps the reply link');
select public.schedule_message(:'ab', 'never mind', now() + interval '1 day') as s3 \gset
select case when public.cancel_scheduled(:s3) then 'PASS  A cancels one' else 'FAIL  cancel said nothing was cancelled' end;
select case when not public.cancel_scheduled(:s2) then 'PASS  Cancelling one that already went out says so' else 'FAIL  cancel_scheduled on a sent message' end;
select t.rows(format($$select * from public.scheduled_messages where id = %s and status = 'cancelled' and body = ''$$, :s3), 1, 'Cancelled message is wiped');
reset role;
update public.scheduled_messages set send_at = now() - interval '1 second' where id = :s3;
select case when public.deliver_scheduled() = 0 then 'PASS  Cancelled messages never send' else 'FAIL  cancelled message sent' end;
select case when exists (select 1 from cron.job where jobname = 'boom-send-later' and schedule = '* * * * *')
             and exists (select 1 from cron.job where jobname = 'boom-tidy-cron-log')
            then 'PASS  Timer runs every minute, and its log is tidied daily' else 'FAIL  cron jobs missing' end;

\echo '--- Nicknames'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$select public.set_nickname(%L, 'Bala the Great')$$, :'B'), 'A nicknames B');
select t.ok(format($$select public.set_nickname(%L, 'Bala Bro')$$, :'B'), 'A changes it');
select t.rows($$select * from public.nicknames where nickname = 'Bala Bro'$$, 1, 'A sees the new nickname');
select t.fail(format($$select public.set_nickname(%L, 'Me')$$, :'A'), 'You can''t nickname yourself');
select t.fail(format($$insert into public.nicknames (target_id, nickname) values (%L, 'x')$$, :'C'), 'Nicknames only through set_nickname()');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows('select * from public.nicknames', 0, 'B can''t see what A calls them');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$select public.set_nickname(%L, '')$$, :'B'), 'Clearing the nickname');
select t.rows('select * from public.nicknames', 0, 'removes it');
reset role;
