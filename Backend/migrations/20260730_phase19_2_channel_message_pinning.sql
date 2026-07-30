-- Phase 19.2: channel-scoped message pinning.
-- Review and run manually in the Supabase SQL Editor.
-- This migration does not modify message deletion, attachments, or RAG data.

begin;

do $$
begin
  if to_regclass('public.pinned_messages') is not null then
    raise exception 'public.pinned_messages already exists; inspect it before running Phase 19.2';
  end if;

  if to_regclass('public.messages') is null
     or to_regclass('public.message_attachments') is null
     or to_regclass('public.channels') is null
     or to_regclass('public.servers') is null
     or to_regclass('public.server_members') is null
     or to_regclass('public.profiles') is null then
    raise exception 'Phase 19.2 requires the existing message and server membership tables';
  end if;

  if to_regprocedure('public.is_server_member(uuid,uuid)') is null
     or to_regprocedure('public.can_manage_server(uuid,uuid)') is null then
    raise exception 'Phase 19.2 requires the Phase 14 authorization helpers';
  end if;

  if exists (
    select 1
    from public.messages as message
    join public.channels as channel
      on channel.id = message.channel_id
    where message.server_id is distinct from channel.server_id
  ) then
    raise exception 'messages contains a channel/server mismatch; repair it before running Phase 19.2';
  end if;

  if not exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    raise exception 'supabase_realtime publication does not exist';
  end if;
end $$;

-- Close the pre-existing message/channel integrity gap before a pin can
-- reference those values as canonical scope.
alter table public.channels
  add constraint channels_id_server_key
  unique (id, server_id);

alter table public.messages
  add constraint messages_channel_server_fk
  foreign key (channel_id, server_id)
  references public.channels(id, server_id)
  on delete cascade;

alter table public.messages
  add constraint messages_id_server_channel_key
  unique (id, server_id, channel_id);

create table public.pinned_messages (
  message_id uuid primary key,
  server_id uuid not null,
  channel_id uuid not null,
  pinned_by uuid
    references public.profiles(id)
    on delete set null,
  pinned_at timestamptz not null default now(),
  constraint pinned_messages_message_scope_fk
    foreign key (message_id, server_id, channel_id)
    references public.messages(id, server_id, channel_id)
    on delete cascade,
  constraint pinned_messages_channel_scope_fk
    foreign key (channel_id, server_id)
    references public.channels(id, server_id)
    on delete cascade,
  constraint pinned_messages_server_fk
    foreign key (server_id)
    references public.servers(id)
    on delete cascade
);

create index idx_pinned_messages_channel_pinned_at
  on public.pinned_messages(channel_id, pinned_at desc, message_id);

alter table public.pinned_messages enable row level security;
alter table public.pinned_messages replica identity full;

create policy "pinned_messages_select_for_members"
on public.pinned_messages
for select
to authenticated
using (public.is_server_member(server_id, auth.uid()));

revoke all on table public.pinned_messages from anon, authenticated;
grant select on table public.pinned_messages to authenticated;

