-- =====================================================================
--  Boom Boom — typing, edit, chat colours and CPR
--  Run this ONCE in Supabase (SQL Editor → New query → paste → Run),
--  after avatars-and-delete.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
--  "typing…"
--  Sent over private live channels named typing:<chat id>. Only people
--  in that chat can listen or send, and the signal carries nothing but
--  who is typing. Each person can switch it off for themselves.
-- ---------------------------------------------------------------------

alter table public.profiles add column share_typing boolean not null default true;
grant update (share_typing) on public.profiles to authenticated;

create or replace function public.typing_chat_id(topic text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when topic ~ '^typing:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then substr(topic, 8)::uuid
  end;
$$;
revoke all on function public.typing_chat_id(text) from public, anon;
grant execute on function public.typing_chat_id(text) to authenticated;

create policy "Boom Boom: people in a chat can see who's typing"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and public.is_member(public.typing_chat_id((select realtime.topic())))
  );

create policy "Boom Boom: people in a chat can say they're typing"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and public.is_member(public.typing_chat_id((select realtime.topic())))
  );


-- ---------------------------------------------------------------------
--  Edit: your own text messages, for 15 minutes after sending.
--  The old wording is replaced, not kept. Edits don't send notifications.
-- ---------------------------------------------------------------------

alter table public.messages add column edited_at timestamptz;

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
  if m.created_at < now() - interval '15 minutes' then
    raise exception 'Messages can only be edited for 15 minutes after sending';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 4000 then
    raise exception 'A message needs 1 to 4,000 characters';
  end if;
  update public.messages set body = p_body, edited_at = now() where id = p_message_id;
end;
$$;
revoke all on function public.edit_message(bigint, text) from public, anon;
grant execute on function public.edit_message(bigint, text) to authenticated;


-- ---------------------------------------------------------------------
--  Chat colours: one per chat, and both people see the same one.
-- ---------------------------------------------------------------------

alter table public.conversations add column theme text
  check (theme in ('hibiscus', 'ocean', 'jungle', 'sunset', 'grape', 'indigo', 'rose', 'teal'));

create or replace function public.set_chat_theme(conv uuid, p_theme text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_member(conv) then
    raise exception 'Chat not found';
  end if;
  update public.conversations set theme = p_theme where id = conv;
end;
$$;
revoke all on function public.set_chat_theme(uuid, text) from public, anon;
grant execute on function public.set_chat_theme(uuid, text) to authenticated;

-- So a new colour shows up on the other phone straight away.
alter publication supabase_realtime add table public.conversations;


-- ---------------------------------------------------------------------
--  CPR: a tiny check-in that keeps the free Supabase project from
--  pausing during quiet weeks. A scheduled GitHub job calls cpr() every
--  3 days (.github/workflows/cpr.yml). It only records the time.
-- ---------------------------------------------------------------------

create table public.cpr_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now()
);
alter table public.cpr_log enable row level security;
revoke all on table public.cpr_log from anon, authenticated;

create or replace function public.cpr()
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- At most one entry an hour, and only the latest 30 are kept.
  if not exists (select 1 from public.cpr_log where at > now() - interval '1 hour') then
    insert into public.cpr_log default values;
    delete from public.cpr_log
     where id not in (select id from public.cpr_log order by id desc limit 30);
  end if;
  return 'Boom Boom is alive';
end;
$$;
revoke all on function public.cpr() from public;
grant execute on function public.cpr() to anon, authenticated;
