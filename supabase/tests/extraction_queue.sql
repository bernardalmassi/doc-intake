-- Tests the extraction queue (20260925000002) against the TEST project
-- (never the app's), inside a transaction that is always rolled back. Run
-- with
--   npm run test:db
-- It creates a throwaway user, tenants and documents as postgres, acts as
-- their owner through auth.uid(), and as the worker and pg_cron by calling
-- claim_extraction_run, finish_extraction_run and sweep_extraction_queue as
-- postgres. Every check raises on failure, so a non-zero exit is a failed
-- test; the final select lists what was checked.
--
-- Nothing is sent: pg_net sends a request only after its transaction
-- commits, and this one never does. The one Vault pair it creates lives
-- only inside the transaction and points at worker.invalid, a name that
-- can't resolve (RFC 2606).
begin;

create temp table checks (n serial, step text, result text);

-- 0. The test project's standing state -----------------------------------

do $t$
begin
  -- D2: no persistent Vault pair, so nothing on the test project can wake a
  -- worker. The only worker is production's.
  if exists (select 1 from vault.secrets where name in ('extraction_worker_url', 'extraction_worker_secret')) then
    raise exception 'the test project''s Vault holds an extraction worker secret; it must hold none (docs/worker-design.md, D2)';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'pgmq_public') then
    raise exception 'pgmq_public exists: Integrations -> Queues -> "Expose Queues via PostgREST" is on';
  end if;
  -- the claims and sweeps below must see this test's rows only
  if exists (select 1 from pgmq.q_extraction) or exists (select 1 from public.extraction_runs where status in ('queued', 'running')) then
    raise exception 'the extraction queue is not idle (a suite run in progress, or one killed less than 16 min 10 s ago); run test:db again once the sweep has ended it';
  end if;
end $t$;
insert into checks (step, result) values ('no Vault pair and no pgmq_public on the test project; the queue is idle', 'ok');

-- One owner, one tenant per case (e2..01 to e2..10), one document each
-- (e3..01 to e3..10) and a second one for the in-flight case (e3..8b).
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
values ('e1e1e1e1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated',
  'authenticated', 'queue-test-owner@example.invalid', 'x', now(), now(), now(), '{}', '{}', false, false);

