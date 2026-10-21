-- =====================================================================
--  Boom Boom — albums, files, stickers and chat wallpapers
--  Run this ONCE in Supabase (SQL Editor → New query → paste → Run),
--  after send-later-nicknames.sql.
--
--  Every new kind of file lives in a PRIVATE storage bucket, with no
--  public links:
--    files       only the people in that chat
--    stickers    signed-in Boom Boom members (so stickers you send show up)
--    wallpapers  only you
-- =====================================================================


-- ---------------------------------------------------------------------
--  Messages: albums, files and stickers
-- ---------------------------------------------------------------------

alter table public.messages
  add column album        jsonb,
  add column file_path    text,
  add column file_name    text,
  add column file_size    bigint,
  add column file_type    text,
  add column sticker_path text;

-- An album is 2 to 10 photos from this chat's folder. The first one is
-- also stored in photo_path, so it doubles as the cover.
create or replace function public.valid_album(conv uuid, a jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
  folder text := conv::text || '/';
begin
  if a is null or jsonb_typeof(a) <> 'array' or jsonb_array_length(a) not between 2 and 10 then
    return false;
  end if;
  if (select count(distinct x->>'path') from jsonb_array_elements(a) x) <> jsonb_array_length(a) then
    return false; -- the same photo twice
  end if;
  for item in select x from jsonb_array_elements(a) x loop
    if jsonb_typeof(item) <> 'object'
       or (select count(*) from jsonb_object_keys(item)) <> 4
       or coalesce(item->>'path', '') !~ ('^' || folder || '[0-9a-f-]{36}\.(jpg|png|webp|gif)$')
       or coalesce(item->>'thumb', '') !~ ('^' || folder || '[0-9a-f-]{36}-thumb\.jpg$')
       or coalesce(jsonb_typeof(item->'width'), '') <> 'number'
       or coalesce(jsonb_typeof(item->'height'), '') <> 'number'
       or coalesce(item->>'width', '') !~ '^[1-9][0-9]{0,4}$'
       or coalesce(item->>'height', '') !~ '^[1-9][0-9]{0,4}$' then
      return false;
    end if;
    if (item->>'width')::int > 20000 or (item->>'height')::int > 20000 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

alter table public.messages add constraint messages_album_check check (
  album is null
  or (photo_path is not null
      and public.valid_album(conversation_id, album)
      and album->0->>'path' = photo_path
      and album->0->>'thumb' = photo_thumb_path)
);

-- Files: up to 25 MB, kept in this chat's folder under a random name. The
-- real file name is only stored here (no slashes or control characters).
alter table public.messages add constraint messages_file_check check (
  (file_path is null) = (file_name is null)
  and (file_path is null) = (file_size is null)
  and (file_path is null or (
        file_path ~ ('^' || conversation_id::text || '/[0-9a-f-]{36}$')
        and char_length(file_name) between 1 and 200
        and file_name !~ '[[:cntrl:]/\\]'
        and file_size between 1 and 26214400))
  and (file_type is null
       or (file_path is not null and file_type ~ '^[a-z0-9][a-z0-9.+-]{0,60}/[a-z0-9][a-z0-9.+-]{0,60}$'))
  and (sticker_path is null or sticker_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|png)$')
  and num_nonnulls(photo_path, file_path, sticker_path) <= 1
);

-- A message now needs text, a photo, a file or a sticker.
alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages add constraint messages_content_check check (
  char_length(body) <= 4000
  and (deleted_at is not null or photo_path is not null or file_path is not null
       or sticker_path is not null or char_length(btrim(body)) >= 1)
);

grant insert (album, file_path, file_name, file_size, file_type, sticker_path)
  on public.messages to authenticated;

-- A sticker message must use a sticker that really exists.
create or replace function public.check_sticker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sticker_path is not null and not exists (
    select 1 from storage.objects o where o.bucket_id = 'stickers' and o.name = new.sticker_path
  ) then
    raise exception 'That sticker doesn''t exist';
  end if;
  return new;
end;
$$;
revoke all on function public.check_sticker() from public, anon, authenticated;

create trigger messages_check_sticker
  before insert on public.messages
  for each row execute function public.check_sticker();


-- ---------------------------------------------------------------------
--  Unsend and edit, updated for the new kinds of message
-- ---------------------------------------------------------------------

-- Unsend clears everything and returns the photo files (every photo of an
-- album) so the app can delete them. The app deletes a sent file itself.
create or replace function public.unsend_message(p_message_id bigint)
returns table (photo_path text, photo_thumb_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages;
begin
  select * into m from public.messages where id = p_message_id for update;
  if m.id is null or m.sender_id is distinct from auth.uid() then
    raise exception 'You can only unsend your own messages';
  end if;
  if m.deleted_at is not null then
    return;
  end if;

  update public.messages
     set body = '', photo_path = null, photo_thumb_path = null,
         photo_width = null, photo_height = null, album = null,
         file_path = null, file_name = null, file_size = null, file_type = null,
         sticker_path = null, deleted_at = now()
   where id = p_message_id;

  update public.message_reactions
     set emoji = null, updated_at = now()
   where message_id = p_message_id and emoji is not null;

  if m.album is not null then
    return query select x->>'path', x->>'thumb' from jsonb_array_elements(m.album) x;
  else
    return query select m.photo_path, m.photo_thumb_path;
  end if;
end;
$$;

create or replace function public.edit_message(p_message_id bigint, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages;
begin
  select * into m from public.messages where id = p_message_id for update;
  if m.id is null or m.sender_id is distinct from auth.uid() then
    raise exception 'You can only edit your own messages';
  end if;
  if m.deleted_at is not null then
    raise exception 'That message was unsent';
  end if;
  if m.photo_path is not null then
    raise exception 'Photos can''t be edited';
  end if;
  if m.file_path is not null or m.sticker_path is not null then
    raise exception 'Only text messages can be edited';
  end if;
  if m.created_at < now() - interval '15 minutes' then
    raise exception 'Messages can only be edited for 15 minutes after sending';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 4000 then
    raise exception 'A message needs 1 to 4,000 characters';
  end if;
  update public.messages set body = p_body, edited_at = now() where id = p_message_id;
end;
$$;


-- ---------------------------------------------------------------------
--  Chat list v4: knows about albums, files and stickers. For a file, the
--  preview text is the file's name.
-- ---------------------------------------------------------------------

create or replace function public.my_conversations()
returns table (
  conversation_id     uuid,
  is_group            boolean,
  title               text,
  other_user_id       uuid,
  last_message_at     timestamptz,
  last_message_body   text,
  last_message_sender uuid,
  last_message_kind   text,
  unread_count        bigint,
  cleared_at          timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    c.id,
    c.is_group,
    c.title,
    (select m2.user_id
       from public.conversation_members m2
      where m2.conversation_id = c.id
        and m2.user_id <> auth.uid()
      limit 1),
    c.last_message_at,
    case when lm.file_path is not null then lm.file_name else lm.body end,
    lm.sender_id,
    case when lm.id is null then null
         when lm.deleted_at is not null then 'unsent'
         when lm.album is not null then 'album'
         when lm.photo_path is not null then 'photo'
         when lm.file_path is not null then 'file'
         when lm.sticker_path is not null then 'sticker'
         else 'text' end,
    (select count(*)
       from public.messages x
      where x.conversation_id = c.id
        and x.created_at > me.last_read_at
        and x.created_at > coalesce(me.cleared_at, '-infinity')
        and x.sender_id <> auth.uid()
        and x.deleted_at is null),
    me.cleared_at
  from public.conversation_members me
  join public.conversations c on c.id = me.conversation_id
  left join lateral (
    select y.id, y.body, y.sender_id, y.photo_path, y.album, y.file_path, y.file_name, y.sticker_path, y.deleted_at
      from public.messages y
     where y.conversation_id = c.id
       and y.created_at > coalesce(me.cleared_at, '-infinity')
     order by y.created_at desc, y.id desc
     limit 1
  ) lm on true
  where me.user_id = auth.uid()
    and (lm.id is not null or (me.cleared_at is null and c.created_by = auth.uid()))
  order by coalesce(c.last_message_at, c.created_at) desc;
$$;


-- ---------------------------------------------------------------------
--  File storage: <chat id>/<random id>, up to 25 MB, any type.
--  Only people in that chat can download them.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('files', 'files', false, 26214400, null)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "Boom Boom: people in a chat can see its files"
  on storage.objects for select to authenticated
  using (bucket_id = 'files' and public.is_member(public.photo_chat_id(name)));

create policy "Boom Boom: people in a chat can add files to it"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'files'
    and public.is_member(public.photo_chat_id(name))
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}$'
  );

create policy "Boom Boom: you can delete files you uploaded"
  on storage.objects for delete to authenticated
  using (bucket_id = 'files' and owner_id = (select auth.uid()::text));


-- ---------------------------------------------------------------------
--  Stickers: made from your own photos, 512×512, kept in your folder.
--  Your sticker tray is your own list; you can also save a friend's.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stickers', 'stickers', false, 1048576, array['image/webp', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "Boom Boom: signed-in people can see stickers"
  on storage.objects for select to authenticated
  using (bucket_id = 'stickers');

create policy "Boom Boom: you can add stickers to your own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'stickers'
    and name ~ ('^' || (select auth.uid()::text) || '/[0-9a-f-]{36}\.(webp|png)$')
  );

create policy "Boom Boom: you can delete your own sticker files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'stickers' and owner_id = (select auth.uid()::text));

create table public.stickers (
  id         bigint generated always as identity primary key,
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  path       text not null check (path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(webp|png)$'),
  created_at timestamptz not null default now(),
  unique (owner_id, path)
);

revoke all on table public.stickers from anon, authenticated;
grant select on public.stickers to authenticated;
alter table public.stickers enable row level security;

create policy "You can see your own sticker tray"
  on public.stickers for select to authenticated
  using (owner_id = auth.uid());

-- Add a sticker (yours or a friend's) to your tray. Returns its id.
create or replace function public.add_sticker(p_path text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  new_id bigint;
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  if p_path is null or not exists (
    select 1 from storage.objects o where o.bucket_id = 'stickers' and o.name = p_path
  ) then
    raise exception 'That sticker doesn''t exist';
  end if;
  select id into new_id from public.stickers where owner_id = me and path = p_path;
  if new_id is not null then
    return new_id; -- already in your tray
  end if;
  if (select count(*) from public.stickers where owner_id = me) >= 200 then
    raise exception 'Your tray is full (200 stickers). Remove some first';
  end if;
  insert into public.stickers (owner_id, path) values (me, p_path) returning id into new_id;
  return new_id;
end;
$$;

-- Take a sticker out of your tray. Returns its file name if the file is
-- yours and nobody uses it any more (so the app can delete it); stickers
-- already sent in a chat keep their file.
create or replace function public.remove_sticker(p_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  gone public.stickers;
begin
  delete from public.stickers where id = p_id and owner_id = me returning * into gone;
  if gone.id is null then
    return null;
  end if;
  if split_part(gone.path, '/', 1) = me::text
     and not exists (select 1 from public.stickers s where s.path = gone.path)
     and not exists (select 1 from public.messages m where m.sticker_path = gone.path) then
    return gone.path;
  end if;
  return null;
end;
$$;


-- ---------------------------------------------------------------------
--  Chat wallpapers: just for you, per chat. A built-in pattern, or a
--  photo of yours that only you can see.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wallpapers', 'wallpapers', false, 3145728, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "Boom Boom: only you can see your wallpapers"
  on storage.objects for select to authenticated
  using (bucket_id = 'wallpapers' and split_part(name, '/', 1) = (select auth.uid()::text));

create policy "Boom Boom: you can add wallpapers to your own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'wallpapers'
    and name ~ ('^' || (select auth.uid()::text) || '/[0-9a-f-]{36}\.jpg$')
  );

create policy "Boom Boom: you can delete your own wallpapers"
  on storage.objects for delete to authenticated
  using (bucket_id = 'wallpapers' and owner_id = (select auth.uid()::text));

create table public.chat_wallpapers (
  owner_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  wallpaper       text not null check (wallpaper ~ '^(pattern:[a-z]{2,20}|photo:[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg)$'),
  updated_at      timestamptz not null default now(),
  primary key (owner_id, conversation_id)
);

revoke all on table public.chat_wallpapers from anon, authenticated;
grant select on public.chat_wallpapers to authenticated;
alter table public.chat_wallpapers enable row level security;

create policy "You can see your own wallpapers"
  on public.chat_wallpapers for select to authenticated
  using (owner_id = auth.uid());

-- Set (or with null, remove) your wallpaper for a chat. Returns a photo of
-- yours that's no longer used anywhere, so the app can delete it.
create or replace function public.set_wallpaper(conv uuid, p_wallpaper text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  old text;
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  if not public.is_member(conv) then
    raise exception 'Chat not found';
  end if;
  select wallpaper into old from public.chat_wallpapers where owner_id = me and conversation_id = conv;

  if p_wallpaper is null or p_wallpaper = '' then
    delete from public.chat_wallpapers where owner_id = me and conversation_id = conv;
  else
    if p_wallpaper !~ '^(pattern:[a-z]{2,20}|photo:[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg)$'
       or (p_wallpaper like 'photo:%' and split_part(substr(p_wallpaper, 7), '/', 1) <> me::text) then
      raise exception 'That wallpaper isn''t available';
    end if;
    insert into public.chat_wallpapers (owner_id, conversation_id, wallpaper)
    values (me, conv, p_wallpaper)
    on conflict (owner_id, conversation_id)
    do update set wallpaper = excluded.wallpaper, updated_at = now();
  end if;

  if old like 'photo:%' and old is distinct from p_wallpaper
     and not exists (select 1 from public.chat_wallpapers w where w.owner_id = me and w.wallpaper = old) then
    return substr(old, 7);
  end if;
  return null;
end;
$$;


-- ---------------------------------------------------------------------
--  Permissions
-- ---------------------------------------------------------------------

revoke all on function public.valid_album(uuid, jsonb)      from public, anon;
revoke all on function public.unsend_message(bigint)         from public, anon;
revoke all on function public.edit_message(bigint, text)     from public, anon;
revoke all on function public.my_conversations()             from public, anon;
revoke all on function public.add_sticker(text)              from public, anon;
revoke all on function public.remove_sticker(bigint)         from public, anon;
revoke all on function public.set_wallpaper(uuid, text)      from public, anon;
grant execute on function public.valid_album(uuid, jsonb)    to authenticated, service_role;
grant execute on function public.unsend_message(bigint)       to authenticated;
grant execute on function public.edit_message(bigint, text)   to authenticated;
grant execute on function public.my_conversations()           to authenticated;
grant execute on function public.add_sticker(text)            to authenticated;
grant execute on function public.remove_sticker(bigint)       to authenticated;
grant execute on function public.set_wallpaper(uuid, text)    to authenticated;
