-- Phase 18.1B: canonical server-resource and authorization foundation.
-- Review and run manually in the Supabase SQL Editor.
-- This migration does not enable pgvector, create embeddings, or backfill
-- historical message attachments.

begin;

do $$
begin
  if to_regclass('public.server_resources') is not null then
    raise exception 'public.server_resources already exists; inspect it before running Phase 18.1B';
  end if;

  if to_regclass('public.servers') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.channels') is null
     or to_regclass('public.messages') is null
     or to_regclass('public.message_attachments') is null then
    raise exception 'Phase 18.1B requires servers, profiles, channels, messages, and message_attachments';
  end if;

  if to_regprocedure('public.is_server_member(uuid,uuid)') is null
     or to_regprocedure('public.can_manage_server(uuid,uuid)') is null then
    raise exception 'Phase 18.1B requires the Phase 14 server authorization helpers';
  end if;
end $$;

create table public.server_resources (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null
    references public.servers(id)
    on delete cascade,
  uploader_id uuid not null
    references public.profiles(id)
    on delete restrict,
  title text not null,
  original_filename text not null,
  storage_bucket text not null,
  storage_path text not null,
  declared_mime_type text,
  detected_type text,
  size_bytes bigint,
  visibility text not null default 'server',
  index_status text not null default 'unindexed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint server_resources_title_check
    check (char_length(btrim(title)) between 1 and 255),
  constraint server_resources_original_filename_check
    check (char_length(btrim(original_filename)) between 1 and 255),
  constraint server_resources_storage_bucket_check
    check (char_length(btrim(storage_bucket)) between 1 and 100),
  constraint server_resources_storage_path_check
    check (char_length(btrim(storage_path)) between 1 and 1024),
  constraint server_resources_declared_mime_type_check
    check (
      declared_mime_type is null
      or char_length(declared_mime_type) <= 255
    ),
  constraint server_resources_detected_type_check
    check (
      detected_type is null
      or detected_type in ('pdf', 'docx', 'txt')
    ),
  constraint server_resources_size_bytes_check
    check (size_bytes is null or size_bytes > 0),
  constraint server_resources_visibility_check
    check (visibility in ('server', 'private')),
  constraint server_resources_index_status_check
    check (
      index_status in (
        'unindexed',
        'pending',
        'processing',
        'ready',
        'failed',
        'unsupported'
      )
    ),
  constraint server_resources_private_storage_check
    check (
      visibility <> 'private'
      or storage_bucket <> 'channel-files'
    ),
  constraint server_resources_timestamps_check
    check (updated_at >= created_at),
  constraint server_resources_storage_object_key
    unique (storage_bucket, storage_path),
  constraint server_resources_id_server_key
    unique (id, server_id)
);

create index idx_server_resources_server_created
  on public.server_resources(server_id, created_at desc, id);

create index idx_server_resources_uploader
  on public.server_resources(uploader_id);

create index idx_server_resources_server_visibility_status
  on public.server_resources(server_id, visibility, index_status);

create or replace function public.set_server_resources_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.set_server_resources_updated_at() from public;

create trigger set_server_resources_updated_at
before update on public.server_resources
for each row
execute function public.set_server_resources_updated_at();

alter table public.message_attachments
  add column resource_id uuid;

alter table public.message_attachments
  add constraint message_attachments_resource_server_fk
  foreign key (resource_id, server_id)
  references public.server_resources(id, server_id)
  on delete set null (resource_id);

create index idx_message_attachments_resource_id
  on public.message_attachments(resource_id)
  where resource_id is not null;

alter table public.server_resources enable row level security;

drop policy if exists "server_resources_select_visible" on public.server_resources;
create policy "server_resources_select_visible"
on public.server_resources
for select
to authenticated
using (
  public.is_server_member(server_id, auth.uid())
  and (
    visibility = 'server'
    or (
      visibility = 'private'
      and uploader_id = auth.uid()
    )
  )
);

-- Direct INSERT remains ungranted in this phase. This policy is an additional
-- guard for any future caller-scoped insertion path.
drop policy if exists "server_resources_insert_owned_attachment" on public.server_resources;
create policy "server_resources_insert_owned_attachment"
on public.server_resources
for insert
to authenticated
with check (
  uploader_id = auth.uid()
  and public.is_server_member(server_id, auth.uid())
  and visibility = 'server'
  and index_status = 'unindexed'
  and detected_type is null
  and storage_bucket = 'channel-files'
  and lower(original_filename) ~ '\.(pdf|docx|txt)$'
  and exists (
    select 1
    from public.message_attachments as attachment
    join public.messages as message
      on message.id = attachment.message_id
    join public.channels as channel
      on channel.id = attachment.channel_id
    where attachment.resource_id is null
      and attachment.user_id = auth.uid()
      and attachment.server_id = server_resources.server_id
      and attachment.server_id = message.server_id
      and attachment.channel_id = message.channel_id
      and attachment.user_id = message.user_id
      and message.server_id = channel.server_id
      and attachment.server_id = channel.server_id
      and attachment.storage_path = server_resources.storage_path
      and attachment.file_name = server_resources.original_filename
      and attachment.file_type is not distinct from server_resources.declared_mime_type
      and (
        case
          when attachment.file_size > 0 then attachment.file_size
          else null
        end
      ) is not distinct from server_resources.size_bytes
  )
);

