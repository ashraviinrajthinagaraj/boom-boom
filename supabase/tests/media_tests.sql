-- Checks for supabase/media-extras.sql (albums, files, stickers, wallpapers).
-- Run with psql on a LOCAL test database only (see README).
\set QUIET on
\pset tuples_only on
\pset format unaligned
\set A 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set B 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set C 'cccccccc-cccc-cccc-cccc-cccccccccccc'
\set P1 '11111111-1111-4111-8111-111111111111'
\set P2 '22222222-2222-4222-8222-222222222222'
\set P3 '33333333-3333-4333-8333-333333333333'
\set F1 '44444444-4444-4444-8444-444444444444'
\set F2 '88888888-8888-4888-8888-888888888888'
\set S1 '55555555-5555-4555-8555-555555555555'
\set S2 '66666666-6666-4666-8666-666666666666'
\set W1 '77777777-7777-4777-8777-777777777777'

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
-- An album as the app writes it: photos 1..n of this chat.
create or replace function t.album(conv uuid, ids text[]) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('path', conv || '/' || i || '.jpg', 'thumb', conv || '/' || i || '-thumb.jpg', 'width', 1200, 'height', 900) order by o)
  from unnest(ids) with ordinality as u(i, o);
$$;

insert into auth.users values (:'A','a@x'), (:'B','b@x'), (:'C','c@x') on conflict do nothing;
insert into public.profiles (id, username, display_name) values
  (:'A','ash','Ash'), (:'B','bala','Bala'), (:'C','chen','Chen') on conflict do nothing;

select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select public.get_or_create_dm(:'B') as ab \gset
select public.get_or_create_dm(:'C') as ac \gset
reset role;

\echo '--- Albums'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$insert into public.messages (conversation_id, body, photo_path, photo_thumb_path, photo_width, photo_height, album)
  values (%L, 'Tournament day', %L, %L, 1200, 900, t.album(%L, array[%L, %L, %L]))$$,
  :'ab', :'ab' || '/' || :'P1' || '.jpg', :'ab' || '/' || :'P1' || '-thumb.jpg', :'ab', :'P1', :'P2', :'P3'), 'A sends a 3-photo album with a caption');
select id as album_msg from public.messages where album is not null \gset
select t.fail(format($$insert into public.messages (conversation_id, photo_path, photo_thumb_path, album) values (%L, %L, %L, t.album(%L, array[%L]))$$,
  :'ab', :'ab' || '/' || :'P1' || '.jpg', :'ab' || '/' || :'P1' || '-thumb.jpg', :'ab', :'P1'), 'An album of 1 photo is refused');
select t.fail(format($$insert into public.messages (conversation_id, photo_path, photo_thumb_path, album)
  values (%L, %L, %L, t.album(%L, array[%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L]))$$,
  :'ab', :'ab' || '/' || :'P1' || '.jpg', :'ab' || '/' || :'P1' || '-thumb.jpg', :'ab',
  '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000011'), 'More than 10 photos is refused');
select t.fail(format($$insert into public.messages (conversation_id, photo_path, photo_thumb_path, album) values (%L, %L, %L, t.album(%L, array[%L, %L]))$$,
  :'ab', :'ab' || '/' || :'P1' || '.jpg', :'ab' || '/' || :'P1' || '-thumb.jpg', :'ac', :'P1', :'P2'), 'Album photos from another chat''s folder are refused');
select t.fail(format($$insert into public.messages (conversation_id, photo_path, photo_thumb_path, album) values (%L, %L, %L, t.album(%L, array[%L, %L]))$$,
  :'ab', :'ab' || '/' || :'P3' || '.jpg', :'ab' || '/' || :'P3' || '-thumb.jpg', :'ab', :'P1', :'P2'), 'The cover must be the album''s first photo');
select t.fail(format($$insert into public.messages (conversation_id, photo_path, photo_thumb_path, album) values (%L, %L, %L, t.album(%L, array[%L, %L]))$$,
  :'ab', :'ab' || '/' || :'P1' || '.jpg', :'ab' || '/' || :'P1' || '-thumb.jpg', :'ab', :'P1', :'P1'), 'The same photo twice is refused');
