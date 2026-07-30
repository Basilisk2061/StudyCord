-- Phase 19.1: secure own-message deletion and voluntary server departure.
-- Review and run manually in the Supabase SQL Editor.
-- Storage objects are removed by the authenticated backend before
-- delete_own_message is invoked; this migration never grants Storage access.

begin;

do $$
begin
  if to_regclass('public.messages') is null
     or to_regclass('public.message_attachments') is null
     or to_regclass('public.channels') is null
     or to_regclass('public.server_members') is null
     or to_regclass('public.servers') is null
     or to_regclass('public.server_resources') is null then
    raise exception 'Phase 19.1 requires the existing message, membership, and RAG 2 foundation tables';
  end if;

  if to_regprocedure('public.is_server_member(uuid,uuid)') is null then
    raise exception 'Phase 19.1 requires public.is_server_member(uuid, uuid)';
  end if;
end $$;

-- DELETE events need the channel/server columns in payload.old so filtered
-- Realtime subscribers can remove the message in every connected browser.
alter table public.messages replica identity full;

create or replace function public.prepare_own_message_deletion(
  p_message_id uuid
)
returns table (
  storage_path text,
  server_id uuid,
  channel_id uuid,
  user_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_message record;
begin
  if v_actor_id is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  select
    message.id,
    message.server_id,
    message.channel_id,
    message.user_id,
    channel.server_id as channel_server_id
  into v_message
  from public.messages as message
  join public.channels as channel
    on channel.id = message.channel_id
  where message.id = p_message_id;

  if not found then
    raise exception 'message not found'
      using errcode = 'P0002';
  end if;

  if v_message.user_id is distinct from v_actor_id then
    raise exception 'only the message author may delete this message'
      using errcode = '42501';
  end if;

  if not public.is_server_member(v_message.server_id, v_actor_id) then
    raise exception 'current server membership required'
      using errcode = '42501';
  end if;

  if v_message.server_id is distinct from v_message.channel_server_id then
    raise exception 'message and channel scope do not match'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.message_attachments as attachment
    where attachment.message_id = p_message_id
      and (
        attachment.server_id is distinct from v_message.server_id
        or attachment.channel_id is distinct from v_message.channel_id
        or attachment.user_id is distinct from v_actor_id
        or attachment.storage_path is null
        or attachment.storage_path not like
          v_message.server_id::text || '/' ||
          v_message.channel_id::text || '/' ||
          v_actor_id::text || '/%'
        or position(chr(92) in attachment.storage_path) > 0
        or attachment.storage_path like '%//%'
        or attachment.storage_path ~ '(^|/)\.\.?(/|$)'
      )
  ) then
    raise exception 'message attachment cleanup target is invalid'
      using errcode = '23514';
  end if;

  return query
  select distinct
    attachment.storage_path,
    v_message.server_id,
    v_message.channel_id,
    v_actor_id
  from public.message_attachments as attachment
  where attachment.message_id = p_message_id
    and not exists (
      select 1
      from public.message_attachments as other_attachment
      where other_attachment.storage_path = attachment.storage_path
        and other_attachment.message_id <> p_message_id
    );
end;
$$;

create or replace function public.delete_own_message(
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
  v_resource_ids uuid[];
begin
  if v_actor_id is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  select
    message.id,
    message.server_id,
    message.channel_id,
    message.user_id,
    channel.server_id as channel_server_id
  into v_message
  from public.messages as message
  join public.channels as channel
    on channel.id = message.channel_id
  where message.id = p_message_id
  for update of message;

  -- A repeated request after a committed delete is harmless.
  if not found then
    return false;
  end if;

  if v_message.user_id is distinct from v_actor_id then
    raise exception 'only the message author may delete this message'
      using errcode = '42501';
  end if;

  if not public.is_server_member(v_message.server_id, v_actor_id) then
    raise exception 'current server membership required'
      using errcode = '42501';
  end if;

  if v_message.server_id is distinct from v_message.channel_server_id then
    raise exception 'message and channel scope do not match'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.message_attachments as attachment
    where attachment.message_id = p_message_id
      and (
        attachment.server_id is distinct from v_message.server_id
        or attachment.channel_id is distinct from v_message.channel_id
        or attachment.user_id is distinct from v_actor_id
      )
  ) then
    raise exception 'message attachment scope does not match'
      using errcode = '23514';
  end if;

  select array_agg(distinct attachment.resource_id)
  into v_resource_ids
  from public.message_attachments as attachment
  where attachment.message_id = p_message_id
    and attachment.resource_id is not null;

  -- A canonical resource is removed only when no attachment outside this
  -- message references it. Its chunks and ratings then follow their existing
  -- resource FKs; local RAG 1 imports are deliberately unrelated.
  if coalesce(array_length(v_resource_ids, 1), 0) > 0 then
    delete from public.server_resources as resource
    where resource.id = any(v_resource_ids)
      and resource.server_id = v_message.server_id
      and not exists (
        select 1
        from public.message_attachments as other_attachment
        where other_attachment.resource_id = resource.id
          and other_attachment.message_id <> p_message_id
      );
  end if;

  delete from public.messages
  where id = p_message_id
    and user_id = v_actor_id;

  return found;
end;
$$;

create or replace function public.leave_server(
  p_server_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_owner_id uuid;
  v_role text;
begin
  if v_actor_id is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  -- Match the Phase 14 ownership-transfer lock order: server first, then
  -- membership. This prevents an ownership transfer racing a voluntary leave.
  select server.owner_id
  into v_owner_id
  from public.servers as server
  where server.id = p_server_id
  for update;

  if not found then
    raise exception 'current server membership required'
      using errcode = '42501';
  end if;

  select membership.role
  into v_role
  from public.server_members as membership
  where membership.server_id = p_server_id
    and membership.user_id = v_actor_id
  for update;

  if not found then
    raise exception 'current server membership required'
      using errcode = '42501';
  end if;

  if v_owner_id = v_actor_id or v_role = 'owner' then
    raise exception 'server owner must transfer ownership or delete the server before leaving'
      using errcode = '42501';
  end if;

  delete from public.server_members
  where server_id = p_server_id
    and user_id = v_actor_id
    and role <> 'owner';

  if not found then
    raise exception 'server membership could not be removed'
      using errcode = 'P0001';
  end if;

  return true;
end;
$$;

revoke all on function public.prepare_own_message_deletion(uuid) from public;
revoke all on function public.prepare_own_message_deletion(uuid) from anon;
grant execute on function public.prepare_own_message_deletion(uuid) to authenticated;

revoke all on function public.delete_own_message(uuid) from public;
revoke all on function public.delete_own_message(uuid) from anon;
grant execute on function public.delete_own_message(uuid) to authenticated;

revoke all on function public.leave_server(uuid) from public;
revoke all on function public.leave_server(uuid) from anon;
grant execute on function public.leave_server(uuid) to authenticated;

commit;
