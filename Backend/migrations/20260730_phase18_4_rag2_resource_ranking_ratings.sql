-- Phase 18.4: RAG 2 resource ranking candidates and server-resource ratings.
-- Review and run manually in the Supabase SQL Editor.
-- Ratings are display-only and do not affect semantic candidate ordering.

begin;

do $$
begin
  if to_regclass('public.server_resources') is null
     or to_regclass('public.resource_chunks') is null
     or to_regclass('public.profiles') is null then
    raise exception 'Phase 18.4 requires the deployed Phase 18.1B and Phase 18.2 schema';
  end if;

  if to_regclass('public.idx_resource_chunks_embedding_hnsw_cosine') is null
     or to_regprocedure(
       'public.match_server_resource_chunks(uuid,extensions.vector,integer)'
     ) is null then
    raise exception 'Phase 18.4 requires the deployed Phase 18.3 HNSW retrieval schema';
  end if;

  if to_regprocedure('public.is_server_member(uuid,uuid)') is null then
    raise exception 'Phase 18.4 requires public.is_server_member(uuid, uuid)';
  end if;

  if to_regclass('public.resource_ratings') is not null then
    raise exception 'public.resource_ratings already exists; inspect it before running Phase 18.4';
  end if;

  if to_regprocedure('public.set_server_resource_rating(uuid,integer)') is not null
     or to_regprocedure('public.delete_server_resource_rating(uuid)') is not null
     or to_regprocedure(
       'public.match_server_resource_chunk_candidates(uuid,extensions.vector,integer)'
     ) is not null then
    raise exception 'A Phase 18.4 RPC already exists; inspect it before running this migration';
  end if;
end $$;

create table public.resource_ratings (
  resource_id uuid not null,
  server_id uuid not null,
  user_id uuid not null,
  rating smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resource_ratings_pkey
    primary key (resource_id, user_id),
  constraint resource_ratings_resource_server_fk
    foreign key (resource_id, server_id)
    references public.server_resources(id, server_id)
    on delete cascade,
  constraint resource_ratings_user_fk
    foreign key (user_id)
    references public.profiles(id)
    on delete cascade,
  constraint resource_ratings_value_check
    check (rating between 1 and 5),
  constraint resource_ratings_timestamps_check
    check (updated_at >= created_at)
);

create index idx_resource_ratings_server_resource
  on public.resource_ratings(server_id, resource_id);

create index idx_resource_ratings_user_server_resource
  on public.resource_ratings(user_id, server_id, resource_id);

create or replace function public.set_resource_ratings_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.set_resource_ratings_updated_at() from public;

create trigger set_resource_ratings_updated_at
before update on public.resource_ratings
for each row
execute function public.set_resource_ratings_updated_at();

alter table public.resource_ratings enable row level security;

create policy "resource_ratings_select_for_members"
on public.resource_ratings
for select
to authenticated
using (
  public.is_server_member(server_id, auth.uid())
  and exists (
    select 1
    from public.server_resources as resource
    where resource.id = resource_ratings.resource_id
      and resource.server_id = resource_ratings.server_id
      and resource.visibility = 'server'
  )
);

create policy "resource_ratings_insert_own"
on public.resource_ratings
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.is_server_member(server_id, auth.uid())
  and exists (
    select 1
    from public.server_resources as resource
    where resource.id = resource_ratings.resource_id
      and resource.server_id = resource_ratings.server_id
      and resource.visibility = 'server'
  )
);

create policy "resource_ratings_update_own"
on public.resource_ratings
for update
to authenticated
using (
  user_id = auth.uid()
  and public.is_server_member(server_id, auth.uid())
  and exists (
    select 1
    from public.server_resources as resource
    where resource.id = resource_ratings.resource_id
      and resource.server_id = resource_ratings.server_id
      and resource.visibility = 'server'
  )
)
with check (
  user_id = auth.uid()
  and public.is_server_member(server_id, auth.uid())
  and exists (
    select 1
    from public.server_resources as resource
    where resource.id = resource_ratings.resource_id
      and resource.server_id = resource_ratings.server_id
      and resource.visibility = 'server'
  )
);

create policy "resource_ratings_delete_own"
on public.resource_ratings
for delete
to authenticated
using (
  user_id = auth.uid()
  and public.is_server_member(server_id, auth.uid())
  and exists (
    select 1
    from public.server_resources as resource
    where resource.id = resource_ratings.resource_id
      and resource.server_id = resource_ratings.server_id
      and resource.visibility = 'server'
  )
);

-- Browser clients receive no direct table privileges. The policies remain
-- defense in depth; mutations and aggregate reads use the narrow RPCs below.
revoke all on table public.resource_ratings from public, anon, authenticated;

