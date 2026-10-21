-- =====================================================================
--  Boom Boom — profile pictures and "delete chat"
--  Run this ONCE in Supabase (SQL Editor → New query → paste → Run),
--  after features.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
--  Profile pictures
--  Stored in a PRIVATE bucket: only signed-in Boom Boom members can see
--  them. Each person can only upload into, and delete from, their own
--  folder: avatars/<their user id>/<random id>.jpg
-- ---------------------------------------------------------------------

alter table public.profiles add column avatar_path text;
alter table public.profiles add constraint profiles_avatar_check check (
  avatar_path is null or avatar_path ~ ('^' || id::text || '/[0-9a-f-]{36}\.jpg$')
);
grant update (avatar_path) on public.profiles to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "Boom Boom: signed-in people can see profile pictures"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars');

create policy "Boom Boom: you can upload your own profile picture"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and name ~ ('^' || (select auth.uid()::text) || '/[0-9a-f-]{36}\.jpg$')
  );

create policy "Boom Boom: you can delete your own profile pictures"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and owner_id = (select auth.uid()::text));

-- Friends see a new picture or name straight away.
alter publication supabase_realtime add table public.profiles;


-- ---------------------------------------------------------------------
--  Delete chat (for you)
--  Hides the chat and everything in it from YOUR Boom Boom. The other
--  person keeps their copy. If they message you again, the chat comes
--  back with only the new messages.
-- ---------------------------------------------------------------------

alter table public.conversation_members add column cleared_at timestamptz;

create or replace function public.delete_chat(conv uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.conversation_members
     set cleared_at = now(), last_read_at = greatest(last_read_at, now())
   where conversation_id = conv
     and user_id = auth.uid();
$$;

revoke all on function public.delete_chat(uuid) from public, anon;
grant execute on function public.delete_chat(uuid) to authenticated;


-- ---------------------------------------------------------------------
--  Chat list v3: leaves out what you've deleted.
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
        and x.created_at > coalesce(me.cleared_at, '-infinity')
        and x.sender_id <> auth.uid()
        and x.deleted_at is null),
    me.cleared_at
  from public.conversation_members me
  join public.conversations c on c.id = me.conversation_id
  left join lateral (
    select y.id, y.body, y.sender_id, y.photo_path, y.deleted_at
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

revoke all on function public.my_conversations() from public, anon;
grant execute on function public.my_conversations() to authenticated;
