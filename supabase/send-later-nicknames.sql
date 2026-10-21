-- =====================================================================
--  Boom Boom — send later and nicknames
--  Run this ONCE in Supabase (SQL Editor → New query → paste → Run),
--  after chat-extras.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
--  Send later
--  Scheduled messages wait here, visible only to the person who wrote
--  them. Every minute the database sends any that are due, so they go
--  out even if your phone is off. Once sent (or cancelled) the waiting
--  copy of the text is wiped.
-- ---------------------------------------------------------------------

create table public.scheduled_messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body            text not null check (char_length(body) <= 4000),
  reply_to        bigint references public.messages (id) on delete set null,
  send_at         timestamptz not null,
  status          text not null default 'waiting' check (status in ('waiting', 'sent', 'cancelled')),
  message_id      bigint references public.messages (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index scheduled_messages_due_idx on public.scheduled_messages (status, send_at);
create index scheduled_messages_sender_idx on public.scheduled_messages (sender_id);

revoke all on table public.scheduled_messages from anon, authenticated;
grant select on public.scheduled_messages to authenticated;
alter table public.scheduled_messages enable row level security;

create policy "You can see your own scheduled messages"
  on public.scheduled_messages for select to authenticated
  using (sender_id = auth.uid());

-- Schedule a message (returns its id).
create or replace function public.schedule_message(conv uuid, p_body text, p_send_at timestamptz, p_reply_to bigint default null)
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
  if not public.is_member(conv) then
    raise exception 'Chat not found';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 4000 then
    raise exception 'A message needs 1 to 4,000 characters';
  end if;
  if p_send_at is null or p_send_at <= now() then
    raise exception 'Pick a time in the future';
  end if;
  if p_send_at > now() + interval '366 days' then
    raise exception 'Messages can be scheduled up to a year ahead';
  end if;
  if (select count(*) from public.scheduled_messages where sender_id = me and status = 'waiting') >= 25 then
    raise exception 'You can have up to 25 scheduled messages at a time';
  end if;
  if p_reply_to is not null and not exists (
    select 1 from public.messages r where r.id = p_reply_to and r.conversation_id = conv
  ) then
    raise exception 'You can only reply to a message in the same chat';
  end if;

  insert into public.scheduled_messages (conversation_id, sender_id, body, reply_to, send_at)
  values (conv, me, p_body, p_reply_to, p_send_at)
  returning id into new_id;
  return new_id;
end;
$$;

-- Send one waiting message now (used by the timer and by "Send now").
create or replace function public.send_scheduled_row(p_id bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.scheduled_messages;
  new_message bigint;
begin
  select * into s from public.scheduled_messages where id = p_id and status = 'waiting' for update skip locked;
  if s.id is null then
    return null;
  end if;
  if not exists (
    select 1 from public.conversation_members
    where conversation_id = s.conversation_id and user_id = s.sender_id
  ) then
    update public.scheduled_messages set status = 'cancelled', body = '' where id = s.id;
    return null;
  end if;

  insert into public.messages (conversation_id, sender_id, body, reply_to)
  values (s.conversation_id, s.sender_id, s.body, s.reply_to)
  returning id into new_message;

  update public.scheduled_messages
     set status = 'sent', message_id = new_message, body = ''
   where id = s.id;
  return new_message;
end;
$$;

-- Runs every minute: sends everything that's due.
create or replace function public.deliver_scheduled()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  due bigint;
  sent integer := 0;
begin
  for due in
    select id from public.scheduled_messages
     where status = 'waiting' and send_at <= now()
     order by send_at, id
     limit 200
  loop
    if public.send_scheduled_row(due) is not null then
      sent := sent + 1;
    end if;
  end loop;
  return sent;
end;
$$;

create or replace function public.send_scheduled_now(p_id bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.scheduled_messages where id = p_id and sender_id = auth.uid() and status = 'waiting') then
    raise exception 'That scheduled message isn''t waiting any more';
  end if;
  return public.send_scheduled_row(p_id);
end;
$$;

-- Cancel a waiting message. Returns false if it had already gone out.
create or replace function public.cancel_scheduled(p_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with cancelled as (
    update public.scheduled_messages
       set status = 'cancelled', body = ''
     where id = p_id and sender_id = auth.uid() and status = 'waiting'
    returning 1
  )
  select exists (select 1 from cancelled);
$$;

revoke all on function public.schedule_message(uuid, text, timestamptz, bigint) from public, anon;
revoke all on function public.send_scheduled_row(bigint)  from public, anon, authenticated;
revoke all on function public.deliver_scheduled()         from public, anon, authenticated;
revoke all on function public.send_scheduled_now(bigint)  from public, anon;
revoke all on function public.cancel_scheduled(bigint)    from public, anon;
grant execute on function public.schedule_message(uuid, text, timestamptz, bigint) to authenticated;
grant execute on function public.send_scheduled_now(bigint) to authenticated;
grant execute on function public.cancel_scheduled(bigint)   to authenticated;

-- Your other devices see when a scheduled message goes out or is cancelled.
alter publication supabase_realtime add table public.scheduled_messages;

-- The every-minute timer (Supabase Cron), plus a daily tidy-up of its
-- run log so it doesn't slowly fill the free database.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('boom-send-later', '* * * * *', $$select public.deliver_scheduled()$$);
select cron.schedule('boom-tidy-cron-log', '17 4 * * *', $$delete from cron.job_run_details where end_time < now() - interval '2 days'$$);


-- ---------------------------------------------------------------------
--  Nicknames: rename a friend just for you. Nobody else can see them.
-- ---------------------------------------------------------------------

create table public.nicknames (
  owner_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  target_id uuid not null references auth.users (id) on delete cascade,
  nickname  text not null check (char_length(btrim(nickname)) between 1 and 40),
  primary key (owner_id, target_id)
);

revoke all on table public.nicknames from anon, authenticated;
grant select on public.nicknames to authenticated;
alter table public.nicknames enable row level security;

create policy "You can see your own nicknames"
  on public.nicknames for select to authenticated
  using (owner_id = auth.uid());

-- Set a nickname, or pass null/blank to remove it.
create or replace function public.set_nickname(p_target uuid, p_nickname text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Not signed in';
  end if;
  if p_nickname is null or char_length(btrim(p_nickname)) = 0 then
    delete from public.nicknames where owner_id = me and target_id = p_target;
    return;
  end if;
  if p_target = me or not exists (select 1 from public.profiles where id = p_target) then
    raise exception 'Pick a friend to nickname';
  end if;
  if char_length(btrim(p_nickname)) > 40 then
    raise exception 'Nicknames can be up to 40 characters';
  end if;
  insert into public.nicknames (owner_id, target_id, nickname)
  values (me, p_target, btrim(p_nickname))
  on conflict (owner_id, target_id) do update set nickname = excluded.nickname;
end;
$$;

revoke all on function public.set_nickname(uuid, text) from public, anon;
grant execute on function public.set_nickname(uuid, text) to authenticated;
