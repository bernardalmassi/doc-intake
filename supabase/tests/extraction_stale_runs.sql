-- Tests the stale-run reaper in open_extraction_run against the linked
-- project, inside a transaction that is always rolled back. Run with
--   npm run test:db
-- It creates two throwaway users, a tenant and a document as postgres, then
-- acts as the tenant's owner through auth.uid(). Every check raises on
-- failure, so a non-zero exit is a failed test; the final select lists what
-- was checked.
--
-- This lives in SQL rather than in Vitest because the reaper only acts on a
-- run older than extraction_limits.stale_run_minutes, and nothing reachable
-- through the API can backdate started_at.
begin;

create temp table checks (n serial, step text, result text);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
values ('a1a1a1a1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated',
  'authenticated', 'stale-test-owner@example.invalid', 'x', now(), now(), now(), '{}', '{}', false, false);

insert into public.tenants (id, name, slug)
values ('b2b2b2b2-0000-4000-8000-000000000002', 'Stale run test', 'stale-run-test');
insert into public.memberships (tenant_id, user_id, role)
values ('b2b2b2b2-0000-4000-8000-000000000002', 'a1a1a1a1-0000-4000-8000-000000000001', 'owner');
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
values ('c3c3c3c3-0000-4000-8000-000000000003', 'b2b2b2b2-0000-4000-8000-000000000002', 'stale.pdf',
  'a1a1a1a1-0000-4000-8000-000000000001', 'needs_review', 'application/pdf', 100);

-- act as the owner
select set_config('request.jwt.claims',
  '{"sub":"a1a1a1a1-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $t$
declare
  v_first    record;
  v_second   record;
  v_run      public.extraction_runs;
  v_doc      public.documents;
  v_minutes  integer := (select stale_run_minutes from public.extraction_limits);
  v_closed   public.extraction_runs;
begin
  -- 1. open a run and leave it running
  select * into v_first from public.open_extraction_run('c3c3c3c3-0000-4000-8000-000000000003');
  select * into v_doc from public.documents where id = 'c3c3c3c3-0000-4000-8000-000000000003';
  if v_doc.status <> 'processing' then
    raise exception 'expected processing after open, got %', v_doc.status;
  end if;
  insert into checks (step, result) values ('open leaves the document processing', 'ok');

  -- 2. a second open just under the threshold is refused
  update public.extraction_runs set started_at = now() - make_interval(mins => v_minutes) + interval '30 seconds'
  where id = v_first.run_id;
  begin
    perform public.open_extraction_run('c3c3c3c3-0000-4000-8000-000000000003');
    raise exception 'a run % seconds short of stale was reaped', 30;
  exception when sqlstate '55000' then
    insert into checks (step, result) values ('a run younger than the threshold still blocks', sqlerrm);
  end;

  -- 3. past the threshold: the next open reaps it and proceeds
  update public.extraction_runs set started_at = now() - make_interval(mins => v_minutes) - interval '1 second'
  where id = v_first.run_id;
  select * into v_second from public.open_extraction_run('c3c3c3c3-0000-4000-8000-000000000003');
  if v_second.run_id = v_first.run_id then
    raise exception 'the reaped run was returned again';
  end if;

  select * into v_run from public.extraction_runs where id = v_first.run_id;
  if v_run.status <> 'failed' or v_run.finished_at is null or v_run.error not like 'abandoned: still running after % minutes%' then
    raise exception 'stale run not failed as expected: % / % / %', v_run.status, v_run.finished_at, v_run.error;
  end if;
  if v_run.cost_usd is not null then
    raise exception 'a reaped run must not record a cost, got %', v_run.cost_usd;
  end if;
  insert into checks (step, result) values ('stale run failed with a reason', v_run.error);

  -- the new run's previous status is the one the stale run had restored
  select * into v_run from public.extraction_runs where id = v_second.run_id;
  if v_run.status <> 'running' or v_run.previous_document_status <> 'needs_review' then
    raise exception 'new run should be running with previous status needs_review, got % / %',
      v_run.status, v_run.previous_document_status;
  end if;
  insert into checks (step, result) values ('new run opened with the restored previous status', v_run.previous_document_status::text);

  -- 4. the stale run's token no longer works: a late close is refused
  begin
    perform public.close_extraction_run(v_first.run_id, v_first.close_token, 'failed',
      null, null, 0, 0, 1, 0, 'late');
    raise exception 'late close of a reaped run was accepted';
  exception when sqlstate '42501' then
    insert into checks (step, result) values ('late close of the reaped run is refused', sqlerrm);
  end;

  -- 5. closing the new run as failed restores needs_review
  v_closed := public.close_extraction_run(v_second.run_id, v_second.close_token, 'failed',
    null, null, 0, 0, 1, 0, 'test');
  select * into v_doc from public.documents where id = 'c3c3c3c3-0000-4000-8000-000000000003';
  if v_doc.status <> 'needs_review' then
    raise exception 'expected needs_review after failed close, got %', v_doc.status;
  end if;
  insert into checks (step, result) values ('document back to needs_review', 'ok');
end $t$;

select step, result from checks order by n;

rollback;
