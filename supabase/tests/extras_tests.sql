-- Checks for supabase/chat-extras.sql. LOCAL test database only.
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
insert into public.messages (conversation_id, body) values (:'ab', 'helo') returning id as m1 \gset
reset role;

\echo '--- Typing'
select set_config('realtime.topic', 'typing:' || :'ab', false);
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.ok(format($$insert into realtime.messages (topic, extension, payload) values ('typing:%s', 'broadcast', '{}')$$, :'ab'), 'B can say they''re typing in their chat');
select t.rows($$select * from realtime.messages$$, 1, 'B can see typing in their chat');
reset role;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.fail(format($$insert into realtime.messages (topic, extension, payload) values ('typing:%s', 'broadcast', '{}')$$, :'ab'), 'C cannot send typing into the A–B chat');
select t.rows($$select * from realtime.messages$$, 0, 'C cannot see typing in the A–B chat');
reset role;
select set_config('realtime.topic', 'something-else', false);
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows($$select * from realtime.messages$$, 0, 'Other channel names get nothing');
select t.ok($$update public.profiles set share_typing = false where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$, 'B can switch typing off for themselves');
reset role;
set role anon; select set_config('request.jwt.claim.sub', '', false); select set_config('realtime.topic', 'typing:' || :'ab', false);
select t.rows($$select * from realtime.messages$$, 0, 'Logged out: no typing visible');
reset role;

\echo '--- Edit'
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.fail(format($$select public.edit_message(%s, 'hacked')$$, :'m1'), 'B cannot edit A''s message');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$select public.edit_message(%s, 'hello')$$, :'m1'), 'A fixes their typo');
select t.rows(format($$select * from public.messages where id = %s and body = 'hello' and edited_at is not null$$, :'m1'), 1, 'Message shows the new text and is marked edited');
select t.fail(format($$select public.edit_message(%s, '   ')$$, :'m1'), 'Cannot edit a message to blank');
reset role;
update public.messages set created_at = now() - interval '20 minutes' where id = :m1;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.fail(format($$select public.edit_message(%s, 'too late')$$, :'m1'), 'After 15 minutes it can''t be edited');
insert into public.messages (conversation_id, body) values (:'ab', 'bye') returning id as m2 \gset
select * from public.unsend_message(:'m2');
select t.fail(format($$select public.edit_message(%s, 'back')$$, :'m2'), 'Unsent messages can''t be edited');
reset role;

\echo '--- Chat colours'
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.ok(format($$select public.set_chat_theme(%L, 'ocean')$$, :'ab'), 'B sets the chat to ocean');
select t.fail(format($$select public.set_chat_theme(%L, 'neon-pink')$$, :'ab'), 'Only the listed colours');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.rows(format($$select * from public.conversations where id = %L and theme = 'ocean'$$, :'ab'), 1, 'A sees the same colour');
reset role;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.fail(format($$select public.set_chat_theme(%L, 'rose')$$, :'ab'), 'C cannot recolour a chat they''re not in');
reset role;

\echo '--- CPR'
set role anon; select set_config('request.jwt.claim.sub', '', false);
select case when public.cpr() = 'Boom Boom is alive' then 'PASS  CPR works without logging in (for the scheduled job)' else 'FAIL  cpr()' end;
select public.cpr();
select t.fail('select * from public.cpr_log', 'Nobody can read the CPR log through the app');
reset role;
select case when (select count(*) from public.cpr_log) = 1 then 'PASS  Repeated CPR within an hour adds just one entry' else 'FAIL  cpr_log count ' || (select count(*) from public.cpr_log) end;
select case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'conversations')
            then 'PASS  Colour changes are streamed live' else 'FAIL  conversations not in realtime publication' end;
