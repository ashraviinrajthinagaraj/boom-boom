-- Security checks for supabase/schema.sql. Run with psql on a LOCAL test database only
-- (see README). Each line prints PASS or FAIL.
\set QUIET on
\pset tuples_only on
\pset format unaligned
\set A 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set B 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set C 'cccccccc-cccc-cccc-cccc-cccccccccccc'

-- ---------- test helpers (run with the CALLER's permissions) ----------
create schema t;
grant usage on schema t to public;

create function t.fail(q text, label text) returns text language plpgsql as $$
begin
  begin execute q;
  exception when others then return 'PASS  ' || label || '   [blocked: ' || sqlerrm || ']';
  end;
  return 'FAIL  ' || label || '   [was ALLOWED]';
end $$;

create function t.ok(q text, label text) returns text language plpgsql as $$
begin
  execute q;
  return 'PASS  ' || label;
exception when others then return 'FAIL  ' || label || '   [error: ' || sqlerrm || ']';
end $$;

create function t.rows(q text, n int, label text) returns text language plpgsql as $$
declare c int;
begin
  execute 'select count(*) from (' || q || ') s' into c;
  if c = n then return 'PASS  ' || label || '   [' || c || ' rows]'; end if;
  return 'FAIL  ' || label || '   [expected ' || n || ', got ' || c || ']';
exception when others then return 'FAIL  ' || label || '   [error: ' || sqlerrm || ']';
end $$;

create function t.affects(q text, n int, label text) returns text language plpgsql as $$
declare c int;
begin
  execute q; get diagnostics c = row_count;
  if c = n then return 'PASS  ' || label || '   [' || c || ' rows changed]'; end if;
  return 'FAIL  ' || label || '   [expected ' || n || ' changed, got ' || c || ']';
exception when others then
  if n = 0 then return 'PASS  ' || label || '   [blocked: ' || sqlerrm || ']'; end if;
  return 'FAIL  ' || label || '   [error: ' || sqlerrm || ']';
end $$;

insert into auth.users values (:'A','a@x'), (:'B','b@x'), (:'C','c@x');

\echo '--- Profiles'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok($$insert into public.profiles (id, username, display_name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ash','Ash')$$, 'A creates own profile');
select t.fail($$insert into public.profiles (id, username, display_name) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','fakeb','Fake B')$$, 'A cannot create a profile for B');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.fail($$insert into public.profiles (id, username, display_name) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Bad Name!','B')$$, 'Usernames with spaces/caps rejected');
select t.ok($$insert into public.profiles (id, username, display_name) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','bala','Bala')$$, 'B creates own profile');
reset role;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.ok($$insert into public.profiles (id, username, display_name) values ('cccccccc-cccc-cccc-cccc-cccccccccccc','chen','Chen')$$, 'C creates own profile');
select t.fail($$update public.profiles set username = 'ash' where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'$$, 'Duplicate username rejected');
reset role;

\echo '--- Starting chats'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select public.get_or_create_dm(:'B') as conv1 \gset
select public.get_or_create_dm(:'B') as conv1_again \gset
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select public.get_or_create_dm(:'A') as conv1_fromb \gset
reset role;
select case when :'conv1' = :'conv1_again' and :'conv1' = :'conv1_fromb'
            then 'PASS  Same chat reused no matter who opens it'
            else 'FAIL  Duplicate chats created' end;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.fail($$select public.get_or_create_dm('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$, 'Cannot open a chat with yourself');
select t.fail($$select public.get_or_create_dm('dddddddd-dddd-dddd-dddd-dddddddddddd')$$, 'Cannot open a chat with a non-existent person');

\echo '--- Sending messages'
select t.ok(format($$insert into public.messages (conversation_id, body) values (%L, 'hi bala')$$, :'conv1'), 'A sends a message to B');
select t.fail(format($$insert into public.messages (conversation_id, body, sender_id) values (%L, 'fake', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$, :'conv1'), 'A cannot send pretending to be B');
select t.fail(format($$insert into public.messages (conversation_id, body, created_at) values (%L, 'time travel', '2030-01-01')$$, :'conv1'), 'A cannot fake a timestamp');
select t.fail(format($$insert into public.messages (conversation_id, body) values (%L, '   ')$$, :'conv1'), 'Blank messages rejected');
select t.fail(format($$update public.messages set body = 'edited' where conversation_id = %L$$, :'conv1'), 'Messages cannot be edited');
select t.fail(format($$delete from public.messages where conversation_id = %L$$, :'conv1'), 'Messages cannot be deleted by users');
reset role;

\echo '--- Outsider (C) cannot see or touch A<->B chat'
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.rows('select * from public.messages', 0, 'C sees no messages');
select t.rows('select * from public.conversations', 0, 'C sees no chats');
select t.rows('select * from public.conversation_members', 0, 'C sees no chat members');
select t.rows('select * from public.my_conversations()', 0, 'C chat list is empty');
select t.fail(format($$insert into public.messages (conversation_id, body) values (%L, 'sneaky')$$, :'conv1'), 'C cannot post into A<->B chat');
select t.fail(format($$insert into public.conversation_members (conversation_id, user_id) values (%L, 'cccccccc-cccc-cccc-cccc-cccccccccccc')$$, :'conv1'), 'C cannot add themselves to the chat');
select t.fail(format($$update public.conversation_members set user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' where conversation_id = %L$$, :'conv1'), 'C cannot hijack a membership row');
select t.rows('select * from public.profiles', 3, 'C can see the friends list (profiles)');
reset role;

\echo '--- Chat list and unread badges'
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows($$select * from public.my_conversations() where unread_count = 1 and other_user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and last_message_body = 'hi bala'$$, 1, 'B sees chat with A, 1 unread, last message shown');
select t.rows('select * from public.messages', 1, 'B can read the message');
select public.mark_read(:'conv1');
select t.rows('select * from public.my_conversations() where unread_count = 0', 1, 'After opening, B has 0 unread');
select t.ok(format($$insert into public.messages (conversation_id, body) values (%L, 'hey ash')$$, :'conv1'), 'B replies');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.rows('select * from public.my_conversations() where unread_count = 1', 1, 'A now has 1 unread (B''s reply)');
select t.rows('select * from public.messages', 2, 'A sees both messages');

\echo '--- Profile editing'
select t.affects($$update public.profiles set display_name = 'hacked' where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$, 0, 'A cannot rename B');
select t.affects($$update public.profiles set display_name = 'Ashra' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$, 1, 'A can rename themselves');
select t.fail($$update public.profiles set id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$, 'A cannot change their account id');

\echo '--- Empty chats stay hidden from the other person'
select public.get_or_create_dm(:'C') as conv2 \gset
select t.rows('select * from public.my_conversations()', 2, 'A sees both chats (incl. the empty one they opened)');
reset role;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.rows('select * from public.my_conversations()', 0, 'C does not see an empty chat A opened');
select t.rows('select * from public.messages', 0, 'C still sees no A<->B messages');
reset role;

\echo '--- Logged-out visitors'
select set_config('request.jwt.claim.sub', '', false); set role anon;
select t.fail('select * from public.profiles', 'Logged out: cannot list people');
select t.fail('select * from public.messages', 'Logged out: cannot read messages');
select t.fail($$select public.get_or_create_dm('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$, 'Logged out: cannot start chats');
select t.fail('select * from public.my_conversations()', 'Logged out: cannot list chats');
reset role;

\echo '--- Wiring'
select case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages')
            then 'PASS  messages table is streamed by Realtime' else 'FAIL  messages not in realtime publication' end;
select case when (select last_message_at from public.conversations where id = :'conv1') is not null
            then 'PASS  Chat moves to top when a message is sent' else 'FAIL  last_message_at not set' end;
