-- Checks for supabase/features.sql (photos, reactions, replies, unsend).
-- Run with psql on a LOCAL test database only (see README).
\set QUIET on
\pset tuples_only on
\pset format unaligned
\set A 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set B 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set C 'cccccccc-cccc-cccc-cccc-cccccccccccc'
\set P1 '11111111-1111-4111-8111-111111111111'
\set P2 '22222222-2222-4222-8222-222222222222'

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

select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select public.get_or_create_dm(:'B') as ab \gset
select public.get_or_create_dm(:'C') as ac \gset
insert into public.messages (conversation_id, body) values (:'ab', 'first') returning id as m1 \gset
insert into public.messages (conversation_id, body) values (:'ac', 'hi chen') returning id as mc \gset
reset role;

\echo '--- Replies'
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.ok(format($$insert into public.messages (conversation_id, body, reply_to) values (%L, 'replying', %s)$$, :'ab', :'m1'), 'B replies to A''s message');
reset role;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.fail(format($$insert into public.messages (conversation_id, body, reply_to) values (%L, 'sneaky quote', %s)$$, :'ac', :'m1'), 'Cannot quote a message from a different chat');
reset role;

\echo '--- Photos: storage'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$insert into storage.objects (bucket_id, name) values ('photos', '%s/%s.jpg'), ('photos', '%s/%s-thumb.jpg')$$, :'ab', :'P1', :'ab', :'P1'), 'A uploads a photo and its preview to the A–B chat');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('photos', '%s/evil.exe')$$, :'ab'), 'Odd file names are refused');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('photos', 'not-a-chat/%s.jpg')$$, :'P2'), 'Files outside a chat folder are refused');
reset role;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.rows($$select * from storage.objects where bucket_id = 'photos'$$, 0, 'C cannot see A–B photos');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('photos', '%s/%s.jpg')$$, :'ab', :'P2'), 'C cannot upload into the A–B chat');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows($$select * from storage.objects where bucket_id = 'photos'$$, 2, 'B can see photos in their chat');
select t.affects(format($$delete from storage.objects where name = '%s/%s.jpg'$$, :'ab', :'P1'), 0, 'B cannot delete A''s photo');
reset role;
set role anon; select set_config('request.jwt.claim.sub', '', false);
select t.rows($$select * from storage.objects where bucket_id = 'photos'$$, 0, 'Logged out: no photos visible');
reset role;
select case when (select public from storage.buckets where id = 'photos') = false
             and (select file_size_limit from storage.buckets where id = 'photos') = 52428800
            then 'PASS  Photo bucket is private, up to 50 MB per photo'
            else 'FAIL  Photo bucket settings wrong' end;

\echo '--- Photos: messages'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$insert into public.messages (conversation_id, body, photo_path, photo_thumb_path, photo_width, photo_height) values (%L, '', '%s/%s.jpg', '%s/%s-thumb.jpg', 4000, 3000)$$, :'ab', :'ab', :'P1', :'ab', :'P1'), 'A sends a photo with no caption');
select t.fail(format($$insert into public.messages (conversation_id, body, photo_path, photo_thumb_path) values (%L, '', '%s/%s.jpg', '%s/%s-thumb.jpg')$$, :'ab', :'ac', :'P1', :'ac', :'P1'), 'A photo must be in its own chat''s folder');
select t.fail(format($$insert into public.messages (conversation_id, body, photo_path) values (%L, '', '%s/%s.jpg')$$, :'ab', :'ab', :'P1'), 'A photo needs its preview too');
select t.fail(format($$insert into public.messages (conversation_id, body) values (%L, '   ')$$, :'ab'), 'Blank messages with no photo are still rejected');
select t.fail(format($$insert into public.messages (conversation_id, body, deleted_at) values (%L, 'x', now())$$, :'ab'), 'Cannot send a pre-unsent message');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows($$select * from public.my_conversations() where last_message_kind = 'photo'$$, 1, 'B''s chat list shows the last message is a photo');
reset role;

\echo '--- Reactions'
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.ok(format($$select public.react(%s, '❤️')$$, :'m1'), 'B reacts ❤️');
select t.ok(format($$select public.react(%s, '😂')$$, :'m1'), 'B changes it to 😂');
select t.rows(format($$select * from public.message_reactions where message_id = %s and emoji = '😂'$$, :'m1'), 1, 'Still one reaction from B, now 😂');
select t.fail(format($$select public.react(%s, '💩')$$, :'m1'), 'Only the six reactions are allowed');
select t.fail(format($$insert into public.message_reactions (message_id, user_id, conversation_id, emoji) values (%s, '%s', '%s', '👍')$$, :'m1', :'A', :'ab'), 'Reactions can only be added through react()');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$select public.react(%s, '🔥')$$, :'m1'), 'A reacts too');
select t.rows(format($$select * from public.message_reactions where message_id = %s and emoji is not null$$, :'m1'), 2, 'Both reactions show');
reset role;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.fail(format($$select public.react(%s, '👍')$$, :'m1'), 'C cannot react in a chat they''re not in');
select t.rows('select * from public.message_reactions', 0, 'C cannot see A–B reactions');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.ok(format($$select public.react(%s, null)$$, :'m1'), 'B removes their reaction');
select t.rows(format($$select * from public.message_reactions where message_id = %s and emoji is not null$$, :'m1'), 1, 'Only A''s reaction is left');
reset role;

\echo '--- Unsend'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select id as photo_msg from public.messages where photo_path is not null limit 1 \gset
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.fail(format('select * from public.unsend_message(%s)', :'photo_msg'), 'B cannot unsend A''s message');
select t.ok(format($$select public.react(%s, '👍')$$, :'photo_msg'), 'B reacts to the photo');
select public.mark_read(:'ab');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.fail(format($$update public.messages set body = 'edited' where id = %s$$, :'m1'), 'Messages still can''t be edited directly');
select t.rows(format('select * from public.unsend_message(%s) where photo_path is not null and photo_thumb_path is not null', :'photo_msg'), 1, 'A unsends the photo and gets its files back to delete');
select t.rows(format($$select * from public.messages where id = %s and deleted_at is not null and body = '' and photo_path is null$$, :'photo_msg'), 1, 'Unsent message keeps no text or photo');
select t.rows(format('select * from public.message_reactions where message_id = %s and emoji is not null', :'photo_msg'), 0, 'Reactions on it are cleared');
select t.rows(format('select * from public.unsend_message(%s)', :'photo_msg'), 0, 'Unsending twice does nothing');
select t.affects(format($$delete from storage.objects where name in ('%s/%s.jpg', '%s/%s-thumb.jpg')$$, :'ab', :'P1', :'ab', :'P1'), 2, 'A can delete their own photo files');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.fail(format($$select public.react(%s, '👍')$$, :'photo_msg'), 'Cannot react to an unsent message');
select t.rows($$select * from public.my_conversations() where conversation_id = (select conversation_id from public.messages where id = (select max(id) from public.messages where body = 'replying')) and last_message_kind = 'unsent'$$, 1, 'Chat list shows the last message was unsent');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
insert into public.messages (conversation_id, body) values (:'ab', 'oops') returning id as oops \gset
select * from public.unsend_message(:'oops');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows($$select * from public.my_conversations() where unread_count = 0 and last_message_kind = 'unsent'$$, 1, 'Unsent messages don''t count as unread');
reset role;

\echo '--- Live updates'
select case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'message_reactions')
            then 'PASS  Reactions are streamed live' else 'FAIL  reactions not in realtime publication' end;