insert into public.tenants (id, name, slug)
select ('e2e2e2e2-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'Queue test ' || n, 'queue-test-' || lpad(n::text, 2, '0')
from generate_series(1, 10) n;
insert into public.memberships (tenant_id, user_id, role)
select t.id, 'e1e1e1e1-0000-4000-8000-000000000001', 'owner' from public.tenants t where t.slug like 'queue-test-%';
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
select ('e3e3e3e3-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e2e2e2e2-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       'queue-' || n || '.pdf', 'e1e1e1e1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141
from generate_series(1, 10) n;
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
values ('e3e3e3e3-0000-4000-8000-00000000008b', 'e2e2e2e2-0000-4000-8000-000000000008', 'queue-8b.pdf',
  'e1e1e1e1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141);

-- act as the owner
select set_config('request.jwt.claims',
  '{"sub":"e1e1e1e1-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- 1. An idle tick -----------------------------------------------------------

do $t$
declare
  v_before jsonb;
  v_after  jsonb;
  v_state  text := $q$
    select jsonb_build_object(
      'runs',     (select coalesce(jsonb_object_agg(s, c), '{}') from (select status::text s, count(*) c from public.extraction_runs group by 1) x),
      'spend',    (select count(*) from private.extraction_spend),
      'queue',    (select count(*) from pgmq.q_extraction),
      'archive',  (select count(*) from pgmq.a_extraction),
      'requests', (select count(*) from net.http_request_queue),
      'docs',     (select coalesce(jsonb_object_agg(s, c), '{}') from (select status::text s, count(*) c from public.documents group by 1) x))
  $q$;
begin
  execute v_state into v_before;
  perform private.sweep_extraction_queue();
  execute v_state into v_after;
  if v_after <> v_before then
    raise exception 'an idle sweep changed something: % -> %', v_before, v_after;
  end if;
  insert into checks (step, result) values ('an idle sweep changes nothing and sends no request', v_after::text);
end $t$;

-- 2. The wake, through the real grants (fix 2) ------------------------------

-- The pair exists only inside this transaction.
select vault.create_secret('https://worker.invalid/api/extraction-worker', 'extraction_worker_url');
select vault.create_secret('queue-test-bearer-not-a-real-secret-0123456789', 'extraction_worker_secret');

-- as the signed-in admin, the way PostgREST calls it: the definer function's
-- Vault read is what production will do
set local role authenticated;
select public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000001', 1) as dispatched_run;
reset role;

do $t$
declare
  v_count   integer;
  v_request record;
  v_run     public.extraction_runs;
begin
  if has_table_privilege('authenticated', 'vault.decrypted_secrets', 'select') then
    raise exception 'authenticated can read Vault directly; the wake must be the only way';
  end if;
  select count(*) into v_count from net.http_request_queue q
  where q.url = 'https://worker.invalid/api/extraction-worker';
  if v_count <> 1 then
    raise exception 'expected exactly one request for the enqueue, got %', v_count;
  end if;
  select q.* into v_request from net.http_request_queue q
  where q.url = 'https://worker.invalid/api/extraction-worker';
  if v_request.method <> 'POST'
     or v_request.timeout_milliseconds <> 5000
     or v_request.headers ->> 'Authorization' is distinct from 'Bearer queue-test-bearer-not-a-real-secret-0123456789'
     or convert_from(v_request.body, 'utf8')::jsonb <> '{}'::jsonb then
    raise exception 'the wake request is not POST {} with the bearer and a 5000 ms timeout: % % % %',
      v_request.method, v_request.timeout_milliseconds, v_request.headers - 'Authorization', convert_from(v_request.body, 'utf8');
  end if;
  select r.* into v_run from public.extraction_runs r where r.document_id = 'e3e3e3e3-0000-4000-8000-000000000001';
  if v_run.status <> 'queued' or v_run.queue_msg_id is null
     or exists (select 1 from private.extraction_run_tokens t where t.run_id = v_run.id)
     or (select status from public.documents where id = v_run.document_id) <> 'processing' then
    raise exception 'an enqueued run must be queued with a message and no token, its document processing';
  end if;
  insert into checks (step, result) values ('an enqueue as authenticated reads Vault through the definer and queues one POST {} with the bearer, 5000 ms',
    v_request.method || ' ' || v_request.url);
  insert into checks (step, result) values ('the run is queued with a message and no token; the document is processing', 'ok');
  perform private.reap_extraction_run(v_run.id, 'test');
end $t$;

-- 3. A refused enqueue sends nothing ----------------------------------------

do $t$
declare
  v_requests integer := (select count(*) from net.http_request_queue);
  v_messages bigint := (select count(*) from pgmq.q_extraction);
  v_limits   public.extraction_limits := (select l from public.extraction_limits l);
begin
  -- the ledger alone at the tenant ceiling
  insert into private.extraction_spend (kind, tenant_id, run_id, cost_usd)
  values ('charge', 'e2e2e2e2-0000-4000-8000-000000000002', gen_random_uuid(), v_limits.tenant_monthly_ceiling_usd);
  begin
    perform public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000002', 1);
    raise exception 'an enqueue at the tenant ceiling was accepted';
  exception when sqlstate '53400' then
    if sqlerrm not like 'this organization has reached its monthly extraction spend ceiling (% USD), counting extractions in progress' then
      raise exception 'unexpected 53400 message: %', sqlerrm;
    end if;
    insert into checks (step, result) values ('ledger rows at the tenant ceiling refuse the enqueue', sqlerrm);
  end;
  if (select count(*) from net.http_request_queue) <> v_requests
     or (select count(*) from pgmq.q_extraction) <> v_messages
     or exists (select 1 from public.extraction_runs r where r.document_id = 'e3e3e3e3-0000-4000-8000-000000000002') then
    raise exception 'a refused enqueue left a request, a message or a run behind';
  end if;
  insert into checks (step, result) values ('a refused enqueue writes no run, message or request', 'ok');
end $t$;

-- 4. A second delivery is never processed -----------------------------------

do $t$
declare
  v_run_id  uuid;
  v_claim   record;
  v_again   record;
  v_run     public.extraction_runs;
  v_spend   record;
  v_msg_id  bigint;
  v_est     record;
begin
  v_run_id := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000003', 1);
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_run_id or v_claim.claim_token is null
     or v_claim.page_count <> 1 or v_claim.storage_path is distinct from
        'e2e2e2e2-0000-4000-8000-000000000003/e3e3e3e3-0000-4000-8000-000000000003' then
    raise exception 'the claim did not return the run as expected: %', row_to_json(v_claim);
  end if;
  select r.* into v_run from public.extraction_runs r where r.id = v_run_id;
  if v_run.status <> 'running' or v_run.claimed_at is null then
    raise exception 'a claimed run must be running with claimed_at set';
  end if;
  v_msg_id := v_run.queue_msg_id;
  if (select read_ct from pgmq.q_extraction where msg_id = v_msg_id) <> 1 then
    raise exception 'a claimed message must have read_ct 1';
  end if;
  insert into checks (step, result) values ('a claim moves the run to running with a token; its message has read_ct 1', 'ok');

  -- make the message visible again, as if the visibility timeout had passed
  perform pgmq.set_vt('extraction', v_msg_id, 0);
  select * into v_again from public.claim_extraction_run();
  if v_again.run_id is not null then
    raise exception 'a second delivery was claimed: %', row_to_json(v_again);
  end if;
  select r.* into v_run from public.extraction_runs r where r.id = v_run_id;
  select e.* into v_est from private.abandoned_estimate(1) e;
  select s.* into v_spend from private.extraction_spend s where s.run_id = v_run_id;
  if v_run.status <> 'failed' or v_run.cost_usd <> v_est.cost_usd or v_run.error not like 'cost estimated at % abandoned: delivered a second time%'
     or v_spend.kind is distinct from 'abandoned' or v_spend.cost_usd <> v_est.cost_usd then
    raise exception 'a second delivery must abandon the run at the estimate: % / % / % / %',
      v_run.status, v_run.cost_usd, v_run.error, v_spend.kind;
  end if;
  if exists (select 1 from pgmq.q_extraction where msg_id = v_msg_id)
     or not exists (select 1 from pgmq.a_extraction where msg_id = v_msg_id)
     or exists (select 1 from private.extraction_run_tokens t where t.run_id = v_run_id) then
    raise exception 'after a second delivery the message must be archived and the token gone';
  end if;
  begin
    perform public.finish_extraction_run(v_run_id, v_claim.claim_token, 'failed',
      null, null, 0, 0, 1, 0, false, 'late', null, null);
    raise exception 'a finish after the second delivery was accepted';
  exception when sqlstate '42501' then
    null;
  end;
  insert into checks (step, result) values ('read_ct > 1: archived, abandoned at the estimate, no row and no token; the first finish is refused',
    v_run.cost_usd::text || ' USD');
end $t$;

-- 4b. The claim expires a queued run past the stale limit (20260925000004) --

insert into public.tenants (id, name, slug)
values ('e2e2e2e2-0000-4000-8000-000000000012', 'Queue test 12', 'queue-test-12');
insert into public.memberships (tenant_id, user_id, role)
values ('e2e2e2e2-0000-4000-8000-000000000012', 'e1e1e1e1-0000-4000-8000-000000000001', 'owner');
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
values ('e3e3e3e3-0000-4000-8000-000000000013', 'e2e2e2e2-0000-4000-8000-000000000012', 'queue-13.pdf',
  'e1e1e1e1-0000-4000-8000-000000000001', 'extracted', 'application/pdf', 3141);

do $t$
declare
  v_minutes integer := (select stale_run_minutes from public.extraction_limits);
  v_run_id  uuid;
  v_claim   record;
  v_run     public.extraction_runs;
  v_spend   record;
begin
  v_run_id := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000013', 1);
  -- queued a second past the deadline, and not yet swept
  update public.extraction_runs set started_at = now() - make_interval(mins => v_minutes) - interval '1 second'
  where id = v_run_id;
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is not null then
    raise exception 'the claim started a run queued past the stale limit: %', row_to_json(v_claim);
  end if;
  select r.* into v_run from public.extraction_runs r where r.id = v_run_id;
  select s.* into v_spend from private.extraction_spend s where s.run_id = v_run_id;
  if v_run.status <> 'failed' or v_run.cost_usd <> 0 or v_run.error not like 'expired: not claimed within % minutes; expired by the claim%'
     or v_run.claimed_at is not null
     or v_spend.kind is distinct from 'expired' or v_spend.cost_usd <> 0
     or exists (select 1 from private.extraction_run_tokens t where t.run_id = v_run_id)
     or exists (select 1 from pgmq.q_extraction where msg_id = v_run.queue_msg_id)
     or not exists (select 1 from pgmq.a_extraction where msg_id = v_run.queue_msg_id)
     or (select status from public.documents where id = v_run.document_id) <> 'extracted' then
    raise exception 'a claim must expire a stale queued run at 0: % / % / % / %', v_run.status, v_run.cost_usd, v_run.error, v_spend.kind;
  end if;
  insert into checks (step, result) values
    ('the claim expires a queued run past the stale limit at 0 instead of starting it, message archived, document released', v_run.error);
end $t$;

-- 5. The sweep, one case per state (fix 1) ----------------------------------

do $t$
declare
  v_minutes integer := (select stale_run_minutes from public.extraction_limits);
  v_queued  uuid;
  v_claimed uuid;
  v_claim   record;
  v_old     uuid;
  v_run     public.extraction_runs;
  v_spend   record;
  v_est     record;
  v_msg_id  bigint;
begin
  select e.* into v_est from private.abandoned_estimate(1) e;

  -- queued past the deadline: expired at 0, its message archived
  v_queued := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000004', 1);
  update public.extraction_runs set started_at = now() - make_interval(mins => v_minutes) - interval '1 second'
  where id = v_queued;
  perform private.sweep_extraction_queue();
  select r.* into v_run from public.extraction_runs r where r.id = v_queued;
  select s.* into v_spend from private.extraction_spend s where s.run_id = v_queued;
  if v_run.status <> 'failed' or v_run.cost_usd <> 0 or v_run.error not like 'expired: %'
     or v_spend.kind is distinct from 'expired' or v_spend.cost_usd <> 0
     or exists (select 1 from pgmq.q_extraction where msg_id = v_run.queue_msg_id)
     or not exists (select 1 from pgmq.a_extraction where msg_id = v_run.queue_msg_id)
     or (select status from public.documents where id = v_run.document_id) <> 'pending' then
    raise exception 'a queued run past the deadline must expire at 0 with its message archived: % / % / % / %',
      v_run.status, v_run.cost_usd, v_run.error, v_spend.kind;
  end if;
  insert into checks (step, result) values ('sweep (d): a queued run past the deadline expires at 0, ledger row expired, message archived, document released', v_run.error);

  -- claimed, and its message past the visibility timeout: abandoned at the
  -- estimate
  v_claimed := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000005', 1);
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_claimed then
    raise exception 'expected to claim %, got %', v_claimed, v_claim.run_id;
  end if;
  select queue_msg_id into v_msg_id from public.extraction_runs where id = v_claimed;
  update pgmq.q_extraction set vt = now() - interval '1 second' where msg_id = v_msg_id;
  perform private.sweep_extraction_queue();
  select r.* into v_run from public.extraction_runs r where r.id = v_claimed;
  select s.* into v_spend from private.extraction_spend s where s.run_id = v_claimed;
  if v_run.status <> 'failed' or v_run.cost_usd <> v_est.cost_usd or v_run.error not like 'cost estimated at % abandoned: claimed but not finished%'
     or v_spend.kind is distinct from 'abandoned' or v_spend.cost_usd <> v_est.cost_usd
     or exists (select 1 from pgmq.q_extraction where msg_id = v_msg_id)
     or exists (select 1 from private.extraction_run_tokens t where t.run_id = v_claimed)
     or (select status from public.documents where id = v_run.document_id) <> 'pending' then
    raise exception 'a claimed run past its visibility timeout must be abandoned at the estimate: % / % / % / %',
      v_run.status, v_run.cost_usd, v_run.error, v_spend.kind;
  end if;
  insert into checks (step, result) values ('sweep (a): a claimed run past its visibility timeout is abandoned at the estimate, ledger row abandoned, message archived',
    v_run.cost_usd::text || ' USD');

  -- running with no message, as the old path leaves a run: inserted as
  -- postgres so this still works once open_extraction_run is dropped
  update public.documents set status = 'processing' where id = 'e3e3e3e3-0000-4000-8000-000000000006';
  insert into public.extraction_runs (tenant_id, document_id, started_by, status, previous_document_status, page_count, started_at)
  values ('e2e2e2e2-0000-4000-8000-000000000006', 'e3e3e3e3-0000-4000-8000-000000000006',
          'e1e1e1e1-0000-4000-8000-000000000001', 'running', 'pending', 1,
          now() - make_interval(mins => v_minutes) - interval '1 second')
  returning id into v_old;
  insert into private.extraction_run_tokens (run_id, token) values (v_old, gen_random_uuid());
  perform private.sweep_extraction_queue();
  select r.* into v_run from public.extraction_runs r where r.id = v_old;
  select s.* into v_spend from private.extraction_spend s where s.run_id = v_old;
  if v_run.status <> 'failed' or v_run.cost_usd <> v_est.cost_usd or v_run.error not like 'cost estimated at % abandoned: still running after%'
     or v_spend.kind is distinct from 'abandoned' or v_spend.cost_usd <> v_est.cost_usd
     or exists (select 1 from private.extraction_run_tokens t where t.run_id = v_old)
     or (select status from public.documents where id = v_run.document_id) <> 'pending' then
    raise exception 'an old-path run past the deadline must be abandoned at the estimate: % / % / % / %',
      v_run.status, v_run.cost_usd, v_run.error, v_spend.kind;
  end if;
  insert into checks (step, result) values ('sweep (c): an old-path running run past the deadline is abandoned at the estimate, document released',
    v_run.cost_usd::text || ' USD');
end $t$;

do $t$
declare
  v_run_id   uuid;
  v_msg_id   bigint;
  v_requests integer;
begin
  -- a message never read, over 60 s old: one wake, while the in-transaction
  -- Vault pair exists
  v_run_id := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000007', 1);
  select queue_msg_id into v_msg_id from public.extraction_runs where id = v_run_id;
  update pgmq.q_extraction set enqueued_at = now() - interval '61 seconds', vt = now() - interval '61 seconds'
  where msg_id = v_msg_id;
  v_requests := (select count(*) from net.http_request_queue q where q.url = 'https://worker.invalid/api/extraction-worker');
  perform private.sweep_extraction_queue();
  if (select count(*) from net.http_request_queue q where q.url = 'https://worker.invalid/api/extraction-worker') <> v_requests + 1 then
    raise exception 'a lost wake must be sent again exactly once';
  end if;
  if (select status from public.extraction_runs where id = v_run_id) <> 'queued' then
    raise exception 'a wake must leave the run queued';
  end if;
  insert into checks (step, result) values ('sweep (b): a message never read after 60 s gets exactly one wake', 'ok');
  perform private.reap_extraction_run(v_run_id, 'test');
end $t$;

-- 6. Runs in flight count at their estimate (fix 3) --------------------------

do $t$
declare
  v_big    uuid;
  v_claim  record;
  v_small  uuid;
  v_est    record;
  v_run    public.extraction_runs;
begin
  select e.* into v_est from private.abandoned_estimate(100) e;
  -- a fresh organization can run a 100-page document: its own estimate
  -- isn't added
  v_big := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000008', 100);
  insert into checks (step, result) values ('a first 100-page enqueue on a fresh organization succeeds', v_est.cost_usd::text || ' USD estimate');
  -- while it is in flight its estimate holds the tenant at the ceiling
  begin
    perform public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-00000000008b', 1);
    raise exception 'an enqueue beside a 100-page run in flight was accepted';
  exception when sqlstate '53400' then
    if sqlerrm not like 'this organization has reached its monthly extraction spend ceiling%' then
      raise exception 'unexpected 53400 message: %', sqlerrm;
    end if;
    insert into checks (step, result) values ('beside it, a second enqueue in the same organization is refused', sqlerrm);
  end;
  -- once the first is terminal at its real cost, the second goes through
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_big then
    raise exception 'expected to claim %, got %', v_big, v_claim.run_id;
  end if;
  perform public.finish_extraction_run(v_big, v_claim.claim_token, 'succeeded', 'openai', 'gpt-5-nano',
    1000, 100, 1200, 1, false, null, null, '[]'::jsonb);
  select r.* into v_run from public.extraction_runs r where r.id = v_big;
  if v_run.status <> 'succeeded' or v_run.cost_usd <> 0.00009
     or (select cost_usd from private.extraction_spend where run_id = v_big) <> 0.00009
     or (select kind from private.extraction_spend where run_id = v_big) <> 'charge'
     or (select status from public.documents where id = v_run.document_id) <> 'extracted'
     or exists (select 1 from pgmq.q_extraction where msg_id = v_run.queue_msg_id) then
    raise exception 'the finish must record 0.00009 USD in the run and the ledger, archive the message and set extracted: % / %',
      v_run.status, v_run.cost_usd;
  end if;
  v_small := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-00000000008b', 1);
  insert into checks (step, result) values ('once the first finishes at its real cost, the second enqueue succeeds', 'ok');
  perform private.reap_extraction_run(v_small, 'test');
end $t$;

-- 6b. What a finish accepts ---------------------------------------------------

do $t$
declare
  v_run_id uuid;
  v_claim  record;
  v_limits public.extraction_limits := (select l from public.extraction_limits l);
  v_run    public.extraction_runs;
  v_case   text;
begin
  -- reuses organization 8's second document, ended above
  v_run_id := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-00000000008b', 1);
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_run_id then
    raise exception 'expected to claim %, got %', v_run_id, v_claim.run_id;
  end if;
  begin
    perform public.finish_extraction_run(v_run_id, v_claim.claim_token, 'failed', 'openai', 'gpt-5-nano',
      10, 1, 5, 1, false, 'x', null,
      '[{"name":"title","value":"x","confidence":0.9,"band":"high","source_text":null,"clarifying_question":null}]'::jsonb);
    raise exception 'a failed finish with fields was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.finish_extraction_run(v_run_id, v_claim.claim_token, 'failed', 'openai', 'gpt-9-ultra',
      10, 1, 5, 1, false, 'x', null, null);
    raise exception 'a finish with an unpriced model was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.finish_extraction_run(v_run_id, v_claim.claim_token, 'failed', 'anthropic', 'gpt-5-nano',
      10, 1, 5, 1, false, 'x', null, null);
    raise exception 'a finish naming the wrong provider was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.finish_extraction_run(v_run_id, gen_random_uuid(), 'failed', null, null,
      0, 0, 5, 0, false, 'x', null, null);
    raise exception 'a finish with a wrong claim token was accepted';
  exception when sqlstate '42501' then null;
  end;
  -- no token, or an empty one (20260925000005): the nil uuid is refused as
  -- none, and '' is not a uuid at all, so PostgREST refuses it before the
  -- call (22P02). Before, a null token passed "v_token <> p_claim_token".
  foreach v_case in array array['no token', 'the nil uuid'] loop
    begin
      perform public.finish_extraction_run(v_run_id,
        case v_case when 'no token' then null else '00000000-0000-0000-0000-000000000000'::uuid end,
        'failed', null, null, 0, 0, 5, 0, false, 'finished with ' || v_case, null, null);
      raise exception 'a finish with % was accepted', v_case;
    exception when sqlstate '42501' then null;
    end;
  end loop;
  begin
    perform public.finish_extraction_run(v_run_id, ''::uuid, 'failed', null, null, 0, 0, 5, 0, false, 'x', null, null);
    raise exception 'a finish with an empty token was accepted';
  exception when sqlstate '22P02' then null;
  end;
  if (select status from public.extraction_runs where id = v_run_id) <> 'running'
     or not exists (select 1 from private.extraction_run_tokens t where t.run_id = v_run_id and t.token = v_claim.claim_token)
     or exists (select 1 from private.extraction_spend s where s.run_id = v_run_id) then
    raise exception 'a refused finish changed the run, its token or the ledger';
  end if;
  insert into checks (step, result) values
    ('a finish is refused with fields on a failure, an unpriced model, the wrong provider, the wrong token, no token or an empty one', 'ok');

  -- absurd token counts are clamped, so one run's cost is bounded
  perform public.finish_extraction_run(v_run_id, v_claim.claim_token, 'failed', 'openai', 'gpt-5-nano',
    2000000000, 2000000000, 5, 1, false, 'forged', null, null);
  select r.* into v_run from public.extraction_runs r where r.id = v_run_id;
  if v_run.input_tokens <> v_limits.max_input_tokens_per_run or v_run.output_tokens <> v_limits.max_output_tokens_per_run
     or v_run.cost_usd <> (select c.cost_usd from private.extraction_charge('gpt-5-nano', 'openai', 2000000000, 2000000000) c)
     or (select cost_usd from private.extraction_spend where run_id = v_run_id) <> v_run.cost_usd then
    raise exception 'a finish must clamp its token counts: % / % / %', v_run.input_tokens, v_run.output_tokens, v_run.cost_usd;
  end if;
  insert into checks (step, result) values ('a finish clamps absurd token counts, in the run and the ledger', v_run.cost_usd::text || ' USD');
end $t$;

-- 6c. Every RPC that locks a document or a run checks its caller first ------

-- (20260925000004 for the enqueue, open and close; 20260925000005 for
-- complete_document_upload and the finish.) A member (not an admin) of
-- organization 11 and a user who is no member of it; a run of its document
-- 12 opened by the owner through the old path, its document c3 still
-- uploading, and a queue run of its document c4, claimed as the worker
-- claims it. A refused caller must leave no lock behind on a document or a
-- run: a row lock, even one taken in a subtransaction that was then rolled
-- back, sets the row's xmax to the locker, so an xmax unchanged across the
-- refused calls means none of them locked the row. xmax tells when a lock is
-- new or stronger: documents 11 and c3 are unlocked, and document 12 and
-- both runs are only key-share locked by this transaction (the foreign keys
-- of the run and the token inserts), so a FOR UPDATE on them shows, as a
-- multixact (against 20260925000004's finish, the run of c4's did). Document
-- c4, which the claim holds for update, and the organization row, which the
-- membership inserts key-share lock, can't show a lock no stronger.
--
-- Every function in public that an API role may execute and that reaches
-- documents, runs or accounts must be called here, or listed with the
-- reason it isn't, so a new one can't be added without this test.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
values
  ('e1e1e1e1-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated',
   'authenticated', 'queue-test-member@example.invalid', 'x', now(), now(), now(), '{}', '{}', false, false),
  ('e1e1e1e1-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated',
   'authenticated', 'queue-test-outsider@example.invalid', 'x', now(), now(), now(), '{}', '{}', false, false);
insert into public.tenants (id, name, slug)
values ('e2e2e2e2-0000-4000-8000-000000000011', 'Queue test 11', 'queue-test-11');
insert into public.memberships (tenant_id, user_id, role) values
  ('e2e2e2e2-0000-4000-8000-000000000011', 'e1e1e1e1-0000-4000-8000-000000000001', 'owner'),
  ('e2e2e2e2-0000-4000-8000-000000000011', 'e1e1e1e1-0000-4000-8000-000000000002', 'member');
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes) values
  ('e3e3e3e3-0000-4000-8000-000000000011', 'e2e2e2e2-0000-4000-8000-000000000011', 'queue-11.pdf',
   'e1e1e1e1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141),
  ('e3e3e3e3-0000-4000-8000-000000000012', 'e2e2e2e2-0000-4000-8000-000000000011', 'queue-12.pdf',
   'e1e1e1e1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141),
  ('e3e3e3e3-0000-4000-8000-0000000000c4', 'e2e2e2e2-0000-4000-8000-000000000011', 'queue-c4.pdf',
   'e1e1e1e1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141);
insert into public.documents (id, tenant_id, filename, uploaded_by)
values ('e3e3e3e3-0000-4000-8000-0000000000c3', 'e2e2e2e2-0000-4000-8000-000000000011', 'queue-c3.pdf',
        'e1e1e1e1-0000-4000-8000-000000000001');

do $t$
declare
  v_open    record;
  v_claim   record;
  v_run_c4  uuid;
  v_refused text;
  v_fn      record;
  v_calls   text[] := '{}';
  v_doc     uuid := 'e3e3e3e3-0000-4000-8000-000000000011';
  v_before  jsonb;
  v_after   jsonb;
  v_xmax    text := $q$
    select jsonb_build_object(
      'document 11', (select d.xmax::text from public.documents d where d.id = 'e3e3e3e3-0000-4000-8000-000000000011'),
      'document 12', (select d.xmax::text from public.documents d where d.id = 'e3e3e3e3-0000-4000-8000-000000000012'),
      'document c3', (select d.xmax::text from public.documents d where d.id = 'e3e3e3e3-0000-4000-8000-0000000000c3'),
      'run of 12', (select r.xmax::text from public.extraction_runs r where r.document_id = 'e3e3e3e3-0000-4000-8000-000000000012'),
      'run of c4', (select r.xmax::text from public.extraction_runs r where r.document_id = 'e3e3e3e3-0000-4000-8000-0000000000c4'))
  $q$;
begin
  -- the owner opens a run of document 12 (old path), and enqueues document
  -- c4, which the worker claims
  select * into v_open from public.open_extraction_run('e3e3e3e3-0000-4000-8000-000000000012', 1);
  v_run_c4 := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-0000000000c4', 1);
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_run_c4 then
    raise exception 'expected to claim %, got %', v_run_c4, v_claim.run_id;
  end if;
  execute v_xmax into v_before;
  if v_before ? 'x' or exists (select 1 from jsonb_each_text(v_before) e where e.value is null) then
    raise exception 'a fixture row is missing: %', v_before;
  end if;

  -- as the member (not an admin, not the uploader)
  perform set_config('request.jwt.claims',
    '{"sub":"e1e1e1e1-0000-4000-8000-000000000002","role":"authenticated"}', true);
  foreach v_refused in array array['enqueue', 'open', 'complete', 'delete tenant', 'close'] loop
    begin
      case v_refused
        when 'enqueue' then perform public.enqueue_extraction_run(v_doc, 1);
        when 'open' then perform * from public.open_extraction_run(v_doc, 1);
        when 'complete' then perform public.complete_document_upload('e3e3e3e3-0000-4000-8000-0000000000c3');
        when 'delete tenant' then perform public.delete_tenant('e2e2e2e2-0000-4000-8000-000000000011');
        -- the right token, the wrong user
        else perform public.close_extraction_run(v_open.run_id, v_open.close_token, 'failed', null, null, 0, 0, 1, 0, 'x');
      end case;
      raise exception '% by a member was accepted', v_refused;
    exception when sqlstate '42501' then
      v_calls := v_calls || ('member: ' || v_refused);
    end;
  end loop;

  -- as a user who is no member of the organization
  perform set_config('request.jwt.claims',
    '{"sub":"e1e1e1e1-0000-4000-8000-000000000003","role":"authenticated"}', true);
  foreach v_refused in array array['enqueue', 'complete'] loop
    begin
      if v_refused = 'enqueue' then
        perform public.enqueue_extraction_run(v_doc, 1);
      else
        perform public.complete_document_upload('e3e3e3e3-0000-4000-8000-0000000000c3');
      end if;
      raise exception '% by an outsider was accepted', v_refused;
    exception when sqlstate '42501' then
      v_calls := v_calls || ('outsider: ' || v_refused);
    end;
  end loop;

  -- as the owner: a wrong close token and none; deleting their own account
  -- while they own an organization
  perform set_config('request.jwt.claims',
    '{"sub":"e1e1e1e1-0000-4000-8000-000000000001","role":"authenticated"}', true);
  foreach v_refused in array array['a wrong token', 'no token'] loop
    begin
      perform public.close_extraction_run(v_open.run_id,
        case v_refused when 'no token' then null else gen_random_uuid() end, 'failed', null, null, 0, 0, 1, 0, 'x');
      raise exception 'a close with % was accepted', v_refused;
    exception when sqlstate '42501' then
      v_calls := v_calls || ('owner: close with ' || v_refused);
    end;
  end loop;
  begin
    perform public.delete_own_account();
    raise exception 'an owner deleted their account';
  exception when sqlstate '55000' then
    v_calls := v_calls || 'owner: delete own account'::text;
  end;

  -- as the worker, the claimed run finished with a wrong token and with none
  foreach v_refused in array array['a wrong token', 'no token'] loop
    begin
      perform public.finish_extraction_run(v_run_c4,
        case v_refused when 'no token' then null else gen_random_uuid() end,
        'failed', null, null, 0, 0, 5, 0, false, 'x', null, null);
      raise exception 'a finish with % was accepted', v_refused;
    exception when sqlstate '42501' then
      v_calls := v_calls || ('worker: finish with ' || v_refused);
    end;
  end loop;

  execute v_xmax into v_after;
  if v_after <> v_before then
    raise exception 'a refused caller locked rows: xmax % before, % after', v_before, v_after;
  end if;

  -- every function in public that an API role may run and that reaches
  -- documents, runs or accounts is one of these
  for v_fn in
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))
      and p.prosrc ~* '(documents|extraction_runs|lock_extraction_run|reap_extraction_run|auth\.users)'
  loop
    if v_fn.proname not in ('enqueue_extraction_run', 'open_extraction_run', 'close_extraction_run',
                            'complete_document_upload', 'delete_tenant', 'delete_own_account', 'finish_extraction_run',
                            -- no caller to refuse: service_role alone may run it (section 9), and it takes
                            -- every document and run with NOWAIT
                            'claim_extraction_run') then
      raise exception '% reaches documents, runs or accounts and is not covered by this test', v_fn.proname;
    end if;
  end loop;

  insert into checks (step, result) values
    ('every RPC that locks a document or a run refuses a wrong caller before it locks anything', array_to_string(v_calls, '; '));

  perform private.reap_extraction_run(v_open.run_id, 'test');
  perform public.finish_extraction_run(v_run_c4, v_claim.claim_token, 'failed', null, null, 0, 0, 5, 0, false, 'test', null, null);
end $t$;

-- 6e. Only the worker ends a queue run (20260925000004) ------------------------

-- close_extraction_run, the old path's, compared the close token with <>,
-- which a null token passed; and a claimed run's token lives in the same
-- table. So the admin who enqueued a run could close it while the worker
-- called the model. Now a close with no token, or of any run that has a
-- message or was claimed, is refused.
insert into public.tenants (id, name, slug)
values ('e2e2e2e2-0000-4000-8000-000000000015', 'Queue test 15', 'queue-test-15');
insert into public.memberships (tenant_id, user_id, role)
values ('e2e2e2e2-0000-4000-8000-000000000015', 'e1e1e1e1-0000-4000-8000-000000000001', 'owner');
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
values ('e3e3e3e3-0000-4000-8000-000000000015', 'e2e2e2e2-0000-4000-8000-000000000015', 'queue-15.pdf',
  'e1e1e1e1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141);

do $t$
declare
  v_run_id uuid;
  v_claim  record;
  v_token  uuid;
  v_case   text;
begin
  v_run_id := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000015', 1);
  -- queued: no close, not even with no token
  begin
    perform public.close_extraction_run(v_run_id, null, 'failed', null, null, 0, 0, 1, 0, 'closed by its admin');
    raise exception 'the admin closed their queued run with no token';
  exception when sqlstate '42501' then null;
  end;

  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_run_id then
    raise exception 'expected to claim %, got %', v_run_id, v_claim.run_id;
  end if;
  -- claimed, the worker calling the model: no token, and not even the
  -- claim token itself (which no user can read) closes it
  foreach v_case in array array['no token', 'the claim token'] loop
    v_token := case v_case when 'no token' then null else v_claim.claim_token end;
    begin
      perform public.close_extraction_run(v_run_id, v_token, 'succeeded', 'openai', 'gpt-5-nano', 0, 0, 1, 1, null, null,
        '[{"name":"title","value":"forged","confidence":0.99,"band":"high","source_text":null,"clarifying_question":null}]'::jsonb);
      raise exception 'the admin closed a claimed run with %', v_case;
    exception when sqlstate '42501' then null;
    end;
  end loop;
  if (select status from public.extraction_runs where id = v_run_id) <> 'running'
     or not exists (select 1 from private.extraction_run_tokens t where t.run_id = v_run_id and t.token = v_claim.claim_token)
     or exists (select 1 from private.extraction_spend s where s.run_id = v_run_id) then
    raise exception 'a refused close changed the run, its token or the ledger';
  end if;
  -- the worker's own finish still goes through, with its cost
  perform public.finish_extraction_run(v_run_id, v_claim.claim_token, 'failed', 'openai', 'gpt-5-nano',
    1000, 100, 1200, 1, false, 'the worker''s finish', null, null);
  if (select cost_usd from private.extraction_spend s where s.run_id = v_run_id) <> 0.00009 then
    raise exception 'the worker''s finish was not recorded at its cost';
  end if;
  insert into checks (step, result) values
    ('no close ends a queue run, queued or claimed, with no token or with the claim token; the worker''s finish records it', 'ok');
end $t$;

-- 6d. Month attribution -------------------------------------------------------

-- A run's charge counts in the month it is written, whenever the run
-- started; a run in flight counts at its estimate whatever month it started
-- in (SECURITY.md, "Month attribution").
insert into public.tenants (id, name, slug)
values ('e2e2e2e2-0000-4000-8000-000000000014', 'Queue test 14', 'queue-test-14');
insert into public.memberships (tenant_id, user_id, role)
values ('e2e2e2e2-0000-4000-8000-000000000014', 'e1e1e1e1-0000-4000-8000-000000000001', 'owner');
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes) values
  ('e3e3e3e3-0000-4000-8000-000000000141', 'e2e2e2e2-0000-4000-8000-000000000014', 'queue-14a.pdf',
   'e1e1e1e1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141),
  ('e3e3e3e3-0000-4000-8000-000000000142', 'e2e2e2e2-0000-4000-8000-000000000014', 'queue-14b.pdf',
   'e1e1e1e1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141);

do $t$
declare
  v_tenant      uuid := 'e2e2e2e2-0000-4000-8000-000000000014';
  v_limits      public.extraction_limits := (select l from public.extraction_limits l);
  v_month_start timestamptz := date_trunc('month', now(), 'UTC');
  v_run_id      uuid;
  v_claim       record;
  v_row         record;
  v_est         numeric := (select e.cost_usd from private.abandoned_estimate(1) e);
begin
  -- started last month, finished now: its charge is this month's
  v_run_id := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000141', 1);
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_run_id then
    raise exception 'expected to claim %, got %', v_run_id, v_claim.run_id;
  end if;
  update public.extraction_runs set started_at = v_month_start - interval '1 day' where id = v_run_id;
  perform public.finish_extraction_run(v_run_id, v_claim.claim_token, 'succeeded', 'openai', 'gpt-5-nano',
    1000, 100, 1200, 1, false, null, null, '[]'::jsonb);
  select s.* into v_row from private.extraction_spend s where s.run_id = v_run_id;
  if v_row.created_at < v_month_start or v_row.cost_usd <> 0.00009 then
    raise exception 'a run started last month and finished now must be charged this month: % at %', v_row.cost_usd, v_row.created_at;
  end if;
  insert into checks (step, result) values ('a run started last month and finished this month is charged in this month''s ledger', '0.00009 USD');

  -- in flight since last month: still held at its estimate. The ledger
  -- brought to the ceiling less one one-page estimate, so only that run
  -- reaches it.
  v_run_id := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000142', 1);
  update public.extraction_runs set started_at = v_month_start - interval '1 day' where id = v_run_id;
  insert into private.extraction_spend (kind, tenant_id, run_id, cost_usd)
  values ('charge', v_tenant, gen_random_uuid(),
          v_limits.tenant_monthly_ceiling_usd - v_est
          - (select coalesce(sum(s.cost_usd), 0) from private.extraction_spend s
             where s.tenant_id = v_tenant and s.created_at >= v_month_start));
  begin
    perform private.check_extraction_limits(v_tenant);
    raise exception 'a run in flight since last month was left out of this month''s check';
  exception when sqlstate '53400' then
    if sqlerrm not like 'this organization has reached its monthly extraction spend ceiling%' then
      raise exception 'unexpected 53400 message: %', sqlerrm;
    end if;
  end;
  insert into checks (step, result) values ('a run in flight since last month still holds its estimate this month', v_est::text || ' USD');
  perform private.reap_extraction_run(v_run_id, 'test');
end $t$;

-- 7. Ceilings from the ledger ------------------------------------------------

do $t$
declare
  v_limits      public.extraction_limits := (select l from public.extraction_limits l);
  v_month_start timestamptz := date_trunc('month', now(), 'UTC');
  v_run_id      uuid;
  v_total       numeric;
begin
  -- last month's spend doesn't count
  insert into private.extraction_spend (created_at, kind, tenant_id, run_id, cost_usd)
  values (v_month_start - interval '1 day', 'charge', 'e2e2e2e2-0000-4000-8000-000000000009', gen_random_uuid(),
          v_limits.global_monthly_ceiling_usd + 1);
  v_run_id := public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000009', 1);
  insert into checks (step, result) values ('last month''s ledger rows don''t count', 'ok');
  perform private.reap_extraction_run(v_run_id, 'test');

  -- the global ceiling, reached by a deleted organization's spend: its rows
  -- have no foreign key and keep counting
  select coalesce(sum(s.cost_usd), 0) into v_total from private.extraction_spend s where s.created_at >= v_month_start;
  v_total := v_total + (select coalesce(sum(e.cost_usd), 0) from public.extraction_runs r
                        cross join lateral private.abandoned_estimate(r.page_count) e
                        where r.status in ('queued', 'running'));
  if v_total >= v_limits.global_monthly_ceiling_usd then
    raise exception 'the test project is already at the global ceiling (% USD this month)', v_total;
  end if;
  insert into private.extraction_spend (kind, tenant_id, run_id, cost_usd)
  values ('charge', gen_random_uuid(), gen_random_uuid(), v_limits.global_monthly_ceiling_usd - v_total);
  begin
    perform public.enqueue_extraction_run('e3e3e3e3-0000-4000-8000-000000000010', 1);
    raise exception 'an enqueue at the global ceiling was accepted';
  exception when sqlstate '53400' then
    if sqlerrm not like 'the monthly extraction spend ceiling across all organizations has been reached (% USD), counting extractions in progress' then
      raise exception 'unexpected 53400 message: %', sqlerrm;
    end if;
    insert into checks (step, result) values ('a deleted organization''s ledger rows count toward the global ceiling', sqlerrm);
  end;
end $t$;

-- 8. The ledger's integrity ---------------------------------------------------

do $t$
declare
  v_row private.extraction_spend;
  v_bad integer;
begin
  select s.* into v_row from private.extraction_spend s
  where s.tenant_id = 'e2e2e2e2-0000-4000-8000-000000000008' and s.kind = 'charge' limit 1;
  begin
    update private.extraction_spend set cost_usd = 0 where id = v_row.id;
    raise exception 'a ledger update was accepted';
  exception when sqlstate '42501' then
    insert into checks (step, result) values ('the ledger refuses update, as postgres too', sqlerrm);
  end;
  begin
    delete from private.extraction_spend where id = v_row.id;
    raise exception 'a ledger delete was accepted';
  exception when sqlstate '42501' then
    insert into checks (step, result) values ('the ledger refuses delete, as postgres too', sqlerrm);
  end;
  begin
    truncate private.extraction_spend;
    raise exception 'a ledger truncate was accepted';
  exception when sqlstate '42501' then
    insert into checks (step, result) values ('the ledger refuses truncate, as postgres too', sqlerrm);
  end;
  begin
    insert into private.extraction_spend (kind, tenant_id, run_id, cost_usd)
    values ('charge', v_row.tenant_id, v_row.run_id, 0);
    raise exception 'a second ledger row for one run was accepted';
  exception when unique_violation then
    insert into checks (step, result) values ('a second ledger row for one run is refused', sqlerrm);
  end;

  -- every run this test ended has exactly one ledger row, at the run's cost
  select count(*) into v_bad
  from public.extraction_runs r
  left join private.extraction_spend s on s.run_id = r.id
  where r.tenant_id in (select id from public.tenants where slug like 'queue-test-%')
    and r.status in ('succeeded', 'failed')
    and (s.id is null or s.cost_usd is distinct from r.cost_usd);
  if v_bad <> 0 then
    raise exception '% ended runs have no ledger row, or one at a different cost', v_bad;
  end if;
  insert into checks (step, result) values ('every ended run''s cost_usd equals its ledger row''s',
    (select count(*)::text from public.extraction_runs r
     where r.tenant_id in (select id from public.tenants where slug like 'queue-test-%') and r.status in ('succeeded', 'failed'))
    || ' runs');
end $t$;

-- 9. Who can execute what (docs/worker-design.md, section 5) ----------------

do $t$
declare
  v_fn   record;
  v_tb   record;
  v_role text;
  v_want boolean;
  v_got  boolean;
  v_priv text;
begin
  -- function, then whether anon, authenticated and service_role may execute it
  for v_fn in select * from (values
    ('public.enqueue_extraction_run(uuid,integer)', false, true, false),
    ('public.claim_extraction_run()', false, false, true),
    ('public.finish_extraction_run(uuid,uuid,text,text,text,integer,integer,integer,integer,boolean,text,text,jsonb)', false, false, true),
    ('public.open_extraction_run(uuid,integer)', false, true, false),
    ('public.close_extraction_run(uuid,uuid,text,text,text,integer,integer,integer,integer,text,text,jsonb)', false, true, false),
    ('public.delete_tenant(uuid)', false, true, false),
    ('private.extraction_charge(text,text,integer,integer)', false, false, false),
    ('private.abandoned_estimate(integer)', false, false, false),
    ('private.check_extraction_limits(uuid)', false, false, false),
    ('private.reap_extraction_run(uuid,text)', false, false, false),
    ('private.lock_extraction_run(uuid,boolean)', false, false, false),
    ('private.wake_extraction_worker()', false, false, false),
    ('private.extraction_worker_url_problem(text)', false, false, false),
    ('private.sweep_extraction_queue()', false, false, false),
    ('private.refuse_spend_change()', false, false, false),
    ('pgmq.send(text,jsonb)', false, false, false),
    ('pgmq.read(text,integer,integer,jsonb)', false, false, false),
    ('pgmq.archive(text,bigint)', false, false, false),
    ('pgmq.set_vt(text,bigint,integer)', false, false, false)
  ) f(sig, anon, authenticated, service_role) loop
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      v_want := case v_role when 'anon' then v_fn.anon when 'authenticated' then v_fn.authenticated else v_fn.service_role end;
      v_got := has_function_privilege(v_role, v_fn.sig, 'execute');
      if v_got <> v_want then
        raise exception '% execute on %: expected %, got %', v_role, v_fn.sig, v_want, v_got;
      end if;
    end loop;
  end loop;

  -- tables no API role may touch at all
  for v_tb in select * from (values
    ('private.extraction_spend'), ('private.extraction_run_tokens'), ('pgmq.q_extraction'), ('pgmq.a_extraction')
  ) t(name) loop
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      foreach v_priv in array array['select', 'insert', 'update', 'delete', 'truncate'] loop
        if has_table_privilege(v_role, v_tb.name, v_priv) then
          raise exception '% has % on %', v_role, v_priv, v_tb.name;
        end if;
      end loop;
    end loop;
  end loop;

  -- runs: members read every column but the queue's message id
  -- (20260925000004) under RLS, nobody writes them
  if has_table_privilege('authenticated', 'public.extraction_runs', 'select')
     or has_column_privilege('authenticated', 'public.extraction_runs', 'queue_msg_id', 'select')
     or exists (select 1 from information_schema.columns c
                where c.table_schema = 'public' and c.table_name = 'extraction_runs' and c.column_name <> 'queue_msg_id'
                  and not has_column_privilege('authenticated', 'public.extraction_runs', c.column_name, 'select'))
     or has_table_privilege('authenticated', 'public.extraction_runs', 'insert')
     or has_table_privilege('authenticated', 'public.extraction_runs', 'update')
     or has_table_privilege('authenticated', 'public.extraction_runs', 'delete')
     or has_table_privilege('anon', 'public.extraction_runs', 'select') then
    raise exception 'extraction_runs grants changed';
  end if;
  if has_schema_privilege('anon', 'pgmq', 'usage') or has_schema_privilege('authenticated', 'pgmq', 'usage')
     or has_schema_privilege('anon', 'private', 'usage') then
    raise exception 'an API role has usage on pgmq, or anon on private';
  end if;
  insert into checks (step, result) values ('the grants match section 5 for the queue''s functions and tables, the ledger, the tokens and the runs', 'ok');
  insert into checks (step, result) values ('members read every column of a run but queue_msg_id', 'ok');

  -- pg_net's own grants belong to supabase_admin, and postgres can't revoke
  -- them (20260925000002, section 1): recorded, not asserted
  insert into checks (step, result) values ('pg_net as Supabase installs it (not revocable by postgres; net is not an exposed schema)',
    'net.http_post execute: anon ' || has_function_privilege('anon', 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'execute')
    || ', authenticated ' || has_function_privilege('authenticated', 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'execute'));
end $t$;

-- 10. The claim's own timeout (20260925000005) ---------------------------------

-- The claim runs under a transaction_timeout of its own, so a claim held up
-- past it rolls back instead of leaving a run claimed with nobody on it (the
-- two-session stuck-claim case in test:db exercises it). A function's
-- setting doesn't re-arm a timer already running, so no role the API or the
-- worker connects as may set a transaction_timeout of its own.
do $t$
declare
  v_config text[];
begin
  select p.proconfig into v_config from pg_proc p
  where p.oid = 'public.claim_extraction_run()'::regprocedure;
  if not ('transaction_timeout=5s' = any (coalesce(v_config, '{}'))) then
    raise exception 'claim_extraction_run has no transaction_timeout of 5s: %', v_config;
  end if;
  if exists (select 1 from pg_roles r
             where r.rolname in ('authenticator', 'service_role', 'authenticated', 'anon', 'postgres')
               and exists (select 1 from unnest(coalesce(r.rolconfig, '{}')) c where c like 'transaction_timeout=%'))
     or exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) c where c like 'transaction_timeout=%') then
    raise exception 'a role or database sets a transaction_timeout, which would hold the claim to that one instead';
  end if;
  insert into checks (step, result) values
    ('the claim runs under its own 5 s transaction_timeout, and no role or database sets one that would override it', array_to_string(v_config, ', '));
end $t$;

select step, result from checks order by n;

rollback;
