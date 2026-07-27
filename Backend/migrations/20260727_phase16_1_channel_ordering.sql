-- Phase 16.1: persistent, permission-aware channel ordering.
-- Review and run manually in the Supabase SQL Editor.

begin;

alter table public.channels
  add column if not exists position bigint;

with ranked_channels as (
  select
    id,
    row_number() over (
      partition by server_id, type
      order by created_at, id
    ) * 1000 as backfilled_position
  from public.channels
  where position is null
)
update public.channels as channel
set position = ranked_channels.backfilled_position
from ranked_channels
where channel.id = ranked_channels.id;

alter table public.channels
  alter column position set not null;

create index if not exists idx_channels_server_type_position
  on public.channels(server_id, type, position, created_at, id);

create or replace function public.assign_channel_position()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_position bigint;
begin
  if new.position is not null then
    return new;
  end if;

  -- Channel creation and reordering use the same group lock so a concurrent
  -- insert cannot choose a position while that group is being rebalanced.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.server_id::text || ':' || new.type, 0)
  );

  select coalesce(max(channel.position), 0)
  into v_max_position
  from public.channels as channel
  where channel.server_id = new.server_id
    and channel.type = new.type;

  if v_max_position > 9223372036854774807 then
    raise exception 'channel position range exhausted'
      using errcode = '22003';
  end if;

  new.position := v_max_position + 1000;

  return new;
end;
$$;

revoke all on function public.assign_channel_position() from public;

drop trigger if exists assign_channel_position on public.channels;
create trigger assign_channel_position
before insert on public.channels
for each row
execute function public.assign_channel_position();

create or replace function public.prevent_direct_channel_position_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.position is distinct from old.position
     and coalesce(
       current_setting('studycord.allow_channel_reorder', true),
       'off'
     ) <> 'on' then
    raise exception 'channel position must be changed with reorder_channel'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_direct_channel_position_change() from public;

drop trigger if exists prevent_direct_channel_position_change on public.channels;
create trigger prevent_direct_channel_position_change
before update of position on public.channels
for each row
execute function public.prevent_direct_channel_position_change();

