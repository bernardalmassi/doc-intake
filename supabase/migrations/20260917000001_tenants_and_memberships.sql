-- Multi-tenant foundation. Every table added later carries tenant_id and
-- reuses the helper functions below in its own policies.

create extension if not exists pgcrypto;

create type public.tenant_role as enum ('owner', 'admin', 'member');

create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  slug       text not null unique check (slug ~ '^[a-z0-9-]{3,48}$'),
  created_at timestamptz not null default now()
);

create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.tenant_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index memberships_user_id_idx   on public.memberships (user_id);
create index memberships_tenant_id_idx on public.memberships (tenant_id);

-- security definer so a membership lookup inside a policy does not re-enter
-- RLS on memberships itself, which recurses forever.
create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_tenant_admin(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

-- tenant creation and its owner membership must happen together or not at all
create or replace function public.create_tenant(p_name text, p_slug text)
returns public.tenants language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_tenant  public.tenants;
begin
  if v_user_id is null then
    raise exception 'authentication required';
  end if;

  insert into public.tenants (name, slug)
  values (p_name, p_slug)
  returning * into v_tenant;

  insert into public.memberships (tenant_id, user_id, role)
  values (v_tenant.id, v_user_id, 'owner');

  return v_tenant;
end;
$$;

alter table public.tenants     enable row level security;
alter table public.memberships enable row level security;

create policy tenants_select_member on public.tenants
  for select to authenticated
  using (public.is_tenant_member(id));

create policy tenants_update_admin on public.tenants
  for update to authenticated
  using (public.is_tenant_admin(id))
  with check (public.is_tenant_admin(id));

create policy memberships_select_member on public.memberships
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy memberships_insert_admin on public.memberships
  for insert to authenticated
  with check (public.is_tenant_admin(tenant_id));

create policy memberships_update_admin on public.memberships
  for update to authenticated
  using (public.is_tenant_admin(tenant_id))
  with check (public.is_tenant_admin(tenant_id));

create policy memberships_delete_admin on public.memberships
  for delete to authenticated
  using (public.is_tenant_admin(tenant_id));

-- auto-expose is off on this project, so access is granted deliberately
grant select, update                 on public.tenants     to authenticated;
grant select, insert, update, delete on public.memberships to authenticated;

revoke execute on function public.create_tenant(text, text) from public, anon;
grant  execute on function public.create_tenant(text, text) to authenticated;
