-- Phase 16.2: optional server icons with manager-only Storage writes.
-- Review and run manually in the Supabase SQL Editor.

begin;

alter table public.servers
  add column if not exists icon_path text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.servers'::regclass
      and conname = 'servers_icon_path_format_check'
  ) then
    alter table public.servers
      add constraint servers_icon_path_format_check
      check (
        icon_path is null
        or icon_path ~ (
          '^'
          || id::text
          || '/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
        )
      );
  end if;
end $$;

-- Phase 14 already grants authenticated users column-level UPDATE on name
-- and description. Add only the new column; row access remains protected by
-- the existing servers_update_by_managers RLS policy.
grant update (icon_path) on public.servers to authenticated;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'server-icons',
  'server-icons',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public bucket URLs are readable without a storage.objects SELECT policy.
-- Managers receive scoped SELECT access so the explicit UPDATE policy is
-- usable through the Storage API; UPDATE operations require SELECT as well.
drop policy if exists "server_icons_select_for_managers" on storage.objects;
create policy "server_icons_select_for_managers"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'server-icons'
  and array_length(storage.foldername(name), 1) = 1
  and storage.filename(name)
    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
  and exists (
    select 1
    from public.servers as server
    where server.id::text = (storage.foldername(name))[1]
      and public.can_manage_server(server.id, auth.uid())
  )
);

drop policy if exists "server_icons_insert_by_managers" on storage.objects;
create policy "server_icons_insert_by_managers"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'server-icons'
  and array_length(storage.foldername(name), 1) = 1
  and storage.filename(name)
    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
  and exists (
    select 1
    from public.servers as server
    where server.id::text = (storage.foldername(name))[1]
      and public.can_manage_server(server.id, auth.uid())
  )
);

drop policy if exists "server_icons_update_by_managers" on storage.objects;
create policy "server_icons_update_by_managers"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'server-icons'
  and array_length(storage.foldername(name), 1) = 1
  and storage.filename(name)
    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
  and exists (
    select 1
    from public.servers as server
    where server.id::text = (storage.foldername(name))[1]
      and public.can_manage_server(server.id, auth.uid())
  )
)
with check (
  bucket_id = 'server-icons'
  and array_length(storage.foldername(name), 1) = 1
  and storage.filename(name)
    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
  and exists (
    select 1
    from public.servers as server
    where server.id::text = (storage.foldername(name))[1]
      and public.can_manage_server(server.id, auth.uid())
  )
);

drop policy if exists "server_icons_delete_by_managers" on storage.objects;
create policy "server_icons_delete_by_managers"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'server-icons'
  and array_length(storage.foldername(name), 1) = 1
  and storage.filename(name)
    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'
  and exists (
    select 1
    from public.servers as server
    where server.id::text = (storage.foldername(name))[1]
      and public.can_manage_server(server.id, auth.uid())
  )
);

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
      and tablename = 'servers'
  ) then
    alter publication supabase_realtime add table public.servers;
  end if;
end $$;

commit;
