-- Message moderation: allow server managers to use the existing message deletion
-- pipeline. This corrective migration replaces functions only and changes no
-- structural, policy, indexing, trigger, publication, or grant objects.

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

  if v_message.user_id is distinct from v_actor_id
     and not public.can_manage_server(v_message.server_id, v_actor_id) then
    raise exception 'message deletion requires author or server manager'
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
        or attachment.user_id is distinct from v_message.user_id
        or attachment.storage_path is null
        or attachment.storage_path not like
          v_message.server_id::text || '/' ||
          v_message.channel_id::text || '/' ||
          v_message.user_id::text || '/%'
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
    v_message.user_id
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

  if v_message.user_id is distinct from v_actor_id
     and not public.can_manage_server(v_message.server_id, v_actor_id) then
    raise exception 'message deletion requires author or server manager'
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
        or attachment.user_id is distinct from v_message.user_id
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

  -- Preserve the existing canonical resource cleanup. Chunk and rating rows
  -- continue following their existing resource foreign-key cascades.
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

  -- Attachment and pinned-message rows retain their existing message FK
  -- cascades. The locked message row is the single deletion authority.
  delete from public.messages
  where id = p_message_id;

  return found;
end;
$$;
