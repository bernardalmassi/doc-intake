-- Let signed-in users delete their own tenants and accounts without the
-- service role. The tenant isolation test relies on these to clean up after
-- itself using only publishable-key sessions.

-- Owner-only. Memberships and documents rows go with the tenant via
-- on delete cascade. Storage objects can't be deleted from SQL (Supabase's
-- storage.protect_delete trigger blocks it), so the caller must remove the
-- tenant's files through the Storage API first; otherwise they'd be orphaned
-- with no member left who can reach them.
create or replace function public.delete_tenant(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_tenant_owner(p_tenant_id) then
    raise exception 'only an owner can delete a tenant'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'documents'
      and o.name like p_tenant_id::text || '/%'
  ) then
    raise exception 'remove the tenant''s files from storage before deleting it'
      using errcode = '55000';
  end if;

  delete from public.tenants where id = p_tenant_id;
end;
$$;

-- Refuses while the caller still owns a tenant, so an account can't be
-- deleted out from under a tenant and leave it ownerless. Memberships
-- cascade; documents.uploaded_by is set to null.
create or replace function public.delete_own_account()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.memberships m
    where m.user_id = v_user_id and m.role = 'owner'
  ) then
    raise exception 'delete your tenants or transfer ownership first'
      using errcode = '55000';
  end if;

  delete from auth.users where id = v_user_id;
end;
$$;

revoke execute on function public.delete_tenant(uuid)    from public, anon;
revoke execute on function public.delete_own_account()   from public, anon;
grant  execute on function public.delete_tenant(uuid)    to authenticated;
grant  execute on function public.delete_own_account()   to authenticated;
