-- Phase 14: server roles, permissions, bans, basic settings, and RLS
-- Review and run manually in the Supabase SQL Editor.

begin;

alter table public.servers
  add column if not exists description text;

create table if not exists public.server_bans (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  banned_by uuid not null references public.profiles(id),
  reason text,
  created_at timestamptz not null default now(),
  constraint server_bans_actor_target_check check (banned_by <> user_id),
  unique (server_id, user_id)
);

do $$
begin
  if exists (
    select 1
    from public.server_members
    group by server_id, user_id
    having count(*) > 1
  ) then
    raise exception 'server_members contains duplicate (server_id, user_id) rows; remove duplicates and rerun';
  end if;

  if exists (
    select 1
    from public.server_members
    where role is null or role not in ('owner', 'admin', 'member')
  ) then
    raise exception 'server_members contains an invalid role; use owner, admin, or member and rerun';
  end if;

  if exists (
    select 1
    from public.servers s
    left join public.server_members sm
      on sm.server_id = s.id
     and sm.role = 'owner'
    group by s.id
    having count(sm.user_id) <> 1
  ) then
    raise exception 'every server must have exactly one owner membership; repair the data and rerun';
  end if;

  if exists (
    select 1
    from public.servers s
    join public.server_members sm
      on sm.server_id = s.id
     and sm.role = 'owner'
    where sm.user_id is distinct from s.owner_id
  ) then
    raise exception 'servers.owner_id must match its owner membership; repair the data and rerun';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.server_bans'::regclass
      and conname = 'server_bans_actor_target_check'
  ) then
    alter table public.server_bans
      add constraint server_bans_actor_target_check check (banned_by <> user_id);
  end if;
end $$;

create index if not exists idx_server_bans_server_id on public.server_bans(server_id);
create index if not exists idx_server_bans_user_id on public.server_bans(user_id);
create unique index if not exists ux_server_bans_server_user
  on public.server_bans(server_id, user_id);
create index if not exists idx_server_members_server_id on public.server_members(server_id);
create index if not exists idx_server_members_user_id on public.server_members(user_id);
create unique index if not exists idx_server_members_one_owner
  on public.server_members(server_id)
  where role = 'owner';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.server_members'::regclass
      and conname = 'server_members_server_id_user_id_key'
  ) then
    alter table public.server_members
      add constraint server_members_server_id_user_id_key unique (server_id, user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.server_members'::regclass
      and conname = 'server_members_role_check'
  ) then
    alter table public.server_members
      add constraint server_members_role_check check (role in ('owner', 'admin', 'member'));
  end if;
end $$;

create or replace function public.is_server_member(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.server_members sm
    where sm.server_id = p_server_id
      and sm.user_id = p_user_id
  );
$$;

