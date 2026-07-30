-- Phase 16.2.1: route server-icon writes through the authorized backend.
-- Review and run manually in the Supabase SQL Editor.

begin;

-- The server-icons bucket remains public for rendering, with its existing
-- 2 MB limit and JPEG/PNG/WebP allowlist. Browser clients no longer write
-- objects directly; trusted backend Storage calls occur only after the
-- existing manage_server authorization check.
drop policy if exists "server_icons_insert_by_managers" on storage.objects;
drop policy if exists "server_icons_update_by_managers" on storage.objects;
drop policy if exists "server_icons_delete_by_managers" on storage.objects;

-- Public bucket URLs do not require an authenticated SELECT policy.
drop policy if exists "server_icons_select_for_managers" on storage.objects;

commit;