select t.fail(format($$insert into public.messages (conversation_id, photo_path, photo_thumb_path, album)
  values (%L, %L, %L, jsonb_build_array(jsonb_build_object('path', %L, 'thumb', %L, 'width', '1200', 'height', 900), jsonb_build_object('path', %L, 'thumb', %L, 'width', 10, 'height', 10)))$$,
  :'ab', :'ab' || '/' || :'P1' || '.jpg', :'ab' || '/' || :'P1' || '-thumb.jpg',
  :'ab' || '/' || :'P1' || '.jpg', :'ab' || '/' || :'P1' || '-thumb.jpg', :'ab' || '/' || :'P2' || '.jpg', :'ab' || '/' || :'P2' || '-thumb.jpg'), 'Odd album details (a size written as text) are refused');
select t.fail(format($$insert into public.messages (conversation_id, photo_path, photo_thumb_path, album)
  values (%L, %L, %L, t.album(%L, array[%L, %L]) || '[{"path":"x","thumb":"y","width":1,"height":1,"extra":1}]'::jsonb)$$,
  :'ab', :'ab' || '/' || :'P1' || '.jpg', :'ab' || '/' || :'P1' || '-thumb.jpg', :'ab', :'P1', :'P2'), 'Extra junk in an album is refused');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows(format('select * from public.messages where id = %s and jsonb_array_length(album) = 3', :album_msg), 1, 'B sees the whole album');
select t.rows($$select * from public.my_conversations() where last_message_kind = 'album' and last_message_body = 'Tournament day'$$, 1, 'The chat list knows it''s an album');
select t.fail(format('select * from public.unsend_message(%s)', :album_msg), 'B can''t unsend A''s album');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.rows(format('select * from public.unsend_message(%s) where photo_path is not null and photo_thumb_path is not null', :album_msg), 3, 'Unsending an album hands back all 3 photos to delete');
select t.rows(format('select * from public.messages where id = %s and album is null and photo_path is null and deleted_at is not null', :album_msg), 1, '...and clears it for everyone');
reset role;

\echo '--- Files'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$insert into storage.objects (bucket_id, name) values ('files', '%s/%s')$$, :'ab', :'F1'), 'A uploads a file to the A–B chat');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('files', '%s/%s.html')$$, :'ab', :'F2'), 'Files must use the app''s plain random names');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('files', 'notes/%s')$$, :'F1'), 'Files outside a chat folder are refused');
select t.ok(format($$insert into public.messages (conversation_id, file_path, file_name, file_size, file_type) values (%L, %L, 'Motion prep (final).pdf', 482113, 'application/pdf')$$,
  :'ab', :'ab' || '/' || :'F1'), 'A sends it as a file message');
select id as file_msg from public.messages where file_path is not null \gset
select t.fail(format($$insert into public.messages (conversation_id, file_path, file_name, file_size) values (%L, %L, 'big.zip', 30000000)$$, :'ab', :'ab' || '/' || :'F1'), 'Files over 25 MB are refused');
select t.fail(format($$insert into public.messages (conversation_id, file_path, file_name, file_size) values (%L, %L, '../../etc/passwd', 10)$$, :'ab', :'ab' || '/' || :'F1'), 'File names with slashes are refused');
select t.fail(format($$insert into public.messages (conversation_id, file_path, file_name, file_size) values (%L, %L, E'evil\nname.pdf', 10)$$, :'ab', :'ab' || '/' || :'F1'), 'File names with hidden control characters are refused');
select t.fail(format($$insert into public.messages (conversation_id, file_path, file_name, file_size) values (%L, %L, %L, 10)$$, :'ab', :'ab' || '/' || :'F1', repeat('a', 201)), 'Very long file names are refused');
select t.fail(format($$insert into public.messages (conversation_id, file_path, file_name, file_size) values (%L, %L, 'x.pdf', 10)$$, :'ab', :'ac' || '/' || :'F1'), 'A file from another chat''s folder is refused');
select t.fail(format($$insert into public.messages (conversation_id, file_path, file_name, file_size, photo_path, photo_thumb_path) values (%L, %L, 'x.pdf', 10, %L, %L)$$,
  :'ab', :'ab' || '/' || :'F1', :'ab' || '/' || :'P1' || '.jpg', :'ab' || '/' || :'P1' || '-thumb.jpg'), 'A message can''t be a file and a photo at once');
