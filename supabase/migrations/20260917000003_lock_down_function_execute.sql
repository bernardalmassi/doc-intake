-- Security advisor fixes (lints 0028/0029): SECURITY DEFINER functions in
-- public were callable over the API because Postgres grants EXECUTE to PUBLIC
-- by default.

-- The RLS helpers only need to be callable from inside policies, so move them
-- to a schema PostgREST doesn't expose. Policies reference functions by oid,
-- so every existing policy on tenants, memberships, documents and
-- storage.objects keeps working without being recreated.
create schema if not exists private;
grant usage on schema private to authenticated;

alter function public.is_tenant_member(uuid) set schema private;
alter function public.is_tenant_admin(uuid)  set schema private;

-- policies are all "to authenticated", so anon never needs these
revoke execute on function private.is_tenant_member(uuid) from public, anon;
revoke execute on function private.is_tenant_admin(uuid)  from public, anon;
grant  execute on function private.is_tenant_member(uuid) to authenticated;
grant  execute on function private.is_tenant_admin(uuid)  to authenticated;

-- rls_auto_enable is the platform's auto-enable-RLS event trigger function,
-- not ours. Event triggers fire regardless of EXECUTE, so nobody needs to be
-- able to call it directly.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- public.create_tenant stays callable by authenticated on purpose: it is the
-- tenant-creation RPC and has to be SECURITY DEFINER, since tenants has no
-- insert grant and a new user can't pass memberships_insert_admin yet.
