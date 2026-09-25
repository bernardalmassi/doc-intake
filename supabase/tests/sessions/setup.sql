-- The two-session lock-order tests (20260925000003, docs/worker-design.md
-- section 15), run by scripts/test-db.mjs against the TEST project, never
-- the app's. Unlike the files one level up, these commit: two sessions can
-- only see each other's rows once they are committed. pg_cron's
-- extraction-sweep job is paused around all the cases (sweep-pause.sql,
-- then sweep-resume.sql in a finally), so no live tick can reap a fixture
-- mid-case. Each case runs
--
--   cleanup.sql   removes anything a killed earlier run left
--   setup.sql     this file: a claimed run, committed
--   finish.sql    session F   } at the same time, each on its own
--   sweep.sql or  session S/C } connection (a separate db query)
--   claim.sql
--   check.sql     what the database recorded
--   cleanup.sql   again, whatever happened
--
-- The fixture is one user, one organization and one one-page document, with
-- fixed ids. It is enqueued as its owner and claimed as the worker would
-- claim it, so the run is 'running' with a claim token, and its message has
-- read_ct 1 and stays hidden for worker_visibility_seconds: the pg_cron sweep
-- leaves it alone until a session expires it. No model is called; the finish
-- records 10 tokens in and 1 out at gpt-5-nano's price (under 0.000001 USD).
begin;

do $t$
begin
  -- the claim below must read this fixture's message and no other
  if exists (select 1 from pgmq.q_extraction) or exists (select 1 from public.extraction_runs where status in ('queued', 'running')) then
    raise exception 'the extraction queue is not idle (a suite run in progress, or one killed less than about 11 minutes ago); run test:db again once the sweep has ended it';
  end if;
  if exists (select 1 from public.tenants where id = 'f2f2f2f2-0000-4000-8000-000000000001')
     or exists (select 1 from auth.users where id = 'f1f1f1f1-0000-4000-8000-000000000001') then
    raise exception 'the lock-order fixture is still there; supabase/tests/sessions/cleanup.sql removes it';
  end if;
  -- the sessions signal each other with these advisory locks; a holder left
  -- over would make them read a signal nobody sent
  if exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.classid = 20260925::oid and l.objsubid = 2) then
    raise exception 'an advisory lock (20260925, n) is held; the sessions use them as signals';
  end if;
end $t$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
values ('f1f1f1f1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated',
  'authenticated', 'lock-order-test@example.invalid', 'x', now(), now(), now(), '{}', '{}', false, false);
insert into public.tenants (id, name, slug)
values ('f2f2f2f2-0000-4000-8000-000000000001', 'Lock order test', 'lock-order-test');
insert into public.memberships (tenant_id, user_id, role)
values ('f2f2f2f2-0000-4000-8000-000000000001', 'f1f1f1f1-0000-4000-8000-000000000001', 'owner');
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
values ('f3f3f3f3-0000-4000-8000-000000000001', 'f2f2f2f2-0000-4000-8000-000000000001', 'lock-order.pdf',
  'f1f1f1f1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141);

-- enqueue as the owner, then claim as the worker
select set_config('request.jwt.claims',
  '{"sub":"f1f1f1f1-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $t$
declare
  v_run_id uuid;
  v_claim  record;
begin
  v_run_id := public.enqueue_extraction_run('f3f3f3f3-0000-4000-8000-000000000001', 1);
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_run_id or v_claim.claim_token is null then
    raise exception 'the setup could not claim its own run';
  end if;
end $t$;

commit;

select r.id as run_id, r.status, q.msg_id, q.read_ct, q.vt > now() as hidden
from public.extraction_runs r
join pgmq.q_extraction q on q.msg_id = r.queue_msg_id
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001';