select t.fail(format($$insert into public.messages (conversation_id, file_path, file_name, file_size, file_type) values (%L, %L, 'x.pdf', 10, 'text/html"><script>')$$, :'ab', :'ab' || '/' || :'F1'), 'Odd file types are refused');
select t.fail(format($$select public.edit_message(%s, 'changed')$$, :file_msg), 'Files can''t be edited');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows($$select * from storage.objects where bucket_id = 'files'$$, 1, 'B can download files in their chat');
select t.rows($$select * from public.my_conversations() where last_message_kind = 'file' and last_message_body = 'Motion prep (final).pdf'$$, 1, 'The chat list shows the file''s name');
select t.affects(format($$delete from storage.objects where bucket_id = 'files' and name = '%s/%s'$$, :'ab', :'F1'), 0, 'B can''t delete A''s file');
reset role;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.rows($$select * from storage.objects where bucket_id = 'files'$$, 0, 'C can''t see files from the A–B chat');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('files', '%s/%s')$$, :'ab', :'F2'), 'C can''t upload into the A–B chat');
reset role;
set role anon;
select t.rows($$select * from storage.objects where bucket_id = 'files'$$, 0, 'Logged out: no files visible');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format('select * from public.unsend_message(%s)', :file_msg), 'A unsends the file');
select t.rows(format('select * from public.messages where id = %s and file_path is null and file_name is null and file_size is null', :file_msg), 1, '...and its name is gone too');
select t.affects(format($$delete from storage.objects where bucket_id = 'files' and name = '%s/%s'$$, :'ab', :'F1'), 1, 'A can delete their own file');
reset role;

\echo '--- Stickers'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$insert into storage.objects (bucket_id, name) values ('stickers', '%s/%s.webp'), ('stickers', '%s/%s.png')$$, :'A', :'S1', :'A', :'S2'), 'A makes two stickers');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('stickers', '%s/%s.webp')$$, :'B', :'S1'), 'A can''t put stickers in B''s folder');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('stickers', '%s/%s.jpg')$$, :'A', :'P1'), 'Stickers must be WebP or PNG');
select t.ok(format($$select public.add_sticker(%L)$$, :'A' || '/' || :'S1' || '.webp'), 'A adds one to their tray');
select t.ok(format($$select public.add_sticker(%L)$$, :'A' || '/' || :'S2' || '.png'), '...and the other');
select t.ok(format($$select public.add_sticker(%L)$$, :'A' || '/' || :'S1' || '.webp'), 'Adding the same one again is harmless');
select t.rows('select * from public.stickers', 2, 'A''s tray has 2 stickers');
select t.fail($$select public.add_sticker('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/99999999-9999-4999-8999-999999999999.webp')$$, 'A sticker that doesn''t exist can''t be added');
select t.fail($$insert into public.stickers (path) values ('x')$$, 'The tray only changes through add_sticker()');
select t.ok(format($$insert into public.messages (conversation_id, sticker_path) values (%L, %L)$$, :'ab', :'A' || '/' || :'S1' || '.webp'), 'A sends a sticker');
select id as sticker_msg from public.messages where sticker_path is not null \gset
select t.fail(format($$insert into public.messages (conversation_id, sticker_path) values (%L, %L)$$, :'ab', :'A' || '/' || :'P3' || '.webp'), 'A sticker message needs a real sticker');
select t.fail(format($$select public.edit_message(%s, 'changed')$$, :sticker_msg), 'Stickers can''t be edited');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows($$select * from storage.objects where bucket_id = 'stickers'$$, 2, 'B can see A''s stickers (so sent ones show up)');
select t.rows('select * from public.stickers', 0, 'B can''t see what''s in A''s tray');
select t.rows($$select * from public.my_conversations() where last_message_kind = 'sticker'$$, 1, 'The chat list knows it''s a sticker');
select t.ok(format($$select public.add_sticker(%L)$$, :'A' || '/' || :'S1' || '.webp'), 'B saves A''s sticker to their own tray');
select t.affects(format($$delete from storage.objects where bucket_id = 'stickers' and name = '%s/%s.webp'$$, :'A', :'S1'), 0, 'B can''t delete A''s sticker file');
select id as b_row from public.stickers \gset
reset role;
set role anon;
select t.rows($$select * from storage.objects where bucket_id = 'stickers'$$, 0, 'Logged out: no stickers visible');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.affects(format('delete from public.stickers where id = %s', :b_row), 0, 'A can''t touch B''s tray');
select case when public.remove_sticker(:b_row) is null and (select count(*) from public.stickers) = 2
            then 'PASS  remove_sticker() ignores someone else''s tray' else 'FAIL  removed B''s sticker' end;