create or replace function public.server_member_role(p_server_id uuid, p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select sm.role
  from public.server_members sm
  where sm.server_id = p_server_id
    and sm.user_id = p_user_id
  limit 1;
$$;

create or replace function public.can_manage_server(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.server_member_role(p_server_id, p_user_id) in ('owner', 'admin'), false);
$$;

create or replace function public.is_server_owner(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.server_member_role(p_server_id, p_user_id) = 'owner', false);
$$;

create or replace function public.transfer_server_ownership(
  p_server_id uuid,
  p_current_owner_id uuid,
  p_new_owner_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
begin
  select s.owner_id
  into v_owner_id
  from public.servers s
  where s.id = p_server_id
  for update;

  if v_owner_id is null then
    raise exception 'server not found';
  end if;

  if v_owner_id <> p_current_owner_id then
    raise exception 'must be server owner';
  end if;

  if p_current_owner_id = p_new_owner_id then
    raise exception 'new owner must be different';
  end if;

  if not exists (
    select 1 from public.server_members
    where server_id = p_server_id and user_id = p_new_owner_id
  ) then
    raise exception 'new owner must be a current server member';
  end if;

  perform set_config('studycord.allow_owner_transfer', 'on', true);

  update public.server_members
  set role = 'admin'
  where server_id = p_server_id and role = 'owner';

  update public.server_members
  set role = 'owner'
  where server_id = p_server_id and user_id = p_new_owner_id;

  update public.servers
  set owner_id = p_new_owner_id
  where id = p_server_id;

  if (select count(*) from public.server_members where server_id = p_server_id and role = 'owner') <> 1 then
    raise exception 'ownership transfer must leave exactly one owner';
  end if;
end;
$$;

create or replace function public.prevent_direct_server_owner_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.owner_id is distinct from old.owner_id
     and coalesce(current_setting('studycord.allow_owner_transfer', true), 'off') <> 'on' then
    raise exception 'server ownership must be changed with transfer_server_ownership';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_direct_server_owner_change on public.servers;
create trigger prevent_direct_server_owner_change
before update of owner_id on public.servers
for each row
execute function public.prevent_direct_server_owner_change();

create or replace function public.prevent_owner_membership_removal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.role = 'owner'
     and coalesce(current_setting('studycord.allow_owner_transfer', true), 'off') <> 'on'
     and exists (
       select 1
       from public.servers s
       where s.id = old.server_id
     ) then
    raise exception 'transfer ownership before changing or removing the owner membership';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_owner_membership_removal on public.server_members;
create trigger prevent_owner_membership_removal
before delete or update of role on public.server_members
for each row
when (old.role = 'owner')
execute function public.prevent_owner_membership_removal();

create or replace function public.reject_banned_server_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.server_bans b
    where b.server_id = new.server_id
      and b.user_id = new.user_id
  ) then
    raise exception 'user is banned from this server' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists reject_banned_server_member on public.server_members;
create trigger reject_banned_server_member
before insert or update of server_id, user_id on public.server_members
for each row
execute function public.reject_banned_server_member();

create or replace function public.remove_banned_server_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.server_members
  where server_id = new.server_id
    and user_id = new.user_id
    and role <> 'owner';

  return new;
end;
$$;

create or replace function public.reject_server_owner_ban()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.banned_by = new.user_id then
    raise exception 'users cannot ban themselves' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.servers s
    where s.id = new.server_id
      and s.owner_id = new.user_id
  ) then
    raise exception 'the server owner cannot be banned' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists reject_server_owner_ban on public.server_bans;
create trigger reject_server_owner_ban
before insert or update of server_id, user_id, banned_by on public.server_bans
for each row
execute function public.reject_server_owner_ban();

drop trigger if exists remove_banned_server_member on public.server_bans;
create trigger remove_banned_server_member
after insert on public.server_bans
for each row
execute function public.remove_banned_server_member();

revoke all on function public.is_server_member(uuid, uuid) from public;
revoke all on function public.server_member_role(uuid, uuid) from public;
revoke all on function public.can_manage_server(uuid, uuid) from public;
revoke all on function public.is_server_owner(uuid, uuid) from public;
grant execute on function public.is_server_member(uuid, uuid) to authenticated;
grant execute on function public.server_member_role(uuid, uuid) to authenticated;
grant execute on function public.can_manage_server(uuid, uuid) to authenticated;
grant execute on function public.is_server_owner(uuid, uuid) to authenticated;

-- Ownership is transferred only by the trusted backend after it authenticates
-- and authorizes the acting user. Never expose the service-role key to clients.
revoke all on function public.transfer_server_ownership(uuid, uuid, uuid) from public;
revoke all on function public.transfer_server_ownership(uuid, uuid, uuid) from anon;
revoke all on function public.transfer_server_ownership(uuid, uuid, uuid) from authenticated;
grant execute on function public.transfer_server_ownership(uuid, uuid, uuid) to service_role;
revoke all on function public.reject_banned_server_member() from public;
revoke all on function public.remove_banned_server_member() from public;
revoke all on function public.reject_server_owner_ban() from public;
revoke all on function public.prevent_owner_membership_removal() from public;

alter table public.servers enable row level security;
alter table public.server_members enable row level security;
alter table public.server_bans enable row level security;
alter table public.channels enable row level security;

drop policy if exists "servers_select_for_members" on public.servers;
create policy "servers_select_for_members"
on public.servers
for select
to authenticated
using (public.is_server_member(id, auth.uid()));

drop policy if exists "servers_insert_own_server" on public.servers;
create policy "servers_insert_own_server"
on public.servers
for insert
to authenticated
with check (owner_id = auth.uid());

