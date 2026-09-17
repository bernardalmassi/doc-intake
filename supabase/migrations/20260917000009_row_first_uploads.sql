-- Row-first uploads: the documents row is created first, the browser then
-- uploads the file straight to Storage under the row's path, and an RPC
-- confirms the upload from the stored object's metadata.
--
--   1. insert into documents (tenant_id, filename)   -> row in 'uploading'
--   2. storage upload to <tenant_id>/<document_id>   -> only allowed for
--      that row's uploader while the row is 'uploading'
--   3. complete_document_upload(id)                  -> copies size and
--      mimetype from the object, sets 'pending'
--
-- Closes the upload gaps from SECURITY.md: files without rows, rows without
-- files, client-reported size and type, members overwriting each other's
-- files, and clients choosing status or storage_path.

-- Documents ---------------------------------------------------------------

-- storage_path is now derived from the row, so a client can neither choose
-- it nor point a row at another file. Postgres can't turn an existing column
-- into a generated one, so drop and re-add. The linked project has no rows.
-- The old check (first segment = tenant_id) is implied by the expression.
alter table public.documents drop column storage_path;
alter table public.documents
  add column storage_path text
  generated always as (tenant_id::text || '/' || id::text) stored;
-- the storage insert policy looks rows up by path
alter table public.documents
  add constraint documents_storage_path_key unique (storage_path);

-- size and type are unknown until the object exists; the RPC fills them in
alter table public.documents alter column status set default 'uploading';
alter table public.documents alter column mime_type  drop not null;
alter table public.documents alter column size_bytes drop not null;
alter table public.documents
  add constraint documents_completed_have_metadata
  check (status = 'uploading' or (mime_type is not null and size_bytes is not null));

-- filename is one of the two columns a client writes: 1 to 255 characters,
-- not blank, no control characters (newlines, tabs, escapes, DEL).
alter table public.documents drop constraint documents_filename_check;
alter table public.documents
  add constraint documents_filename_check
  check (
    length(filename) between 1 and 255
    and length(trim(filename)) > 0
    and filename !~ '[[:cntrl:]]'
  );

-- Documents belong to the tenant, not the uploader. uploaded_by is already
-- nullable with "references auth.users on delete set null" (000002,
-- verified on the linked project), so deleting the uploader's account
-- leaves the row in place with uploaded_by null.

-- Clients may only supply tenant_id and filename. id, uploaded_by
-- (auth.uid()), status, storage_path and timestamps come from the database;
-- size_bytes, mime_type and status are written only by
-- complete_document_upload. Column grants reject anything else before RLS
-- is consulted.
revoke insert, update on public.documents from authenticated;
grant insert (tenant_id, filename) on public.documents to authenticated;
grant update (filename)            on public.documents to authenticated;

drop policy documents_insert_member on public.documents;
create policy documents_insert_member on public.documents
  for insert to authenticated
  with check (
    private.is_tenant_member(tenant_id)
    and uploaded_by = (select auth.uid())
    and status = 'uploading'
  );
-- Rename (the only grantable update) is for the uploader or a tenant admin,
-- and both must still be members. using sees the row before, with check the
-- row after; tenant_id and uploaded_by aren't updatable so they can't
-- change between the two.
drop policy documents_update_member on public.documents;
create policy documents_update_uploader_or_admin on public.documents
  for update to authenticated
  using (
    private.is_tenant_member(tenant_id)
    and (uploaded_by = (select auth.uid()) or private.is_tenant_admin(tenant_id))
  )
  with check (
    private.is_tenant_member(tenant_id)
    and (uploaded_by = (select auth.uid()) or private.is_tenant_admin(tenant_id))
  );
-- documents_select_member and documents_delete_admin are unchanged.

-- A row can't go while its file is still there. Together with the storage
-- insert policy below (no file without a row) every file in a tenant's
-- prefix is always reachable through a row an admin can see and delete, so
-- no orphan can block delete_tenant. Definer so it sees storage.objects
-- regardless of the caller's storage policies.
create or replace function private.refuse_document_delete_while_file_exists()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'documents'
      and o.name = old.storage_path
  ) then
    raise exception 'remove the document''s file from storage before deleting its row'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

revoke execute on function private.refuse_document_delete_while_file_exists()
  from public, anon, authenticated;

create trigger documents_keep_row_while_file_exists
  before delete on public.documents
  for each row execute function private.refuse_document_delete_while_file_exists();

-- Storage -----------------------------------------------------------------

update storage.buckets
set file_size_limit    = 10 * 1024 * 1024,
    allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg']
where id = 'documents';

-- An upload is allowed only into the path of a documents row that the caller
-- created, that is still waiting for its file, in a tenant the caller is
-- still a member of. Definer so the lookup doesn't depend on the caller's
-- documents policies.
create or replace function private.can_upload_document_file(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.documents d
    where d.storage_path = p_name
      and d.uploaded_by = (select auth.uid())
      and d.status = 'uploading'
      and private.is_tenant_member(d.tenant_id)
  );
$$;

revoke execute on function private.can_upload_document_file(text) from public, anon;
grant  execute on function private.can_upload_document_file(text) to authenticated;

drop policy documents_objects_insert_member on storage.objects;
create policy documents_objects_insert_uploader on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and private.can_upload_document_file(name)
  );

-- No update policy at all: nobody can overwrite (upsert) or move an object.
-- Upsert is insert ... on conflict do update, so it needs update rights too.
drop policy documents_objects_update_member on storage.objects;

-- documents_objects_select_member (member) and documents_objects_delete_admin
-- (admin, same as documents_delete_admin) are unchanged.

-- Completion --------------------------------------------------------------

-- Confirms that the file is in place and records what Storage actually
-- stored, rather than what the client claimed. Definer because it updates
-- columns the caller has no grant on, and reads storage.objects.
create or replace function public.complete_document_upload(p_document_id uuid)
returns public.documents language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_doc     public.documents;
  v_meta    jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- lock the row so two completions can't both pass the status check
  select d.* into v_doc from public.documents d
  where d.id = p_document_id
  for update;

  -- one error for missing and not-mine, so the RPC can't be used to probe ids
  if not found or v_doc.uploaded_by is distinct from v_user_id then
    raise exception 'document not found or not uploaded by you'
      using errcode = '42501';
  end if;

  if not private.is_tenant_member(v_doc.tenant_id) then
    raise exception 'you are no longer a member of this tenant'
      using errcode = '42501';
  end if;

  if v_doc.status <> 'uploading' then
    raise exception 'document is not waiting for an upload'
      using errcode = '55000';
  end if;

  select o.metadata into v_meta from storage.objects o
  where o.bucket_id = 'documents'
    and o.name = v_doc.storage_path;

  -- Storage writes metadata once the bytes are stored; a row without it is
  -- an upload that hasn't finished
  if not found or v_meta is null or (v_meta ->> 'size') is null then
    raise exception 'no file has been uploaded for this document'
      using errcode = '55000';
  end if;

  update public.documents
  set size_bytes = (v_meta ->> 'size')::bigint,
      mime_type  = v_meta ->> 'mimetype',
      status     = 'pending'
  where id = p_document_id
  returning * into v_doc;

  return v_doc;
end;
$$;

revoke execute on function public.complete_document_upload(uuid) from public, anon;
grant  execute on function public.complete_document_upload(uuid) to authenticated;