create or replace function public.set_server_resource_rating(
  p_resource_id uuid,
  p_rating integer
)
returns table (
  resource_id uuid,
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
  v_resource record;
begin
  if v_actor_id is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  if p_rating is null or p_rating not between 1 and 5 then
    raise exception 'rating must be between 1 and 5'
      using errcode = '22023';
  end if;

  select resource.id, resource.server_id, resource.visibility
  into v_resource
  from public.server_resources as resource
  where resource.id = p_resource_id;

  if not found then
    raise exception 'rating resource not found'
      using errcode = 'P0002';
  end if;

  if v_resource.visibility <> 'server' then
    raise exception 'rating requires a server-visible resource'
      using errcode = '42501';
  end if;

  if not public.is_server_member(v_resource.server_id, v_actor_id) then
    raise exception 'current server membership required'
      using errcode = '42501';
  end if;

  insert into public.resource_ratings (
    resource_id,
    server_id,
    user_id,
    rating
  )
  values (
    v_resource.id,
    v_resource.server_id,
    v_actor_id,
    p_rating::smallint
  )
  on conflict on constraint resource_ratings_pkey
  do update
  set rating = excluded.rating;

  return query
  select
    v_resource.id,
    avg(stored.rating)::double precision,
    count(*)::bigint,
    (
      max(stored.rating)
      filter (where stored.user_id = v_actor_id)
    )::integer
  from public.resource_ratings as stored
  where stored.resource_id = v_resource.id
    and stored.server_id = v_resource.server_id;
end;
$$;

create or replace function public.delete_server_resource_rating(
  p_resource_id uuid
)
returns table (
  resource_id uuid,
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
  v_resource record;
begin
  if v_actor_id is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  select resource.id, resource.server_id, resource.visibility
  into v_resource
  from public.server_resources as resource
  where resource.id = p_resource_id;

  if not found then
    raise exception 'rating resource not found'
      using errcode = 'P0002';
  end if;

  if v_resource.visibility <> 'server' then
    raise exception 'rating requires a server-visible resource'
      using errcode = '42501';
  end if;

  if not public.is_server_member(v_resource.server_id, v_actor_id) then
    raise exception 'current server membership required'
      using errcode = '42501';
  end if;

  delete from public.resource_ratings as stored
  where stored.resource_id = v_resource.id
    and stored.server_id = v_resource.server_id
    and stored.user_id = v_actor_id;

  return query
  select
    v_resource.id,
    avg(stored.rating)::double precision,
    count(stored.rating)::bigint,
    (
      max(stored.rating)
      filter (where stored.user_id = v_actor_id)
    )::integer
  from public.resource_ratings as stored
  where stored.resource_id = v_resource.id
    and stored.server_id = v_resource.server_id;
end;
$$;

create or replace function public.match_server_resource_chunk_candidates(
  p_server_id uuid,
  p_query_embedding extensions.vector(768),
  p_candidate_limit integer default 40
)
returns table (
  server_id uuid,
  resource_id uuid,
  chunk_id uuid,
  chunk_index integer,
  content text,
  cosine_distance double precision,
  cosine_similarity double precision,
  title text,
  original_filename text,
  detected_type text,
  size_bytes bigint,
  indexed_at timestamptz,
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

  if p_server_id is null
     or not public.is_server_member(p_server_id, v_actor_id) then
    raise exception 'current server membership required'
      using errcode = '42501';
  end if;

  if p_query_embedding is null
     or extensions.vector_norm(p_query_embedding) <= 0 then
    raise exception 'query embedding is invalid'
      using errcode = '22023';
  end if;

  if p_candidate_limit is null
     or p_candidate_limit not between 1 and 100 then
    raise exception 'candidate limit must be between 1 and 100'
      using errcode = '22023';
  end if;

  perform pg_catalog.set_config(
    'hnsw.iterative_scan',
    'strict_order',
    true
  );

  return query
  with candidates as materialized (
    select
      chunk.server_id,
      chunk.resource_id,
      chunk.id as chunk_id,
      chunk.chunk_index,
      chunk.content,
      (
        chunk.embedding
        operator(extensions.<=>)
        p_query_embedding
      )::double precision as cosine_distance
    from public.resource_chunks as chunk
    join public.server_resources as resource
      on resource.id = chunk.resource_id
     and resource.server_id = chunk.server_id
    where chunk.server_id = p_server_id
      and resource.server_id = p_server_id
      and resource.index_status = 'ready'
      and resource.visibility = 'server'
      and resource.embedding_model = 'models/gemini-embedding-001'
      and resource.embedding_dimensions = 768
    order by
      chunk.embedding
      operator(extensions.<=>)
      p_query_embedding
    limit p_candidate_limit
  ),
  candidate_resources as materialized (
    select distinct candidate.resource_id
    from candidates as candidate
  ),
  rating_summaries as materialized (
    select
      stored.resource_id,
      avg(stored.rating)::double precision as average_rating,
      count(*)::bigint as rating_count,
      (
        max(stored.rating)
        filter (where stored.user_id = v_actor_id)
      )::integer as current_user_rating
    from public.resource_ratings as stored
    join candidate_resources as candidate_resource
      on candidate_resource.resource_id = stored.resource_id
    where stored.server_id = p_server_id
    group by stored.resource_id
  )
  select
    candidate.server_id,
    candidate.resource_id,
    candidate.chunk_id,
    candidate.chunk_index,
    candidate.content,
    candidate.cosine_distance,
    (1 - candidate.cosine_distance)::double precision,
    resource.title,
    resource.original_filename,
    resource.detected_type,
    resource.size_bytes,
    resource.indexed_at,
    rating_summary.average_rating,
    coalesce(rating_summary.rating_count, 0)::bigint,
    rating_summary.current_user_rating
  from candidates as candidate
  join public.server_resources as resource
    on resource.id = candidate.resource_id
   and resource.server_id = candidate.server_id
  left join rating_summaries as rating_summary
    on rating_summary.resource_id = candidate.resource_id
  order by candidate.cosine_distance, candidate.chunk_id;
end;
$$;

revoke all on function public.set_server_resource_rating(uuid, integer)
  from public, anon;
revoke all on function public.delete_server_resource_rating(uuid)
  from public, anon;
revoke all on function public.match_server_resource_chunk_candidates(
  uuid,
  extensions.vector,
  integer
) from public, anon;

grant execute on function public.set_server_resource_rating(uuid, integer)
  to authenticated;
grant execute on function public.delete_server_resource_rating(uuid)
  to authenticated;
grant execute on function public.match_server_resource_chunk_candidates(
  uuid,
  extensions.vector,
  integer
) to authenticated;

commit;
