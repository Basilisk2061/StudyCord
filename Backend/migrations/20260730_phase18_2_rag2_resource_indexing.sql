-- Phase 18.2: RAG 2 resource validation, chunk, and embedding persistence.
-- Review and run manually in the Supabase SQL Editor.
-- This migration intentionally creates no HNSW/IVFFlat index and performs no
-- historical attachment backfill.

begin;

do $$
begin
  if to_regclass('public.server_resources') is null then
    raise exception 'Phase 18.2 requires public.server_resources from Phase 18.1B';
  end if;

  if to_regclass('public.resource_chunks') is not null then
    raise exception 'public.resource_chunks already exists; inspect it before running Phase 18.2';
  end if;
end $$;

create extension if not exists vector with schema extensions;

alter table public.server_resources
  add column index_attempt_id uuid,
  add column index_started_at timestamptz,
  add column indexed_at timestamptz,
  add column content_sha256 text,
  add column embedding_model text,
  add column embedding_dimensions integer;

alter table public.server_resources
  add constraint server_resources_index_attempt_state_check
  check (
    (
      index_status = 'processing'
      and index_attempt_id is not null
      and index_started_at is not null
    )
    or (
      index_status <> 'processing'
      and index_attempt_id is null
      and index_started_at is null
    )
  ),
  add constraint server_resources_content_sha256_check
  check (
    content_sha256 is null
    or content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add constraint server_resources_embedding_dimensions_check
  check (
    embedding_dimensions is null
    or embedding_dimensions = 768
  ),
  add constraint server_resources_ready_index_check
  check (
    index_status <> 'ready'
    or (
      detected_type in ('pdf', 'docx', 'txt')
      and indexed_at is not null
      and content_sha256 is not null
      and embedding_model = 'models/gemini-embedding-001'
      and embedding_dimensions = 768
    )
  );

create table public.resource_chunks (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null,
  server_id uuid not null,
  index_attempt_id uuid not null,
  chunk_index integer not null,
  content text not null,
  embedding extensions.vector(768) not null,
  created_at timestamptz not null default now(),
  constraint resource_chunks_resource_server_fk
    foreign key (resource_id, server_id)
    references public.server_resources(id, server_id)
    on delete cascade,
  constraint resource_chunks_chunk_index_check
    check (chunk_index between 0 and 1999),
  constraint resource_chunks_content_check
    check (
      char_length(btrim(content)) > 0
      -- Defensive storage ceiling, deliberately much larger than the
      -- application's 1,000-character splitter target.
      and char_length(content) <= 10000
    ),
  constraint resource_chunks_attempt_index_key
    unique (resource_id, index_attempt_id, chunk_index)
);

create index idx_resource_chunks_resource_attempt_index
  on public.resource_chunks(resource_id, index_attempt_id, chunk_index);

create index idx_resource_chunks_server_resource
  on public.resource_chunks(server_id, resource_id);

alter table public.resource_chunks enable row level security;

revoke all on table public.resource_chunks from public, anon, authenticated;

create or replace function public.begin_rag2_resource_indexing(
  p_resource_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resource record;
  v_attempt_id uuid := gen_random_uuid();
begin
  select
    resource.id,
    resource.visibility,
    resource.storage_bucket,
    resource.index_status,
    resource.index_started_at
  into v_resource
  from public.server_resources as resource
  where resource.id = p_resource_id
  for update;

  if not found then
    raise exception 'resource not found'
      using errcode = 'P0002';
  end if;

  if v_resource.visibility <> 'server'
     or v_resource.storage_bucket <> 'channel-files' then
    raise exception 'resource is not supported for RAG 2 indexing'
      using errcode = '22023';
  end if;

  if v_resource.index_status = 'ready' then
    raise exception 'resource is already indexed'
      using errcode = '23505';
  end if;

  if v_resource.index_status = 'processing'
     and v_resource.index_started_at >= now() - interval '30 minutes' then
    raise exception 'resource indexing is already in progress'
      using errcode = '55P03';
  end if;

  if v_resource.index_status not in ('unindexed', 'failed', 'processing') then
    raise exception 'resource indexing state is not supported'
      using errcode = '22023';
  end if;

  -- A processing row can reach this point only when its lease is stale.
  -- Its chunks are not logically ready and can be removed before retry.
  delete from public.resource_chunks
  where resource_id = p_resource_id;

  update public.server_resources
  set
    index_status = 'processing',
    index_attempt_id = v_attempt_id,
    index_started_at = now(),
    indexed_at = null,
    detected_type = null,
    content_sha256 = null,
    embedding_model = null,
    embedding_dimensions = null
  where id = p_resource_id;

  return v_attempt_id;
end;
$$;

create or replace function public.stage_rag2_resource_chunks(
  p_resource_id uuid,
  p_attempt_id uuid,
  p_chunks jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resource record;
  v_item jsonb;
  v_chunk_index integer;
  v_content text;
  v_embedding extensions.vector(768);
  v_batch_count integer;
begin
  if p_chunks is null or jsonb_typeof(p_chunks) <> 'array' then
    raise exception 'chunk batch must be a JSON array'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_chunks) not between 1 and 100 then
    raise exception 'chunk batch must contain between 1 and 100 chunks'
      using errcode = '22023';
  end if;

  select resource.id, resource.server_id
  into v_resource
  from public.server_resources as resource
  where resource.id = p_resource_id
    and resource.index_status = 'processing'
    and resource.index_attempt_id = p_attempt_id
  for update;

  if not found then
    raise exception 'indexing attempt is not active'
      using errcode = '40001';
  end if;

  v_batch_count := 0;
  for v_item in
    select value from jsonb_array_elements(p_chunks)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'embedding') <> 'array'
       or jsonb_array_length(v_item -> 'embedding') <> 768 then
      raise exception 'one or more chunks are invalid'
        using errcode = '22023';
    end if;

    begin
      v_chunk_index := (v_item ->> 'chunk_index')::integer;
      v_content := v_item ->> 'content';
      v_embedding := ((v_item -> 'embedding')::text)::extensions.vector(768);
    exception
      when others then
        raise exception 'one or more chunks are invalid'
          using errcode = '22023';
    end;

    if v_chunk_index is null
       or v_chunk_index not between 0 and 1999
       or v_content is null
       or char_length(btrim(v_content)) = 0
       or char_length(v_content) > 10000 then
      raise exception 'one or more chunks are invalid'
        using errcode = '22023';
    end if;

    insert into public.resource_chunks (
      resource_id,
      server_id,
      index_attempt_id,
      chunk_index,
      content,
      embedding
    )
    values (
      p_resource_id,
      v_resource.server_id,
      p_attempt_id,
      v_chunk_index,
      v_content,
      v_embedding
    )
    on conflict (resource_id, index_attempt_id, chunk_index)
    do update set
      content = excluded.content,
      embedding = excluded.embedding;

    v_batch_count := v_batch_count + 1;
  end loop;

  return v_batch_count;
end;
$$;

create or replace function public.complete_rag2_resource_indexing(
  p_resource_id uuid,
  p_attempt_id uuid,
  p_detected_type text,
  p_size_bytes bigint,
  p_content_sha256 text,
  p_expected_chunk_count integer
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resource record;
  v_chunk_count integer;
  v_min_index integer;
  v_max_index integer;
  v_indexed_at timestamptz := now();
begin
  if p_detected_type is null
     or p_detected_type not in ('pdf', 'docx', 'txt')
     or p_size_bytes is null
     or p_size_bytes not between 1 and 10485760
     or p_content_sha256 is null
     or p_content_sha256 !~ '^[0-9a-f]{64}$'
     or p_expected_chunk_count is null
     or p_expected_chunk_count not between 1 and 2000 then
    raise exception 'index completion metadata is invalid'
      using errcode = '22023';
  end if;

  select resource.id, resource.server_id
  into v_resource
  from public.server_resources as resource
  where resource.id = p_resource_id
    and resource.index_status = 'processing'
    and resource.index_attempt_id = p_attempt_id
  for update;

  if not found then
    raise exception 'indexing attempt is not active'
      using errcode = '40001';
  end if;

  select count(*), min(chunk_index), max(chunk_index)
  into v_chunk_count, v_min_index, v_max_index
  from public.resource_chunks
  where resource_id = p_resource_id
    and server_id = v_resource.server_id
    and index_attempt_id = p_attempt_id;

  if v_chunk_count <> p_expected_chunk_count
     or v_min_index <> 0
     or v_max_index <> p_expected_chunk_count - 1 then
    raise exception 'staged chunks are incomplete'
      using errcode = '23514';
  end if;

  delete from public.resource_chunks
  where resource_id = p_resource_id
    and index_attempt_id <> p_attempt_id;

  update public.server_resources
  set
    detected_type = p_detected_type,
    size_bytes = p_size_bytes,
    index_status = 'ready',
    index_attempt_id = null,
    index_started_at = null,
    indexed_at = v_indexed_at,
    content_sha256 = p_content_sha256,
    embedding_model = 'models/gemini-embedding-001',
    embedding_dimensions = 768
  where id = p_resource_id;

  return v_indexed_at;
end;
$$;

create or replace function public.fail_rag2_resource_indexing(
  p_resource_id uuid,
  p_attempt_id uuid,
  p_detected_type text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_detected_type is not null
     and p_detected_type not in ('pdf', 'docx', 'txt') then
    raise exception 'detected type is invalid'
      using errcode = '22023';
  end if;

  perform 1
  from public.server_resources as resource
  where resource.id = p_resource_id
    and resource.index_status = 'processing'
    and resource.index_attempt_id = p_attempt_id
  for update;

  if not found then
    raise exception 'indexing attempt is not active'
      using errcode = '40001';
  end if;

  delete from public.resource_chunks
  where resource_id = p_resource_id
    and index_attempt_id = p_attempt_id;

  update public.server_resources
  set
    detected_type = p_detected_type,
    index_status = 'failed',
    index_attempt_id = null,
    index_started_at = null,
    indexed_at = null,
    content_sha256 = null,
    embedding_model = null,
    embedding_dimensions = null
  where id = p_resource_id;
end;
$$;

revoke all on function public.begin_rag2_resource_indexing(uuid)
  from public, anon, authenticated;
revoke all on function public.stage_rag2_resource_chunks(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.complete_rag2_resource_indexing(uuid, uuid, text, bigint, text, integer)
  from public, anon, authenticated;
revoke all on function public.fail_rag2_resource_indexing(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.begin_rag2_resource_indexing(uuid)
  to service_role;
grant execute on function public.stage_rag2_resource_chunks(uuid, uuid, jsonb)
  to service_role;
grant execute on function public.complete_rag2_resource_indexing(uuid, uuid, text, bigint, text, integer)
  to service_role;
grant execute on function public.fail_rag2_resource_indexing(uuid, uuid, text)
  to service_role;

commit;
