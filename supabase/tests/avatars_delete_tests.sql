-- Checks for supabase/avatars-and-delete.sql. LOCAL test database only.
\set QUIET on
\pset tuples_only on
\pset format unaligned
\set A 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set B 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set C 'cccccccc-cccc-cccc-cccc-cccccccccccc'
\set P1 '11111111-1111-4111-8111-111111111111'

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

\echo '--- Profile pictures'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$insert into storage.objects (bucket_id, name) values ('avatars', '%s/%s.jpg')$$, :'A', :'P1'), 'A uploads a profile picture to their own folder');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('avatars', '%s/%s.jpg')$$, :'B', :'P1'), 'A cannot upload into B''s folder');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('avatars', '%s/me.png')$$, :'A'), 'Odd file names refused');
select t.affects(format($$update public.profiles set avatar_path = '%s/%s.jpg' where id = '%s'$$, :'A', :'P1', :'A'), 1, 'A sets their picture');
select t.fail(format($$update public.profiles set avatar_path = '%s/%s.jpg' where id = '%s'$$, :'B', :'P1', :'A'), 'A cannot point their picture at someone else''s file');
select t.affects(format($$update public.profiles set avatar_path = '%s/%s.jpg' where id = '%s'$$, :'B', :'P1', :'B'), 0, 'A cannot change B''s picture');
reset role;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.rows($$select * from storage.objects where bucket_id = 'avatars'$$, 1, 'Other members can see profile pictures');
select t.affects(format($$delete from storage.objects where name = '%s/%s.jpg'$$, :'A', :'P1'), 0, 'C cannot delete A''s picture');
reset role;
set role anon; select set_config('request.jwt.claim.sub', '', false);
select t.rows($$select * from storage.objects where bucket_id = 'avatars'$$, 0, 'Logged out: no profile pictures visible');
reset role;
select case when (select public from storage.buckets where id = 'avatars') = false
            then 'PASS  Profile picture bucket is private' else 'FAIL  avatars bucket is public' end;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.affects(format($$delete from storage.objects where name = '%s/%s.jpg'$$, :'A', :'P1'), 1, 'A can delete their own old picture');
reset role;

\echo '--- Delete chat (for you)'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select public.get_or_create_dm(:'B') as ab \gset
insert into public.messages (conversation_id, body) values (:'ab', 'old news');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
insert into public.messages (conversation_id, body) values (:'ab', 'reply from bala');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.rows('select * from public.my_conversations()', 1, 'A sees the chat');
select t.ok(format($$select public.delete_chat(%L)$$, :'ab'), 'A deletes the chat');
select t.rows('select * from public.my_conversations()', 0, 'Chat is gone from A''s list');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows($$select * from public.my_conversations() where last_message_body = 'reply from bala'$$, 1, 'B still has the chat and all messages');
select t.rows('select * from public.messages', 2, 'B''s copy is untouched');
select t.ok(format($$select public.delete_chat(%L)$$, gen_random_uuid()), 'Deleting a chat you''re not in does nothing');
select pg_sleep(0.01);
insert into public.messages (conversation_id, body) values (:'ab', 'you there?');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.rows($$select * from public.my_conversations() where last_message_body = 'you there?' and unread_count = 1 and cleared_at is not null$$, 1, 'A new message brings the chat back, counting only the new one');
reset role;

\echo '--- Delete stays private'
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.affects(format($$update public.conversation_members set cleared_at = now() where conversation_id = %L$$, :'ab'), 0, 'Nobody can change someone else''s delete');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.fail(format($$update public.conversation_members set cleared_at = null where conversation_id = %L$$, :'ab'), 'Delete can only be done through delete_chat()');
reset role;

select case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'profiles')
            then 'PASS  Profile changes are streamed live' else 'FAIL  profiles not in realtime publication' end;