create or replace function public.pin_channel_message(
  p_message_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_message record;
  v_pin public.pinned_messages%rowtype;
begin
  if v_actor_id is null then
    raise exception 'pin authentication required'
      using errcode = '42501';
  end if;

  select
    message.id,
    message.server_id,
    message.channel_id,
    channel.server_id as channel_server_id
  into v_message
  from public.messages as message
  join public.channels as channel
    on channel.id = message.channel_id
  where message.id = p_message_id
  for update of message;

  if not found then
    raise exception 'pin message not found'
      using errcode = 'P0002';
  end if;

  if v_message.server_id is distinct from v_message.channel_server_id then
    raise exception 'pin message and channel scope do not match'
      using errcode = '23514';
  end if;

  if not public.can_manage_server(v_message.server_id, v_actor_id) then
    raise exception 'pinning requires owner or admin'
      using errcode = '42501';
  end if;

  insert into public.pinned_messages (
    message_id,
    server_id,
    channel_id,
    pinned_by
  )
  values (
    v_message.id,
    v_message.server_id,
    v_message.channel_id,
    v_actor_id
  )
  on conflict (message_id) do nothing;

  select pin.*
  into v_pin
  from public.pinned_messages as pin
  where pin.message_id = v_message.id;

  return jsonb_build_object(
    'message_id', v_pin.message_id,
    'server_id', v_pin.server_id,
    'channel_id', v_pin.channel_id,
    'pinned_at', v_pin.pinned_at
  );
end;
$$;

create or replace function public.unpin_channel_message(
  p_message_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_message record;
begin
  if v_actor_id is null then
    raise exception 'pin authentication required'
      using errcode = '42501';
  end if;

  select
    message.id,
    message.server_id,
    message.channel_id,
    channel.server_id as channel_server_id
  into v_message
  from public.messages as message
  join public.channels as channel
    on channel.id = message.channel_id
  where message.id = p_message_id
  for update of message;

  -- A repeated unpin after message deletion is harmless and reveals no data.
  if not found then
    return false;
  end if;

  if v_message.server_id is distinct from v_message.channel_server_id then
    raise exception 'pin message and channel scope do not match'
      using errcode = '23514';
  end if;

  if not public.can_manage_server(v_message.server_id, v_actor_id) then
    raise exception 'pinning requires owner or admin'
      using errcode = '42501';
  end if;

  delete from public.pinned_messages
  where message_id = v_message.id
    and server_id = v_message.server_id
    and channel_id = v_message.channel_id;

  return found;
end;
$$;

create or replace function public.get_channel_pinned_messages(
  p_channel_id uuid
)
returns table (
  message_id uuid,
  server_id uuid,
  channel_id uuid,
  content text,
  message_created_at timestamptz,
  author_username text,
  author_avatar_url text,
  pinned_at timestamptz,
  pinned_by_username text,
  attachment_id uuid,
  attachment_file_name text,
  attachment_file_url text,
  attachment_file_type text,
  attachment_file_size bigint,
  attachment_resource_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_server_id uuid;
begin
  if v_actor_id is null then
    raise exception 'pin authentication required'
      using errcode = '42501';
  end if;

  select channel.server_id
  into v_server_id
  from public.channels as channel
  where channel.id = p_channel_id;

  if not found then
    raise exception 'pin channel not found'
      using errcode = 'P0002';
  end if;

  if not public.is_server_member(v_server_id, v_actor_id) then
    raise exception 'pin viewing requires current server membership'
      using errcode = '42501';
  end if;

  return query
  select
    pin.message_id,
    pin.server_id,
    pin.channel_id,
    message.content,
    message.created_at,
    author.username,
    author.avatar_url,
    pin.pinned_at,
    pinner.username,
    attachment.id,
    attachment.file_name,
    attachment.file_url,
    attachment.file_type,
    attachment.file_size,
    attachment.resource_id
  from public.pinned_messages as pin
  join public.messages as message
    on message.id = pin.message_id
   and message.server_id = pin.server_id
   and message.channel_id = pin.channel_id
  join public.profiles as author
    on author.id = message.user_id
  left join public.profiles as pinner
    on pinner.id = pin.pinned_by
  left join lateral (
    select
      candidate.id,
      candidate.file_name,
      candidate.file_url,
      candidate.file_type,
      candidate.file_size,
      candidate.resource_id
    from public.message_attachments as candidate
    where candidate.message_id = message.id
      and candidate.server_id = message.server_id
      and candidate.channel_id = message.channel_id
    order by candidate.id asc
    limit 1
  ) as attachment on true
  where pin.channel_id = p_channel_id
    and pin.server_id = v_server_id
  order by pin.pinned_at desc, pin.message_id;
end;
$$;

revoke all on function public.pin_channel_message(uuid) from public;
revoke all on function public.pin_channel_message(uuid) from anon;
grant execute on function public.pin_channel_message(uuid) to authenticated;

revoke all on function public.unpin_channel_message(uuid) from public;
revoke all on function public.unpin_channel_message(uuid) from anon;
grant execute on function public.unpin_channel_message(uuid) to authenticated;

revoke all on function public.get_channel_pinned_messages(uuid) from public;
revoke all on function public.get_channel_pinned_messages(uuid) from anon;
grant execute on function public.get_channel_pinned_messages(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pinned_messages'
  ) then
    alter publication supabase_realtime add table public.pinned_messages;
  end if;
end $$;

commit;
