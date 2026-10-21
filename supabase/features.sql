-- =====================================================================
--  Boom Boom — photos, reactions, replies and unsend
--  Run this ONCE in Supabase (SQL Editor → New query → paste → Run),
--  after schema.sql and push.sql.
--
--  Photos live in a PRIVATE storage bucket. There are no public links:
--  a photo only loads for someone signed in who is in that chat.
-- =====================================================================


-- ---------------------------------------------------------------------
--  Messages: replies, photos, unsend
-- ---------------------------------------------------------------------

alter table public.messages
  add column reply_to         bigint references public.messages (id) on delete set null,
  add column photo_path       text,
  add column photo_thumb_path text,
  add column photo_width      int check (photo_width between 1 and 20000),
  add column photo_height     int check (photo_height between 1 and 20000),
  add column deleted_at       timestamptz;

-- A message needs text or a photo (a caption is optional). Unsent messages
-- keep only who sent them and when.
alter table public.messages alter column body set default '';
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages add constraint messages_content_check check (
  char_length(body) <= 4000
  and (deleted_at is not null or photo_path is not null or char_length(btrim(body)) >= 1)
);

-- Photos must sit in their own chat's folder, with the app's file names.
alter table public.messages add constraint messages_photo_check check (
  (photo_path is null) = (photo_thumb_path is null)
  and (photo_path is null
       or photo_path ~ ('^' || conversation_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp|gif)$'))
  and (photo_thumb_path is null
       or photo_thumb_path ~ ('^' || conversation_id::text || '/[0-9a-f-]{36}-thumb\.jpg$'))
);

grant insert (reply_to, photo_path, photo_thumb_path, photo_width, photo_height)
  on public.messages to authenticated;

-- Replies must point at a message in the same chat.
create or replace function public.check_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reply_to is not null and not exists (
    select 1 from public.messages r
    where r.id = new.reply_to and r.conversation_id = new.conversation_id
  ) then
    raise exception 'You can only reply to a message in the same chat';
  end if;
  return new;
end;
$$;
revoke all on function public.check_reply() from public, anon, authenticated;

create trigger messages_check_reply
  before insert on public.messages
  for each row execute function public.check_reply();


-- ---------------------------------------------------------------------
--  Unsend: removes the text and photo for everyone and leaves a
--  "message unsent" marker. Returns the photo files so the app can
--  delete them from storage (files can only be deleted through the
--  Storage API, not SQL).
-- ---------------------------------------------------------------------

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
         photo_width = null, photo_height = null, deleted_at = now()
   where id = p_message_id;

  -- Clear reactions with an update (not a delete), so the live update
  -- only reaches people in this chat.
  update public.message_reactions
     set emoji = null, updated_at = now()
   where message_id = p_message_id and emoji is not null;

  return query select m.photo_path, m.photo_thumb_path;
end;
$$;


-- ---------------------------------------------------------------------
--  Reactions: one per person per message, from a fixed set.
--  Removing a reaction sets it to null rather than deleting the row,
--  because Supabase Realtime only applies security rules to inserts and
--  updates, not deletes.
-- ---------------------------------------------------------------------

create table public.message_reactions (
  message_id      bigint not null references public.messages (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  emoji           text check (emoji in ('👍', '❤️', '😂', '😮', '😢', '🔥')),
  updated_at      timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index message_reactions_conversation_idx on public.message_reactions (conversation_id, message_id);

revoke all on table public.message_reactions from anon, authenticated;
grant select on public.message_reactions to authenticated;
alter table public.message_reactions enable row level security;

create policy "You can see reactions in your chats"
  on public.message_reactions for select to authenticated
  using (public.is_member(conversation_id));

-- React (or pass null to remove your reaction).
create or replace function public.react(p_message_id bigint, p_emoji text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  m public.messages;
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  select * into m from public.messages where id = p_message_id;
  if m.id is null or not public.is_member(m.conversation_id) then
    raise exception 'Message not found';
  end if;
  if m.deleted_at is not null then
    raise exception 'That message was unsent';
  end if;
  if p_emoji is not null and p_emoji not in ('👍', '❤️', '😂', '😮', '😢', '🔥') then
    raise exception 'That reaction isn''t available';
  end if;

  insert into public.message_reactions (message_id, user_id, conversation_id, emoji)
  values (p_message_id, me, m.conversation_id, p_emoji)
  on conflict (message_id, user_id)
  do update set emoji = excluded.emoji, updated_at = now();
end;
$$;


-- ---------------------------------------------------------------------
--  Chat list v2: also says whether the last message was a photo or was
--  unsent, and doesn't count unsent messages as unread.
-- ---------------------------------------------------------------------

drop function if exists public.my_conversations();

create function public.my_conversations()
returns table (
  conversation_id     uuid,
  is_group            boolean,
  title               text,
  other_user_id       uuid,
  last_message_at     timestamptz,
  last_message_body   text,
  last_message_sender uuid,
  last_message_kind   text,
  unread_count        bigint
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
    lm.body,
    lm.sender_id,
    case when lm.id is null then null
         when lm.deleted_at is not null then 'unsent'
         when lm.photo_path is not null then 'photo'
         else 'text' end,
    (select count(*)
       from public.messages x
      where x.conversation_id = c.id
        and x.created_at > me.last_read_at
        and x.sender_id <> auth.uid()
        and x.deleted_at is null)
  from public.conversation_members me
  join public.conversations c on c.id = me.conversation_id
  left join lateral (
    select y.id, y.body, y.sender_id, y.photo_path, y.deleted_at
      from public.messages y
     where y.conversation_id = c.id
     order by y.created_at desc, y.id desc
     limit 1
  ) lm on true
  where me.user_id = auth.uid()
    and (c.last_message_at is not null or c.created_by = auth.uid())
  order by coalesce(c.last_message_at, c.created_at) desc;
$$;


-- ---------------------------------------------------------------------
--  Photo storage: a private bucket, one folder per chat.
--  Files: <chat id>/<random id>.<jpg|png|webp|gif> plus a small
--  <chat id>/<random id>-thumb.jpg preview. Up to 50 MB each (the Free
--  plan's limit), so photos are kept at full quality.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Which chat a file belongs to (null if the name isn't a chat folder).
create or replace function public.photo_chat_id(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(object_name, '/', 1)::uuid
  end;
$$;

create policy "Boom Boom: people in a chat can see its photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member(public.photo_chat_id(name)));

create policy "Boom Boom: people in a chat can add photos to it"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'photos'
    and public.is_member(public.photo_chat_id(name))
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}(\.(jpg|png|webp|gif)|-thumb\.jpg)$'
  );

create policy "Boom Boom: you can delete photos you uploaded"
  on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and owner_id = (select auth.uid()::text));


-- ---------------------------------------------------------------------
--  Permissions and live updates
-- ---------------------------------------------------------------------

revoke all on function public.unsend_message(bigint)  from public, anon;
revoke all on function public.react(bigint, text)      from public, anon;
revoke all on function public.my_conversations()       from public, anon;
revoke all on function public.photo_chat_id(text)      from public, anon;
grant execute on function public.unsend_message(bigint) to authenticated;
grant execute on function public.react(bigint, text)     to authenticated;
grant execute on function public.my_conversations()      to authenticated;
grant execute on function public.photo_chat_id(text)     to authenticated;

grant select on public.message_reactions to service_role;

alter publication supabase_realtime add table public.message_reactions;
