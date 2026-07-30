-- Phase 18.5C: bounded channel attachment resource metadata.
-- Review and run manually in the Supabase SQL Editor.

begin;

do $$
begin
  if to_regclass('public.server_resources') is null
     or to_regclass('public.resource_ratings') is null then
    raise exception 'Phase 18.5C requires the deployed Phase 18.1B and Phase 18.4 schema';
  end if;

  if to_regprocedure('public.is_server_member(uuid,uuid)') is null then
    raise exception 'Phase 18.5C requires public.is_server_member(uuid, uuid)';
  end if;

  if to_regprocedure(
    'public.get_channel_resource_card_metadata(uuid,uuid[])'
  ) is not null then
    raise exception 'Phase 18.5C metadata RPC already exists; inspect it before running this migration';
  end if;
end $$;

create function public.get_channel_resource_card_metadata(
  p_server_id uuid,
  p_resource_ids uuid[]
)
returns table (
  resource_id uuid,
  title text,
  original_filename text,
  detected_type text,
  size_bytes bigint,
  average_rating double precision,
  rating_count bigint,
  current_user_rating integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  if not public.is_server_member(p_server_id, v_actor_id) then
    raise exception 'current server membership required'
      using errcode = '42501';
  end if;

  if p_resource_ids is null or cardinality(p_resource_ids) = 0 then
    return;
  end if;

  if cardinality(p_resource_ids) > 200 then
    raise exception 'resource metadata request limit exceeded'
      using errcode = '22023';
  end if;

  return query
  with requested as materialized (
    select distinct requested.requested_id
    from unnest(p_resource_ids) as requested(requested_id)
  ),
  rating_summaries as materialized (
    select
      stored.resource_id,
      avg(stored.rating)::double precision as average_rating,
      count(stored.user_id)::bigint as rating_count,
      max(stored.rating) filter (
        where stored.user_id = v_actor_id
      )::integer as current_user_rating
    from public.resource_ratings as stored
    join requested
      on requested.requested_id = stored.resource_id
    where stored.server_id = p_server_id
    group by stored.resource_id
  )
  select
    resource.id,
    resource.title,
    resource.original_filename,
    resource.detected_type,
    resource.size_bytes,
    summary.average_rating,
    coalesce(summary.rating_count, 0)::bigint,
    summary.current_user_rating
  from requested
  join public.server_resources as resource
    on resource.id = requested.requested_id
   and resource.server_id = p_server_id
  left join rating_summaries as summary
    on summary.resource_id = resource.id
  where resource.visibility = 'server'
    and resource.index_status = 'ready'
    and resource.detected_type in ('pdf', 'docx', 'txt')
  order by resource.id;
end;
$$;

revoke all
  on function public.get_channel_resource_card_metadata(uuid, uuid[])
  from public, anon;
grant execute
  on function public.get_channel_resource_card_metadata(uuid, uuid[])
  to authenticated;

commit;
