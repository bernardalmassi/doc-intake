-- Tests the queue's wakes (20260925000004) against the TEST project (never
-- the app's), inside a transaction that is always rolled back. Run with
--   npm run test:db
-- It creates a throwaway user, an organization and documents as postgres,
-- acts as their owner through auth.uid(), and as pg_cron by calling
-- sweep_extraction_queue as postgres. Every check raises on failure, so a
-- non-zero exit is a failed test; the final select lists what was checked.
--
-- Nothing is sent: pg_net sends a request only after its transaction
-- commits, and this one never does.
begin;

create temp table checks (n serial, step text, result text);

do $t$
begin
  -- the sweeps below must see this test's rows only
  if exists (select 1 from pgmq.q_extraction) or exists (select 1 from public.extraction_runs where status in ('queued', 'running')) then
    raise exception 'the extraction queue is not idle (a suite run in progress, or one killed less than about 11 minutes ago); run test:db again once the sweep has ended it';
  end if;
end $t$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
values ('d1d1d1d1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated',
  'authenticated', 'wake-test-owner@example.invalid', 'x', now(), now(), now(), '{}', '{}', false, false);
insert into public.tenants (id, name, slug) values ('d2d2d2d2-0000-4000-8000-000000000001', 'Wake test', 'wake-test');
insert into public.memberships (tenant_id, user_id, role)
values ('d2d2d2d2-0000-4000-8000-000000000001', 'd1d1d1d1-0000-4000-8000-000000000001', 'owner');
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
select ('d3d3d3d3-0000-4000-8000-00000000000' || n)::uuid, 'd2d2d2d2-0000-4000-8000-000000000001',
       'wake-' || n || '.pdf', 'd1d1d1d1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141
from generate_series(1, 4) n;