select id as a_s1 from public.stickers where path like '%' || :'S1' || '.webp' \gset
select id as a_s2 from public.stickers where path like '%' || :'S2' || '.png' \gset
select public.remove_sticker(:a_s1) is null as kept \gset
select case when :'kept' = 't' and (select count(*) from public.stickers) = 1
            then 'PASS  Removing a sticker that''s been sent keeps its file' else 'FAIL  remove_sticker (sent)' end;
select case when public.remove_sticker(:a_s2) = :'A' || '/' || :'S2' || '.png'
            then 'PASS  Removing an unused sticker says its file can go' else 'FAIL  remove_sticker (unused)' end;
reset role;

\echo '--- Wallpapers'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$select public.set_wallpaper(%L, 'pattern:dots')$$, :'ab'), 'A picks a pattern for the A–B chat');
select t.fail(format($$select public.set_wallpaper(%L, 'pattern:<script>')$$, :'ab'), 'Made-up wallpapers are refused');
select t.fail(format($$select public.set_wallpaper(%L, %L)$$, :'ab', 'photo:' || :'B' || '/' || :'W1' || '.jpg'), 'A can''t use a photo from B''s folder');
select t.ok(format($$insert into storage.objects (bucket_id, name) values ('wallpapers', '%s/%s.jpg')$$, :'A', :'W1'), 'A uploads a wallpaper photo');
select t.fail(format($$insert into storage.objects (bucket_id, name) values ('wallpapers', '%s/%s.jpg')$$, :'B', :'W1'), 'A can''t upload into B''s wallpaper folder');
select t.ok(format($$select public.set_wallpaper(%L, %L)$$, :'ab', 'photo:' || :'A' || '/' || :'W1' || '.jpg'), 'A uses their photo as the wallpaper');
select t.rows($$select * from public.chat_wallpapers where wallpaper like 'photo:%'$$, 1, 'A sees their wallpaper');
reset role;
select set_config('request.jwt.claim.sub', :'B', false); set role authenticated;
select t.rows('select * from public.chat_wallpapers', 0, 'B can''t see A''s wallpaper choice');
select t.rows($$select * from storage.objects where bucket_id = 'wallpapers'$$, 0, 'B can''t see A''s wallpaper photo');
reset role;
select set_config('request.jwt.claim.sub', :'C', false); set role authenticated;
select t.fail(format($$select public.set_wallpaper(%L, 'pattern:dots')$$, :'ab'), 'C can''t set a wallpaper on a chat they''re not in');
reset role;
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select case when public.set_wallpaper(:'ab', 'pattern:waves') = :'A' || '/' || :'W1' || '.jpg'
            then 'PASS  Switching away from a photo says the old photo can go' else 'FAIL  set_wallpaper old photo' end;
select t.ok(format($$select public.set_wallpaper(%L, null)$$, :'ab'), 'A removes the wallpaper');
select t.rows('select * from public.chat_wallpapers', 0, '...and it''s gone');
reset role;

\echo '--- Text messages still work'
select set_config('request.jwt.claim.sub', :'A', false); set role authenticated;
select t.ok(format($$insert into public.messages (conversation_id, body) values (%L, 'plain text')$$, :'ab'), 'Plain text messages are unaffected');
select t.fail(format($$insert into public.messages (conversation_id, body) values (%L, '   ')$$, :'ab'), 'Empty messages are still refused');
reset role;