drop policy if exists "servers_update_by_managers" on public.servers;
create policy "servers_update_by_managers"
on public.servers
for update
to authenticated
using (public.can_manage_server(id, auth.uid()))
with check (public.can_manage_server(id, auth.uid()));

-- Authenticated clients may edit only ordinary settings. The backend service
-- role handles invite regeneration and the ownership RPC handles owner_id.
revoke update on public.servers from anon, authenticated;
grant update (name, description) on public.servers to authenticated;

drop policy if exists "servers_delete_by_owner" on public.servers;
create policy "servers_delete_by_owner"
on public.servers
for delete
to authenticated
using (public.is_server_owner(id, auth.uid()));

drop policy if exists "server_members_select_for_server_members" on public.server_members;
create policy "server_members_select_for_server_members"
on public.server_members
for select
to authenticated
using (public.is_server_member(server_id, auth.uid()));

drop policy if exists "server_members_insert_self_as_member" on public.server_members;
create policy "server_members_insert_self_as_member"
on public.server_members
for insert
to authenticated
with check (
  user_id = auth.uid()
  and role = 'member'
  and not exists (
    select 1 from public.server_bans b
    where b.server_id = server_members.server_id
      and b.user_id = auth.uid()
  )
);

drop policy if exists "server_members_insert_owner_for_owned_server" on public.server_members;
create policy "server_members_insert_owner_for_owned_server"
on public.server_members
for insert
to authenticated
with check (
  user_id = auth.uid()
  and role = 'owner'
  and exists (
    select 1 from public.servers s
    where s.id = server_members.server_id
      and s.owner_id = auth.uid()
  )
);

drop policy if exists "server_members_update_by_owner" on public.server_members;
create policy "server_members_update_by_owner"
on public.server_members
for update
to authenticated
using (public.is_server_owner(server_id, auth.uid()))
with check (public.is_server_owner(server_id, auth.uid()));

revoke update on public.server_members from anon, authenticated;
grant update (role) on public.server_members to authenticated;

drop policy if exists "server_members_delete_by_hierarchy" on public.server_members;
create policy "server_members_delete_by_hierarchy"
on public.server_members
for delete
to authenticated
using (
  (user_id = auth.uid() and role <> 'owner')
  or (
    public.server_member_role(server_id, auth.uid()) = 'owner'
    and role <> 'owner'
  )
  or (
    public.server_member_role(server_id, auth.uid()) = 'admin'
    and role = 'member'
    and user_id <> auth.uid()
  )
);

drop policy if exists "server_bans_select_owner_only" on public.server_bans;
create policy "server_bans_select_owner_only"
on public.server_bans
for select
to authenticated
using (public.is_server_owner(server_id, auth.uid()));

drop policy if exists "server_bans_insert_by_managers" on public.server_bans;
create policy "server_bans_insert_by_managers"
on public.server_bans
for insert
to authenticated
with check (
  banned_by = auth.uid()
  and user_id <> auth.uid()
  and (
    public.server_member_role(server_id, auth.uid()) = 'owner'
    or (
      public.server_member_role(server_id, auth.uid()) = 'admin'
      and coalesce(public.server_member_role(server_id, user_id), 'member') = 'member'
    )
  )
);

drop policy if exists "server_bans_delete_owner_only" on public.server_bans;
create policy "server_bans_delete_owner_only"
on public.server_bans
for delete
to authenticated
using (public.is_server_owner(server_id, auth.uid()));

drop policy if exists "channels_select_for_members" on public.channels;
create policy "channels_select_for_members"
on public.channels
for select
to authenticated
using (public.is_server_member(server_id, auth.uid()));

drop policy if exists "channels_insert_by_managers" on public.channels;
create policy "channels_insert_by_managers"
on public.channels
for insert
to authenticated
with check (public.can_manage_server(server_id, auth.uid()));

drop policy if exists "channels_update_by_managers" on public.channels;
create policy "channels_update_by_managers"
on public.channels
for update
to authenticated
using (public.can_manage_server(server_id, auth.uid()))
with check (public.can_manage_server(server_id, auth.uid()));

drop policy if exists "channels_delete_by_managers" on public.channels;
create policy "channels_delete_by_managers"
on public.channels
for delete
to authenticated
using (public.can_manage_server(server_id, auth.uid()));

commit;
