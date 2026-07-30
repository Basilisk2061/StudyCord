-- Phase 18.3: server-scoped RAG 2 HNSW semantic chunk retrieval.
-- Review and run manually in the Supabase SQL Editor.
-- This migration does not aggregate resources, create ratings, backfill
-- attachments, or change RAG 1.

begin;

do $$
declare
  v_vector_version text;
  v_vector_major integer;
  v_vector_minor integer;
begin
  if to_regclass('public.server_resources') is null
     or to_regclass('public.resource_chunks') is null then
    raise exception 'Phase 18.3 requires the deployed Phase 18.1B and Phase 18.2 schema';
  end if;

  select extension.extversion
  into v_vector_version
  from pg_catalog.pg_extension as extension
  where extension.extname = 'vector';

  if v_vector_version is null then
    raise exception 'Phase 18.3 requires the vector extension';
  end if;

  v_vector_major := split_part(v_vector_version, '.', 1)::integer;
  v_vector_minor := split_part(v_vector_version, '.', 2)::integer;
  if v_vector_major < 1 and v_vector_minor < 8 then
    raise exception 'Phase 18.3 requires pgvector 0.8.0 or newer; found %',
      v_vector_version;
  end if;

  if to_regprocedure('public.is_server_member(uuid,uuid)') is null then
    raise exception 'Phase 18.3 requires public.is_server_member(uuid, uuid)';
  end if;

  if to_regprocedure(
    'public.match_server_resource_chunks(uuid,extensions.vector,integer)'
  ) is not null then
    raise exception 'public.match_server_resource_chunks already exists; inspect it before running Phase 18.3';
  end if;

  if to_regclass('public.idx_resource_chunks_embedding_hnsw_cosine') is not null then
    raise exception 'Phase 18.3 HNSW index already exists; inspect it before running this migration';
  end if;
end $$;

create index idx_resource_chunks_embedding_hnsw_cosine
on public.resource_chunks
using hnsw (embedding extensions.vector_cosine_ops);

create or replace function public.match_server_resource_chunks(
  p_server_id uuid,
  p_query_embedding extensions.vector(768),
  p_limit integer default 10
)
returns table (
  server_id uuid,
  resource_id uuid,
  chunk_id uuid,
  chunk_index integer,
  content text,
  cosine_distance double precision,
  cosine_similarity double precision
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

  if p_limit is null or p_limit not between 1 and 25 then
    raise exception 'search limit must be between 1 and 25'
      using errcode = '22023';
  end if;

  -- pgvector 0.8 iterative scans continue through globally nearest HNSW
  -- candidates until enough rows survive the mandatory server/resource
  -- filters, while strict_order preserves cosine-distance ordering.
  perform pg_catalog.set_config(
    'hnsw.iterative_scan',
    'strict_order',
    true
  );

  return query
  select
    chunk.server_id,
    chunk.resource_id,
    chunk.id,
    chunk.chunk_index,
    chunk.content,
    (
      chunk.embedding
      operator(extensions.<=>)
      p_query_embedding
    )::double precision as cosine_distance,
    (
      1 - (
        chunk.embedding
        operator(extensions.<=>)
        p_query_embedding
      )
    )::double precision as cosine_similarity
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
  limit p_limit;
end;
$$;

revoke all on function public.match_server_resource_chunks(
  uuid,
  extensions.vector,
  integer
) from public, anon;

grant execute on function public.match_server_resource_chunks(
  uuid,
  extensions.vector,
  integer
) to authenticated;

commit;
