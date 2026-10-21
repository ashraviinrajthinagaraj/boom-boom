-- =====================================================================
--  Boom Boom — database setup
--  Run this ONCE in Supabase: SQL Editor → New query → paste all → Run.
--
--  What it creates:
--    profiles              one row per person (username + display name)
--    conversations         a chat (one-to-one now, groups later)
--    conversation_members  who is in each chat + when they last read it
--    messages              the messages themselves
--
--  Security model (the important part):
--    * Nobody who is logged out can read or write anything.
--    * Logged-in people can see the list of profiles (it's friends only).
--    * You can only see chats you are a member of, and only their messages.
--    * You can only send messages as yourself, into chats you're in.
--    * Nobody can add themselves to someone else's chat.
-- =====================================================================


-- ---------------------------------------------------------------------
--  Tables
-- ---------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null unique
               check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null
               check (char_length(btrim(display_name)) between 1 and 40),
  created_at   timestamptz not null default now()
);

create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  is_group        boolean not null default false,
  title           text,
  dm_key          text unique,          -- "<smaller id>:<larger id>" for one-to-one chats
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on public.conversation_members (user_id);

create table public.messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body            text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at      timestamptz not null default now()
);
create index messages_conversation_time_idx on public.messages (conversation_id, created_at desc);


-- ---------------------------------------------------------------------
--  Table permissions
--  Start from nothing, then allow only what the app needs. Column lists
--  stop people faking a sender or a timestamp.
-- ---------------------------------------------------------------------

revoke all on table public.profiles, public.conversations,
                    public.conversation_members, public.messages
  from anon, authenticated;

grant select                                 on public.profiles to authenticated;
grant insert (id, username, display_name)    on public.profiles to authenticated;
grant update (username, display_name)        on public.profiles to authenticated;

grant select                                 on public.conversations to authenticated;
grant select                                 on public.conversation_members to authenticated;

grant select                                 on public.messages to authenticated;
grant insert (conversation_id, body)         on public.messages to authenticated;


-- ---------------------------------------------------------------------
--  Helper: am I in this chat?
--  "security definer" lets the check read conversation_members without
--  tripping over its own security rule.
-- ---------------------------------------------------------------------

create or replace function public.is_member(conv uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversation_members m
    where m.conversation_id = conv
      and m.user_id = auth.uid()
  );
$$;


-- ---------------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------------

alter table public.profiles             enable row level security;
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;

create policy "Signed-in people can see profiles"
  on public.profiles for select to authenticated
  using (true);

create policy "You can create your own profile"
  on public.profiles for insert to authenticated
  with check (id = auth.uid());

create policy "You can edit your own profile"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "You can see chats you're in"
  on public.conversations for select to authenticated
  using (public.is_member(id));

create policy "You can see who is in your chats"
  on public.conversation_members for select to authenticated
  using (public.is_member(conversation_id));

create policy "You can read messages in your chats"
  on public.messages for select to authenticated
  using (public.is_member(conversation_id));

create policy "You can send messages as yourself into your chats"
  on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_member(conversation_id));


-- ---------------------------------------------------------------------
--  Start (or reopen) a one-to-one chat with someone
-- ---------------------------------------------------------------------

create or replace function public.get_or_create_dm(other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me   uuid := auth.uid();
  key  text;
  conv uuid;
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  if other_user is null or other_user = me then
    raise exception 'Pick someone else to message';
  end if;
  if not exists (select 1 from public.profiles where id = me) then
    raise exception 'Set up your profile first';
  end if;
  if not exists (select 1 from public.profiles where id = other_user) then
    raise exception 'That person does not exist';
  end if;

  key := least(me::text, other_user::text) || ':' || greatest(me::text, other_user::text);

  insert into public.conversations (is_group, dm_key, created_by)
  values (false, key, me)
  on conflict (dm_key) do nothing
  returning id into conv;

  if conv is null then
    select c.id into conv from public.conversations c where c.dm_key = key;
  end if;

  insert into public.conversation_members (conversation_id, user_id)
  values (conv, me), (conv, other_user)
  on conflict do nothing;

  return conv;
end;
$$;


-- ---------------------------------------------------------------------
--  Mark a chat as read (for unread badges)
-- ---------------------------------------------------------------------

create or replace function public.mark_read(conv uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.conversation_members
  set last_read_at = now()
  where conversation_id = conv
    and user_id = auth.uid();
$$;


-- ---------------------------------------------------------------------
--  Chat list: every chat I'm in, newest first, with last message and
--  unread count. Runs with the caller's permissions, so the security
--  rules above still apply.
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
    (select count(*)
       from public.messages x
      where x.conversation_id = c.id
        and x.created_at > me.last_read_at
        and x.sender_id <> auth.uid())
  from public.conversation_members me
  join public.conversations c on c.id = me.conversation_id
  left join lateral (
    select y.body, y.sender_id
      from public.messages y
     where y.conversation_id = c.id
     order by y.created_at desc, y.id desc
     limit 1
  ) lm on true
  where me.user_id = auth.uid()
    -- hide empty chats someone else opened with me but never wrote in
    and (c.last_message_at is not null or c.created_by = auth.uid())
  order by coalesce(c.last_message_at, c.created_at) desc;
$$;


-- ---------------------------------------------------------------------
--  When a message is sent: move the chat to the top, and count it as
--  read for the sender.
-- ---------------------------------------------------------------------

create or replace function public.on_new_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
     set last_message_at = new.created_at
   where id = new.conversation_id;

  update public.conversation_members
     set last_read_at = greatest(last_read_at, new.created_at)
   where conversation_id = new.conversation_id
     and user_id = new.sender_id;

  return new;
end;
$$;

create trigger messages_after_insert
  after insert on public.messages
  for each row execute function public.on_new_message();


-- ---------------------------------------------------------------------
--  Function permissions: signed-in people only
-- ---------------------------------------------------------------------

revoke all on function public.is_member(uuid)          from public, anon;
revoke all on function public.get_or_create_dm(uuid)   from public, anon;
revoke all on function public.mark_read(uuid)          from public, anon;
revoke all on function public.my_conversations()       from public, anon;
revoke all on function public.on_new_message()         from public, anon, authenticated;

grant execute on function public.is_member(uuid)        to authenticated;
grant execute on function public.get_or_create_dm(uuid) to authenticated;
grant execute on function public.mark_read(uuid)        to authenticated;
grant execute on function public.my_conversations()     to authenticated;


-- ---------------------------------------------------------------------
--  Live delivery: tell Supabase Realtime to stream new messages.
--  Realtime still applies the security rules, so each person only
--  receives messages from their own chats.
-- ---------------------------------------------------------------------

alter publication supabase_realtime add table public.messages;