drop policy if exists "server_resources_update_by_uploader" on public.server_resources;
create policy "server_resources_update_by_uploader"
on public.server_resources
for update
to authenticated
using (
  uploader_id = auth.uid()
  and public.is_server_member(server_id, auth.uid())
)
with check (
  uploader_id = auth.uid()
  and public.is_server_member(server_id, auth.uid())
  and (
    visibility = 'server'
    or (
      visibility = 'private'
      and storage_bucket <> 'channel-files'
    )
  )
);

drop policy if exists "server_resources_delete_by_owner_or_manager" on public.server_resources;
create policy "server_resources_delete_by_owner_or_manager"
on public.server_resources
for delete
to authenticated
using (
  (
    uploader_id = auth.uid()
    and public.is_server_member(server_id, auth.uid())
  )
  or (
    visibility = 'server'
    and public.can_manage_server(server_id, auth.uid())
  )
);

revoke all on table public.server_resources from anon, authenticated;
grant select, delete on table public.server_resources to authenticated;
grant update (title) on table public.server_resources to authenticated;

create or replace function public.register_server_resource_from_attachment(
  p_attachment_id uuid,
  p_title text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_attachment record;
  v_resource_id uuid;
  v_title text;
begin
  if v_actor_id is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  select
    attachment.id,
    attachment.resource_id,
    attachment.server_id,
    attachment.channel_id,
    attachment.user_id,
    attachment.file_name,
    attachment.file_type,
    attachment.file_size,
    attachment.storage_path,
    message.server_id as message_server_id,
    message.channel_id as message_channel_id,
    message.user_id as message_user_id,
    channel.server_id as channel_server_id
  into v_attachment
  from public.message_attachments as attachment
  join public.messages as message
    on message.id = attachment.message_id
  join public.channels as channel
    on channel.id = attachment.channel_id
  where attachment.id = p_attachment_id
  for update of attachment;

  if not found then
    raise exception 'attachment not found'
      using errcode = 'P0002';
  end if;

  if v_attachment.user_id is distinct from v_actor_id
     or v_attachment.message_user_id is distinct from v_actor_id then
    raise exception 'attachment is not owned by the authenticated user'
      using errcode = '42501';
  end if;

  if not public.is_server_member(v_attachment.server_id, v_actor_id) then
    raise exception 'server membership required'
      using errcode = '42501';
  end if;

  if v_attachment.server_id is distinct from v_attachment.message_server_id
     or v_attachment.channel_id is distinct from v_attachment.message_channel_id
     or v_attachment.message_server_id is distinct from v_attachment.channel_server_id
     or v_attachment.server_id is distinct from v_attachment.channel_server_id then
    raise exception 'attachment, message, and channel scope do not match'
      using errcode = '23514';
  end if;

  -- The extension classifies a candidate only. No file bytes are trusted or
  -- inspected here; Phase 18.2 performs authoritative validation.
  if v_attachment.file_name is null
     or lower(v_attachment.file_name) !~ '\.(pdf|docx|txt)$' then
    raise exception 'attachment is not a supported RAG 2 candidate'
      using errcode = '22023';
  end if;

  if char_length(btrim(v_attachment.file_name)) not between 1 and 255
     or v_attachment.storage_path is null
     or char_length(btrim(v_attachment.storage_path)) not between 1 and 1024 then
    raise exception 'attachment metadata is invalid'
      using errcode = '22023';
  end if;

  v_title := coalesce(nullif(btrim(p_title), ''), v_attachment.file_name);
  if char_length(v_title) not between 1 and 255 then
    raise exception 'resource title must be between 1 and 255 characters'
      using errcode = '22023';
  end if;

  if v_attachment.resource_id is not null then
    return v_attachment.resource_id;
  end if;

  insert into public.server_resources (
    server_id,
    uploader_id,
    title,
    original_filename,
    storage_bucket,
    storage_path,
    declared_mime_type,
    detected_type,
    size_bytes,
    visibility,
    index_status
  )
  values (
    v_attachment.server_id,
    v_actor_id,
    v_title,
    v_attachment.file_name,
    'channel-files',
    v_attachment.storage_path,
    case
      when char_length(v_attachment.file_type) <= 255
        then v_attachment.file_type
      else null
    end,
    null,
    case
      when v_attachment.file_size > 0
        then v_attachment.file_size
      else null
    end,
    'server',
    'unindexed'
  )
  on conflict (storage_bucket, storage_path) do nothing
  returning id into v_resource_id;

  if v_resource_id is null then
    select resource.id
    into v_resource_id
    from public.server_resources as resource
    where resource.storage_bucket = 'channel-files'
      and resource.storage_path = v_attachment.storage_path
      and resource.server_id = v_attachment.server_id;

    if v_resource_id is null then
      raise exception 'storage object is already registered to another server'
        using errcode = '23505';
    end if;
  end if;

  update public.message_attachments
  set resource_id = v_resource_id
  where id = v_attachment.id;

  return v_resource_id;
end;
$$;

revoke all on function public.register_server_resource_from_attachment(uuid, text)
  from public;
revoke all on function public.register_server_resource_from_attachment(uuid, text)
  from anon;
grant execute
  on function public.register_server_resource_from_attachment(uuid, text)
  to authenticated;

commit;