create or replace function public.reorder_channel(
  p_channel_id uuid,
  p_before_channel_id uuid default null,
  p_after_channel_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_locked_server_id uuid;
  v_locked_channel_type text;
  v_server_id uuid;
  v_channel_type text;
  v_before_position bigint;
  v_after_position bigint;
  v_new_position bigint;
  v_ordered_ids uuid[];
  v_before_index integer;
  v_after_index integer;
  v_group_size integer;
begin
  if v_actor_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_before_channel_id = p_channel_id
     or p_after_channel_id = p_channel_id then
    raise exception 'a channel cannot be its own reorder neighbor'
      using errcode = '22023';
  end if;

  if p_before_channel_id is not null
     and p_before_channel_id = p_after_channel_id then
    raise exception 'before and after channels must be different'
      using errcode = '22023';
  end if;

  select channel.server_id, channel.type
  into v_locked_server_id, v_locked_channel_type
  from public.channels as channel
  where channel.id = p_channel_id;

  if v_locked_server_id is null then
    raise exception 'channel not found' using errcode = 'P0002';
  end if;

  if not public.can_manage_server(v_locked_server_id, v_actor_id) then
    raise exception 'you do not have permission to reorder channels'
      using errcode = '42501';
  end if;

  -- Serialize every reorder and insert in this server/type group.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_locked_server_id::text || ':' || v_locked_channel_type,
      0
    )
  );

  -- Re-read and lock the moved channel after obtaining the group lock.
  select channel.server_id, channel.type
  into v_server_id, v_channel_type
  from public.channels as channel
  where channel.id = p_channel_id
  for update;

  if v_server_id is null then
    raise exception 'channel not found' using errcode = 'P0002';
  end if;

  if v_server_id is distinct from v_locked_server_id
     or v_channel_type is distinct from v_locked_channel_type then
    raise exception 'channel group changed; refresh and try again'
      using errcode = '40001';
  end if;

  if not public.can_manage_server(v_server_id, v_actor_id) then
    raise exception 'you do not have permission to reorder channels'
      using errcode = '42501';
  end if;

  if p_before_channel_id is not null then
    select channel.position
    into v_before_position
    from public.channels as channel
    where channel.id = p_before_channel_id
      and channel.server_id = v_server_id
      and channel.type = v_channel_type;

    if v_before_position is null then
      raise exception 'before channel must belong to the same server and type'
        using errcode = '22023';
    end if;
  end if;

  if p_after_channel_id is not null then
    select channel.position
    into v_after_position
    from public.channels as channel
    where channel.id = p_after_channel_id
      and channel.server_id = v_server_id
      and channel.type = v_channel_type;

    if v_after_position is null then
      raise exception 'after channel must belong to the same server and type'
        using errcode = '22023';
    end if;
  end if;

  select
    coalesce(
      array_agg(channel.id order by channel.position, channel.created_at, channel.id),
      array[]::uuid[]
    )
  into v_ordered_ids
  from public.channels as channel
  where channel.server_id = v_server_id
    and channel.type = v_channel_type
    and channel.id <> p_channel_id;

  v_group_size := coalesce(array_length(v_ordered_ids, 1), 0);
  v_before_index := array_position(v_ordered_ids, p_before_channel_id);
  v_after_index := array_position(v_ordered_ids, p_after_channel_id);

  -- Neighbors are supplied from the client's final list with the moved
  -- channel removed. Reject stale concurrent requests instead of guessing.
  if p_before_channel_id is not null
     and p_after_channel_id is not null
     and (
       v_before_index is null
       or v_after_index is null
       or v_after_index <> v_before_index + 1
     ) then
    raise exception 'channel order changed; refresh and try again'
      using errcode = '40001';
  elsif p_before_channel_id is not null
        and p_after_channel_id is null
        and (
          v_before_index is null
          or v_before_index <> v_group_size
        ) then
    raise exception 'channel order changed; refresh and try again'
      using errcode = '40001';
  elsif p_before_channel_id is null
        and p_after_channel_id is not null
        and (
          v_after_index is null
          or v_after_index <> 1
        ) then
    raise exception 'channel order changed; refresh and try again'
      using errcode = '40001';
  elsif p_before_channel_id is null
        and p_after_channel_id is null
        and v_group_size > 0 then
    raise exception 'a reorder neighbor is required'
      using errcode = '22023';
  end if;

  perform set_config('studycord.allow_channel_reorder', 'on', true);

  if p_before_channel_id is not null
     and p_after_channel_id is not null then
    if v_after_position - v_before_position <= 1 then
      -- Midpoint space is exhausted. Re-space only this server/type group.
      with reordered_group as (
        select
          channel.id,
          row_number() over (
            order by channel.position, channel.created_at, channel.id
          ) * 1000 as rebalanced_position
        from public.channels as channel
        where channel.server_id = v_server_id
          and channel.type = v_channel_type
      )
      update public.channels as channel
      set position = reordered_group.rebalanced_position
      from reordered_group
      where channel.id = reordered_group.id;

      select channel.position
      into v_before_position
      from public.channels as channel
      where channel.id = p_before_channel_id;

      select channel.position
      into v_after_position
      from public.channels as channel
      where channel.id = p_after_channel_id;
    end if;

    v_new_position :=
      v_before_position + ((v_after_position - v_before_position) / 2);
  elsif p_before_channel_id is not null then
    if v_before_position > 9223372036854774807 then
      raise exception 'channel position range exhausted'
        using errcode = '22003';
    end if;
    v_new_position := v_before_position + 1000;
  elsif p_after_channel_id is not null then
    if v_after_position < -9223372036854774808 then
      raise exception 'channel position range exhausted'
        using errcode = '22003';
    end if;
    v_new_position := v_after_position - 1000;
  else
    v_new_position := 1000;
  end if;

  update public.channels
  set position = v_new_position
  where id = p_channel_id;
end;
$$;

revoke all on function public.reorder_channel(uuid, uuid, uuid) from public;
revoke all on function public.reorder_channel(uuid, uuid, uuid) from anon;
grant execute on function public.reorder_channel(uuid, uuid, uuid) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    raise exception 'supabase_realtime publication does not exist';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'channels'
  ) then
    alter publication supabase_realtime add table public.channels;
  end if;
end $$;

commit;
