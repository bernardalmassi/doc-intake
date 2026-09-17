-- Uploaded documents and their files. Rows live in public.documents; the
-- file itself lives in the private "documents" storage bucket under
-- <tenant_id>/..., and both are scoped by tenant membership.

create type public.document_status as enum (
  'pending', 'processing', 'extracted', 'needs_review', 'failed'
);

create table public.documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  -- nullable so a document outlives the account that uploaded it
  uploaded_by  uuid default auth.uid() references auth.users (id) on delete set null,
  -- must sit under the tenant's folder so row and object scoping agree
  storage_path text not null unique
               check (split_part(storage_path, '/', 1) = tenant_id::text),
  filename     text not null check (length(trim(filename)) > 0),
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes >= 0),
  status       public.document_status not null default 'pending',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index documents_tenant_id_created_at_idx on public.documents (tenant_id, created_at desc);
create index documents_uploaded_by_idx          on public.documents (uploaded_by);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

alter table public.documents enable row level security;

create policy documents_select_member on public.documents
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- members can only record uploads as themselves
create policy documents_insert_member on public.documents
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and uploaded_by = (select auth.uid())
  );

create policy documents_update_member on public.documents
  for update to authenticated
  using (public.is_tenant_member(tenant_id))
  with check (public.is_tenant_member(tenant_id));

create policy documents_delete_admin on public.documents
  for delete to authenticated
  using (public.is_tenant_admin(tenant_id));

-- auto-expose is off. Update is column-scoped so tenant_id, uploaded_by and
-- storage_path can't be rewritten after insert.
grant select, insert, delete      on public.documents to authenticated;
grant update (filename, status)   on public.documents to authenticated;

-- Storage ---------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- First folder of an object name as a tenant id, or null when it isn't a
-- uuid. Policies on storage.objects see every bucket's rows and Postgres
-- doesn't promise to test bucket_id first, so a bare ::uuid cast could raise
-- on some unrelated object's path.
create or replace function public.storage_tenant_id(p_name text)
returns uuid language sql stable set search_path = '' as $$
  select case
    when (storage.foldername(p_name))[1]
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then ((storage.foldername(p_name))[1])::uuid
  end;
$$;

create policy documents_objects_select_member on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and public.is_tenant_member(public.storage_tenant_id(name))
  );

create policy documents_objects_insert_member on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and public.is_tenant_member(public.storage_tenant_id(name))
  );

create policy documents_objects_update_member on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and public.is_tenant_member(public.storage_tenant_id(name))
  )
  with check (
    bucket_id = 'documents'
    and public.is_tenant_member(public.storage_tenant_id(name))
  );

-- matches the table: only admins remove documents
create policy documents_objects_delete_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.is_tenant_admin(public.storage_tenant_id(name))
  );
