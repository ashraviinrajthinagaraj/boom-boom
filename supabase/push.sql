-- =====================================================================
--  Boom Boom — notifications
--  Run this ONCE in Supabase (SQL Editor → New query → paste → Run),
--  after schema.sql. Then deploy the send-push function (see README).
--
--  How it works:
--    1. Each phone/computer that turns notifications on saves a "push
--       subscription" (an address only that device's browser can receive at).
--    2. Every new message pings the send-push Edge Function with just the
--       message id.
--    3. The function looks the message up itself, encrypts a notification
--       for every device of everyone else in that chat, and sends it.
--  The function never trusts what it's sent: it only acts on real, recent
--  messages, and only once per message.
-- =====================================================================

-- Lets the database make web requests (to call the function).
create extension if not exists pg_net with schema extensions;


-- ---------------------------------------------------------------------
--  Devices that want notifications
-- ---------------------------------------------------------------------

create table public.push_subscriptions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint    text not null unique check (endpoint like 'https://%' and char_length(endpoint) <= 1000),
  p256dh      text not null check (char_length(p256dh) between 40 and 200),
  auth        text not null check (char_length(auth) between 10 and 100),
  user_agent  text check (char_length(user_agent) <= 300),
  created_at  timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- One row per message that has had its notifications sent (stops repeats).
create table public.push_log (
  message_id bigint primary key references public.messages (id) on delete cascade,
  sent_at    timestamptz not null default now()
);


-- ---------------------------------------------------------------------
--  Permissions
--  People can see and remove their own devices. Saving goes through
--  save_push_subscription() below. The log is for the server only.
-- ---------------------------------------------------------------------

revoke all on table public.push_subscriptions, public.push_log from anon, authenticated;
grant select, delete on public.push_subscriptions to authenticated;

alter table public.push_subscriptions enable row level security;
alter table public.push_log           enable row level security;

create policy "You can see your own devices"
  on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

create policy "You can remove your own devices"
  on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

-- The send-push function signs in with the server key ("service_role").
grant select, insert, delete on public.push_subscriptions, public.push_log to service_role;
grant select on public.messages, public.conversation_members, public.profiles, public.conversations to service_role;


-- ---------------------------------------------------------------------
--  Save this device for notifications
--  If the same device was used by another account before (shared phone),
--  it now belongs to whoever is signed in. Keeps the 10 newest devices
--  per person.
-- ---------------------------------------------------------------------

create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null
)
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

  delete from public.push_subscriptions where endpoint = p_endpoint;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (me, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300));

  delete from public.push_subscriptions
  where user_id = me
    and id not in (
      select id from public.push_subscriptions
      where user_id = me
      order by created_at desc, id desc
      limit 10
    );
end;
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;


-- ---------------------------------------------------------------------
--  On every new message, ask the send-push function to notify people.
--  If anything about notifications fails, the message still sends.
-- ---------------------------------------------------------------------

create or replace function public.notify_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform net.http_post(
      -- Your project's send-push function. Change this if you ever move
      -- Boom Boom to a different Supabase project.
      url     := 'https://obzxdtgfsyidbnjwpmub.supabase.co/functions/v1/send-push',
      body    := jsonb_build_object('message_id', new.id),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 8000
    );
  exception when others then
    raise warning 'Boom Boom: notification skipped (%)', sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.notify_push() from public, anon, authenticated;

create trigger messages_notify_push
  after insert on public.messages
  for each row execute function public.notify_push();
