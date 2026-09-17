-- Close a privilege escalation in the membership policies: any admin could
-- update any membership in their tenant, including their own, so an admin
-- could promote themselves to owner or demote the real owner.
--
-- New rules:
--   * nobody changes their own membership role
--   * only owners can grant the owner role or modify/remove an owner's membership
--   * admins still manage member and admin memberships of other users
--   * only the role column is updatable, so a membership can't be moved to
--     another user or tenant

create or replace function private.is_tenant_owner(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;

revoke execute on function private.is_tenant_owner(uuid) from public, anon;
grant  execute on function private.is_tenant_owner(uuid) to authenticated;

drop policy memberships_insert_admin on public.memberships;
drop policy memberships_update_admin on public.memberships;
drop policy memberships_delete_admin on public.memberships;

create policy memberships_insert_admin on public.memberships
  for insert to authenticated
  with check (
    private.is_tenant_admin(tenant_id)
    and (role <> 'owner' or private.is_tenant_owner(tenant_id))
  );

-- using sees the row before the update, with check sees it after, so the
-- owner rule covers both demoting an owner and promoting someone to owner
create policy memberships_update_admin on public.memberships
  for update to authenticated
  using (
    private.is_tenant_admin(tenant_id)
    and user_id <> (select auth.uid())
    and (role <> 'owner' or private.is_tenant_owner(tenant_id))
  )
  with check (
    private.is_tenant_admin(tenant_id)
    and user_id <> (select auth.uid())
    and (role <> 'owner' or private.is_tenant_owner(tenant_id))
  );

create policy memberships_delete_admin on public.memberships
  for delete to authenticated
  using (
    private.is_tenant_admin(tenant_id)
    and (role <> 'owner' or private.is_tenant_owner(tenant_id))
  );

revoke update on public.memberships from authenticated;
grant  update (role) on public.memberships to authenticated;
