-- Every tenant keeps at least one owner. Without this, a sole owner could
-- delete their own membership, or two owners could remove or demote each
-- other at the same time, leaving a tenant nobody can administer or delete.
--
-- Policies can't enforce this: they see one row at a time and can't account
-- for concurrent transactions. A trigger locks the tenant row, so changes to
-- a tenant's owners run one after another, and each re-checks what's left.
--
-- Changing your own role was already blocked by memberships_update_admin
-- (migration 000004). This covers deletion and every path that isn't the
-- API: the dashboard, service_role, and cascades from auth.users.

create or replace function private.enforce_tenant_has_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Only removing an owner from a tenant can leave it ownerless. NEW is null
  -- in a DELETE trigger, so check tg_op before touching it.
  if old.role <> 'owner' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.tenant_id = old.tenant_id then
    return new;
  end if;

  -- Serialize owner changes per tenant. In READ COMMITTED each statement
  -- below takes a fresh snapshot, so it sees owner removals committed by
  -- whoever held the lock first.
  perform 1 from public.tenants t where t.id = old.tenant_id for update;

  -- The tenant is being deleted (delete_tenant cascades to memberships).
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.tenant_id = old.tenant_id
      and m.role = 'owner'
      and m.id <> old.id
  ) then
    raise exception 'a tenant must keep at least one owner'
      using errcode = '23514',
            hint = 'Make another member an owner first, or delete the tenant.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Trigger functions can't be called through the API, and EXECUTE isn't
-- checked when a trigger fires, so nobody needs it.
revoke execute on function private.enforce_tenant_has_owner() from public, anon, authenticated;

create trigger memberships_keep_an_owner
  before update or delete on public.memberships
  for each row execute function private.enforce_tenant_has_owner();