select set_config('request.jwt.claims',
  '{"sub":"d1d1d1d1-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- 1. A wake that fails doesn't undo the tick's reaps -------------------------

do $t$
declare
  v_minutes integer := (select stale_run_minutes from public.extraction_limits);
  v_stale   uuid;
  v_lost    uuid;
  v_run     public.extraction_runs;
begin
  -- a run queued past the deadline, which step (d) expires, and a message
  -- never read for over 60 s, which step (b) wakes a worker for
  v_stale := public.enqueue_extraction_run('d3d3d3d3-0000-4000-8000-000000000001', 1);
  update public.extraction_runs set started_at = now() - make_interval(mins => v_minutes) - interval '1 second'
  where id = v_stale;
  v_lost := public.enqueue_extraction_run('d3d3d3d3-0000-4000-8000-000000000002', 1);
  update pgmq.q_extraction q set enqueued_at = now() - interval '61 seconds', vt = now() - interval '61 seconds'
  from public.extraction_runs r where r.id = v_lost and q.msg_id = r.queue_msg_id;

  -- every wake fails, as one would if pg_net or Vault raised; the real
  -- function is put back below (and the rollback would restore it anyway)
  create temp table saved_wake as
  select pg_get_functiondef('private.wake_extraction_worker()'::regprocedure) as definition;
  execute $f$
    create or replace function private.wake_extraction_worker()
    returns bigint language plpgsql security definer set search_path = '' as $b$
    begin
      raise exception 'a wake that fails' using errcode = 'XX000';
    end;
    $b$
  $f$;

  begin
    perform private.sweep_extraction_queue();
  exception when others then
    raise exception 'a failing wake failed the whole sweep (SQLSTATE %: %)', sqlstate, sqlerrm;
  end;
  execute (select definition from saved_wake);

  select r.* into v_run from public.extraction_runs r where r.id = v_stale;
  if v_run.status <> 'failed' or v_run.error not like 'expired: %'
     or (select kind from private.extraction_spend where run_id = v_stale) is distinct from 'expired' then
    raise exception 'the tick''s reap was not kept: %, %', v_run.status, v_run.error;
  end if;
  if (select status from public.extraction_runs where id = v_lost) <> 'queued' then
    raise exception 'the run whose wake failed must stay queued, for the next tick';
  end if;
  insert into checks (step, result) values
    ('a wake that fails is its own subtransaction: the sweep returns and keeps the tick''s reap', v_run.error);
end $t$;

-- 2. The URL, checked strictly (20260925000004) --------------------------------

do $t$
declare
  v_case    record;
  v_problem text;
begin
  for v_case in select * from (values
    ('https://worker.invalid/api/extraction-worker', null),
    ('https://doc-intake-ten.vercel.app/api/extraction-worker', null),
    ('https://xn--bcher-kva.example/api/extraction-worker', null),
    (null, 'is missing'),
    ('http://worker.invalid/api/extraction-worker', 'is not https'),
    ('HTTPS://worker.invalid/api/extraction-worker', 'is not https'),
    ('https://user:secret@worker.invalid/api/extraction-worker', 'has a user name or password'),
    ('https://user@worker.invalid/api/extraction-worker', 'has a user name or password'),
    ('https://worker.invalid:8443/api/extraction-worker', 'has a port'),
    ('https://worker.invalid:/api/extraction-worker', 'has a port'),
    ('https://[::1]/api/extraction-worker', 'has no plain host name'),
    ('https://10.0.0.1/api/extraction-worker', 'has no plain host name'),
    ('https://localhost/api/extraction-worker', 'has no plain host name'),
    ('https://worker.invalid./api/extraction-worker', 'has no plain host name'),
    ('https://Worker.invalid/api/extraction-worker', 'has no plain host name'),
    ('https://-worker.invalid/api/extraction-worker', 'has no plain host name'),
    ('https://worker_1.invalid/api/extraction-worker', 'has no plain host name'),
    ('https:///api/extraction-worker', 'has no plain host name'),
    ('https://worker.invalid?/api/extraction-worker', 'has a query'),
    ('https://worker.invalid/api/extraction-worker?next=1', 'has a query'),
    ('https://worker.invalid/api/extraction-worker#top', 'has a fragment'),
    ('https://worker.invalid/api/extraction-worker ', 'contains whitespace or a control character'),
    (' https://worker.invalid/api/extraction-worker', 'contains whitespace or a control character'),
    ('https://work er.invalid/api/extraction-worker', 'contains whitespace or a control character'),
    (E'https://worker.invalid/api/extraction-worker\n', 'contains whitespace or a control character'),
    (E'https://worker.invalid\t/api/extraction-worker', 'contains whitespace or a control character'),
    ('https://worker.invalid/api/extraction-worker/', 'has a path other than /api/extraction-worker'),
    ('https://worker.invalid/api/extraction-worker/../x', 'has a path other than /api/extraction-worker'),
    ('https://worker.invalid/API/extraction-worker', 'has a path other than /api/extraction-worker'),
    ('https://worker.invalid//api/extraction-worker', 'has a path other than /api/extraction-worker'),
    ('https://worker.invalid', 'has a path other than /api/extraction-worker'),
    ('https://worker.invalid/api/extraction-worker%2F', 'has a path other than /api/extraction-worker')
  ) c(url, problem) loop
    v_problem := private.extraction_worker_url_problem(v_case.url);
    if v_problem is distinct from v_case.problem then
      raise exception 'extraction_worker_url_problem(%): expected %, got %', coalesce(quote_literal(v_case.url), 'null'), v_case.problem, v_problem;
    end if;
  end loop;
  insert into checks (step, result) values ('the worker URL must be exactly https://<plain host>/api/extraction-worker', '32 URLs');
end $t$;

-- The real wake with a Vault pair created inside this transaction: nothing is
-- queued for a malformed URL, one request for a good one.
select vault.create_secret('wake-test-bearer-not-a-real-secret-0123456789', 'extraction_worker_secret');
select vault.create_secret('https://user:secret@worker.invalid/api/extraction-worker', 'extraction_worker_url');

do $t$
declare
  v_bad     text;
  v_sent    bigint;
  v_before  integer;
begin
  foreach v_bad in array array[
    'https://user:secret@worker.invalid/api/extraction-worker',
    'https://worker.invalid:8443/api/extraction-worker',
    'https://worker.invalid/api/extraction-worker?next=1',
    'http://worker.invalid/api/extraction-worker',
    E'https://worker.invalid/api/extraction-worker\n'
  ] loop
    perform vault.update_secret((select id from vault.secrets where name = 'extraction_worker_url'), v_bad);
    v_before := (select count(*) from net.http_request_queue);
    v_sent := private.wake_extraction_worker();
    if v_sent is not null or (select count(*) from net.http_request_queue) <> v_before then
      raise exception 'a wake with the URL % queued a request', quote_literal(v_bad);
    end if;
  end loop;

  perform vault.update_secret((select id from vault.secrets where name = 'extraction_worker_url'), 'https://worker.invalid/api/extraction-worker');
  v_before := (select count(*) from net.http_request_queue);
  v_sent := private.wake_extraction_worker();
  if v_sent is null or (select count(*) from net.http_request_queue) <> v_before + 1
     or not exists (select 1 from net.http_request_queue q where q.id = v_sent and q.url = 'https://worker.invalid/api/extraction-worker') then
    raise exception 'a wake with a good URL must queue exactly one request to it';
  end if;
  insert into checks (step, result) values
    ('a wake queues nothing for a malformed Vault URL (it warns instead) and one request for a good one', '5 malformed, 1 good');
end $t$;

select step, result from checks order by n;

rollback;
