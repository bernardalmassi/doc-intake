-- Tests the stale-run reaper that enqueue_extraction_run runs for the
-- document it enqueues (20260925000002), against the TEST project (never the
-- app's), inside a transaction that is always rolled back. Run with
--   npm run test:db
-- It creates a throwaway user, tenants and documents as postgres, then acts
-- as their owner through auth.uid(), and as the worker by calling
-- claim_extraction_run and finish_extraction_run as postgres. Every check
-- raises on failure, so a non-zero exit is a failed test; the final select
-- lists what was checked.
--
-- This lives in SQL rather than in Vitest because the reaper only acts on a
-- run older than extraction_limits.stale_run_minutes, and nothing reachable
-- through the API can backdate started_at or claimed_at.
begin;

create temp table checks (n serial, step text, result text);

-- the claims below read this test's messages only
do $t$
begin
  if exists (select 1 from pgmq.q_extraction) or exists (select 1 from public.extraction_runs where status in ('queued', 'running')) then
    raise exception 'the extraction queue is not idle (a suite run in progress, or one killed less than 16 min 10 s ago); run test:db again once the sweep has ended it';
  end if;
end $t$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
values ('a1a1a1a1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated',
  'authenticated', 'stale-test-owner@example.invalid', 'x', now(), now(), now(), '{}', '{}', false, false);

insert into public.tenants (id, name, slug) values
  ('b2b2b2b2-0000-4000-8000-000000000002', 'Stale run test', 'stale-run-test'),
  ('b2b2b2b2-0000-4000-8000-000000000003', 'Stale run sums test', 'stale-run-sums-test'),
  ('b2b2b2b2-0000-4000-8000-000000000004', 'Stale run pages test', 'stale-run-pages-test');
-- three tenants, so no tenant starts more than the hourly limit's 5 runs
insert into public.memberships (tenant_id, user_id, role) values
  ('b2b2b2b2-0000-4000-8000-000000000002', 'a1a1a1a1-0000-4000-8000-000000000001', 'owner'),
  ('b2b2b2b2-0000-4000-8000-000000000003', 'a1a1a1a1-0000-4000-8000-000000000001', 'owner'),
  ('b2b2b2b2-0000-4000-8000-000000000004', 'a1a1a1a1-0000-4000-8000-000000000001', 'owner');
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
values ('c3c3c3c3-0000-4000-8000-000000000003', 'b2b2b2b2-0000-4000-8000-000000000002', 'stale.pdf',
  'a1a1a1a1-0000-4000-8000-000000000001', 'needs_review', 'application/pdf', 3141);
-- stale.pdf stands for evals/documents/invoice-gbp-numeric-dates.pdf: one
-- page, 3141 bytes, whose real Sonnet 5 run read 6708 tokens in and wrote
-- 852 out. long.pdf is a 20-page document, to show the charge grows with pages.
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
values ('c3c3c3c3-0000-4000-8000-000000000004', 'b2b2b2b2-0000-4000-8000-000000000004', 'long.pdf',
  'a1a1a1a1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 250000);
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
values ('c3c3c3c3-0000-4000-8000-000000000005', 'b2b2b2b2-0000-4000-8000-000000000002', 'queued.pdf',
  'a1a1a1a1-0000-4000-8000-000000000001', 'extracted', 'application/pdf', 3141);
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes) values
  ('c3c3c3c3-0000-4000-8000-000000000006', 'b2b2b2b2-0000-4000-8000-000000000003', 'sums-a.pdf',
   'a1a1a1a1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141),
  ('c3c3c3c3-0000-4000-8000-000000000007', 'b2b2b2b2-0000-4000-8000-000000000003', 'sums-b.pdf',
   'a1a1a1a1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141);

-- act as the owner
select set_config('request.jwt.claims',
  '{"sub":"a1a1a1a1-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $t$
declare
  v_minutes  integer := (select stale_run_minutes from public.extraction_limits);
  v_limits   public.extraction_limits := (select l from public.extraction_limits l);
  v_first    uuid;
  v_second   uuid;
  v_claim    record;
  v_run      public.extraction_runs;
  v_doc      public.documents;
  v_spend    record;
  v_msg_id   bigint;
  v_expected numeric;
  v_real     numeric;
  v_long     uuid;
  v_long_run public.extraction_runs;
  v_queued   uuid;
  v_price    public.extraction_model_prices;
  v_sums_a   uuid;
begin
  -- the estimate for a one-page run, from the formula in 20260918000003
  -- with the retry allowance of 20260925000005: max_calls_per_run calls of
  -- the prompt plus one page in, the retry's allowance on top, and the
  -- output cap out, at abandoned_run_price_model's price
  select p.* into v_price from public.extraction_model_prices p where p.model = v_limits.abandoned_run_price_model;
  v_expected := round((
      (v_limits.max_calls_per_run * (v_limits.prompt_input_tokens + v_limits.input_tokens_per_page) + v_limits.retry_input_tokens)
        * v_price.input_usd_per_million
    + v_limits.max_calls_per_run * v_limits.max_output_tokens_per_call * v_price.output_usd_per_million) / 1000000, 8);
  -- what a real run of the same document cost: its recorded tokens at the
  -- price of the model that served it (evals/recordings/
  -- invoice-gbp-numeric-dates.anthropic.json, Claude Sonnet 5)
  select round((6708 * p.input_usd_per_million + 852 * p.output_usd_per_million) / 1000000, 8)
  into v_real from public.extraction_model_prices p where p.model = 'claude-sonnet-5';
  if v_expected is null or v_real is null then
    raise exception 'could not compute the expected estimate (%) or the real cost (%)', v_expected, v_real;
  end if;

  -- 1. enqueue a run and claim it, as the worker would
  v_first := public.enqueue_extraction_run('c3c3c3c3-0000-4000-8000-000000000003', 1);
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_first then
    raise exception 'expected to claim %, got %', v_first, v_claim.run_id;
  end if;
  select * into v_doc from public.documents where id = 'c3c3c3c3-0000-4000-8000-000000000003';
  if v_doc.status <> 'processing' then
    raise exception 'expected processing after the claim, got %', v_doc.status;
  end if;
  select queue_msg_id into v_msg_id from public.extraction_runs where id = v_first;
  insert into checks (step, result) values ('enqueue and claim leave the document processing', 'ok');

  -- 2. a second enqueue just under the threshold, measured from the claim,
  --    is refused: an old started_at alone doesn't make a claimed run stale
  update public.extraction_runs
  set started_at = now() - make_interval(mins => v_minutes) - interval '1 minute',
      claimed_at = now() - make_interval(mins => v_minutes) + interval '30 seconds'
  where id = v_first;
  begin
    perform public.enqueue_extraction_run('c3c3c3c3-0000-4000-8000-000000000003', 1);
    raise exception 'a run claimed % seconds short of stale was reaped', 30;
  exception when sqlstate '55000' then
    insert into checks (step, result) values ('a run claimed less than the threshold ago still blocks', sqlerrm);
  end;

  -- 3. claimed past the threshold: the next enqueue reaps it and proceeds
  update public.extraction_runs set claimed_at = now() - make_interval(mins => v_minutes) - interval '1 second'
  where id = v_first;
  v_second := public.enqueue_extraction_run('c3c3c3c3-0000-4000-8000-000000000003', 1);
  if v_second = v_first then
    raise exception 'the reaped run was returned again';
  end if;

  select * into v_run from public.extraction_runs where id = v_first;
  if v_run.status <> 'failed' or v_run.finished_at is null
     or v_run.error not like 'cost estimated at % prices (abandoned; % for 1 page): abandoned: not finished after % minutes%' then
    raise exception 'stale run not failed as expected: % / % / %', v_run.status, v_run.finished_at, v_run.error;
  end if;
  if v_run.cost_usd is distinct from v_expected then
    raise exception 'a reaped run must be charged the estimate %, got %', v_expected, v_run.cost_usd;
  end if;
  if v_run.cost_usd <= v_real then
    raise exception 'the estimate % must be more than a real run of the same document (%)', v_run.cost_usd, v_real;
  end if;
  -- a handful of abandoned runs (the hourly run limit's worth) must not
  -- exhaust a tenant (SECURITY.md, "Stale runs")
  if v_limits.hourly_run_limit * v_run.cost_usd >= v_limits.tenant_monthly_ceiling_usd then
    raise exception '% one-page abandoned runs at % USD would exhaust the tenant ceiling %',
      v_limits.hourly_run_limit, v_run.cost_usd, v_limits.tenant_monthly_ceiling_usd;
  end if;
  if v_run.model is not null or v_run.input_tokens is not null then
    raise exception 'a reaped run must record no usage: % / %', v_run.model, v_run.input_tokens;
  end if;
  select * into v_spend from private.extraction_spend where run_id = v_first;
  if v_spend.kind is distinct from 'abandoned' or v_spend.cost_usd is distinct from v_expected
     or v_spend.model is distinct from v_limits.abandoned_run_price_model
     or v_spend.input_tokens is distinct from
          v_limits.max_calls_per_run * (v_limits.prompt_input_tokens + v_limits.input_tokens_per_page) + v_limits.retry_input_tokens then
    raise exception 'the ledger must hold the estimate for the reaped run: % / % / % / %',
      v_spend.kind, v_spend.cost_usd, v_spend.model, v_spend.input_tokens;
  end if;
  if exists (select 1 from pgmq.q_extraction where msg_id = v_msg_id)
     or not exists (select 1 from pgmq.a_extraction where msg_id = v_msg_id) then
    raise exception 'the reaped run''s message must be archived';
  end if;
  insert into checks (step, result) values ('claimed stale run failed with a reason', v_run.error);
  insert into checks (step, result) values ('one-page stale run charged the estimate, in the run and the ledger: over a real run; an hour''s worth leaves the tenant able to run',
    v_run.cost_usd::text || ' USD, real run ' || v_real::text || ' USD');
  insert into checks (step, result) values ('its message archived; the reaping enqueue still proceeds', 'ok');

  -- the new run's previous status is the one the stale run had restored
  select * into v_run from public.extraction_runs where id = v_second;
  if v_run.status <> 'queued' or v_run.previous_document_status <> 'needs_review' then
    raise exception 'new run should be queued with previous status needs_review, got % / %',
      v_run.status, v_run.previous_document_status;
  end if;
  insert into checks (step, result) values ('new run enqueued with the restored previous status', v_run.previous_document_status::text);

  -- 4. the stale run's claim token no longer works: a late finish is refused
  begin
    perform public.finish_extraction_run(v_first, v_claim.claim_token, 'failed',
      null, null, 0, 0, 1, 0, false, 'late', null, null);
    raise exception 'late finish of a reaped run was accepted';
  exception when sqlstate '42501' then
    insert into checks (step, result) values ('late finish of the reaped run is refused', sqlerrm);
  end;

  -- 5. the new run, claimed and finished as failed, restores needs_review
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_second then
    raise exception 'expected to claim %, got %', v_second, v_claim.run_id;
  end if;
  perform public.finish_extraction_run(v_second, v_claim.claim_token, 'failed',
    null, null, 0, 0, 1, 0, false, 'test', null, null);
  select * into v_doc from public.documents where id = 'c3c3c3c3-0000-4000-8000-000000000003';
  if v_doc.status <> 'needs_review' then
    raise exception 'expected needs_review after a failed finish, got %', v_doc.status;
  end if;
  insert into checks (step, result) values ('document back to needs_review', 'ok');

  -- 6. a run never claimed is expired at no cost, and the enqueue proceeds
  v_queued := public.enqueue_extraction_run('c3c3c3c3-0000-4000-8000-000000000005', 1);
  update public.extraction_runs set started_at = now() - make_interval(mins => v_minutes) - interval '1 second'
  where id = v_queued;
  perform public.enqueue_extraction_run('c3c3c3c3-0000-4000-8000-000000000005', 1);
  select * into v_run from public.extraction_runs where id = v_queued;
  select * into v_spend from private.extraction_spend where run_id = v_queued;
  if v_run.status <> 'failed' or v_run.cost_usd <> 0 or v_run.error not like 'expired: %'
     or v_spend.kind is distinct from 'expired' or v_spend.cost_usd <> 0 then
    raise exception 'a never-claimed stale run must expire at 0: % / % / % / % / %',
      v_run.status, v_run.cost_usd, v_run.error, v_spend.kind, v_spend.cost_usd;
  end if;
  select * into v_doc from public.documents where id = 'c3c3c3c3-0000-4000-8000-000000000005';
  if v_doc.status <> 'processing' then
    raise exception 'the new run should hold the document, got %', v_doc.status;
  end if;
  insert into checks (step, result) values ('never-claimed stale run expired at 0, in the run and the ledger', v_run.error);
  -- end the new run, so the queue holds nothing for the next claim
  perform private.reap_extraction_run(r.id, 'test') from public.extraction_runs r
  where r.document_id = 'c3c3c3c3-0000-4000-8000-000000000005' and r.status = 'queued';

  -- 7. the charge grows with the page count: a 20-page run left to go stale
  v_long := public.enqueue_extraction_run('c3c3c3c3-0000-4000-8000-000000000004', 20);
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_long then
    raise exception 'expected to claim %, got %', v_long, v_claim.run_id;
  end if;
  update public.extraction_runs set claimed_at = now() - make_interval(mins => v_minutes) - interval '1 second'
  where id = v_long;
  -- the next enqueue reaps it
  perform public.enqueue_extraction_run('c3c3c3c3-0000-4000-8000-000000000004', 20);
  select * into v_long_run from public.extraction_runs where id = v_long;
  if v_long_run.page_count <> 20 or v_long_run.cost_usd <= 2 * v_expected then
    raise exception 'a 20-page abandoned run must cost well over a one-page one (% vs %), pages %',
      v_long_run.cost_usd, v_expected, v_long_run.page_count;
  end if;
  insert into checks (step, result) values ('a 20-page stale run is charged more than a one-page one',
    v_long_run.cost_usd::text || ' USD vs ' || v_expected::text || ' USD');
  perform private.reap_extraction_run(r.id, 'test') from public.extraction_runs r
  where r.document_id = 'c3c3c3c3-0000-4000-8000-000000000004' and r.status = 'queued';

  -- 8. the reaped run counts in the same enqueue's sums (20260925000005):
  --    with the ledger just under the tenant ceiling, the reap's charge
  --    takes the tenant over it, so the enqueue that reaped is refused, and
  --    the refusal rolls the reap back with it: the stale run is still in
  --    flight, with its token and no ledger row. The sweep then ends it on
  --    its next tick, once its message's visibility timeout has passed, and
  --    the next enqueue is refused too. Before, the reaped run's row was
  --    left out, so the reaping enqueue passed, and the run was counted
  --    nowhere (the review's V2).
  insert into private.extraction_spend (kind, tenant_id, run_id, cost_usd)
  values ('charge', 'b2b2b2b2-0000-4000-8000-000000000003', gen_random_uuid(),
          v_limits.tenant_monthly_ceiling_usd - v_expected / 2);
  v_sums_a := public.enqueue_extraction_run('c3c3c3c3-0000-4000-8000-000000000006', 1);
  select * into v_claim from public.claim_extraction_run();
  if v_claim.run_id is distinct from v_sums_a then
    raise exception 'expected to claim %, got %', v_sums_a, v_claim.run_id;
  end if;
  update public.extraction_runs set claimed_at = now() - make_interval(mins => v_minutes) - interval '1 second'
  where id = v_sums_a;
  begin
    perform public.enqueue_extraction_run('c3c3c3c3-0000-4000-8000-000000000006', 1);
    raise exception 'the enqueue that reaped a run passed a check that left the reaped run out';
  exception when sqlstate '53400' then
    insert into checks (step, result) values ('the reaped run counts in the sums of the enqueue that reaped it', sqlerrm);
  end;
  select * into v_run from public.extraction_runs where id = v_sums_a;
  if v_run.status <> 'running'
     or not exists (select 1 from private.extraction_run_tokens t where t.run_id = v_sums_a)
     or exists (select 1 from private.extraction_spend s where s.run_id = v_sums_a)
     or (select count(*) from public.extraction_runs r where r.document_id = 'c3c3c3c3-0000-4000-8000-000000000006') <> 1 then
    raise exception 'the refused enqueue kept its reap or its run: status %', v_run.status;
  end if;
  insert into checks (step, result) values ('the refusal rolled the reap back: the stale run still in flight, its token kept, no ledger row', 'ok');
  -- the sweep's next tick, once the claimed message's visibility timeout
  -- has passed
  update pgmq.q_extraction q set vt = now() - interval '1 second' where q.msg_id = v_run.queue_msg_id;
  perform private.sweep_extraction_queue();
  select * into v_run from public.extraction_runs where id = v_sums_a;
  select * into v_spend from private.extraction_spend where run_id = v_sums_a;
  if v_run.status <> 'failed' or v_spend.kind is distinct from 'abandoned' or v_spend.cost_usd is distinct from v_expected then
    raise exception 'the sweep did not end the stale run at the estimate: % / % / %', v_run.status, v_spend.kind, v_spend.cost_usd;
  end if;
  insert into checks (step, result) values ('the sweep ended it on its next tick, at the estimate',
    (select sum(cost_usd)::text from private.extraction_spend where tenant_id = 'b2b2b2b2-0000-4000-8000-000000000003')
    || ' USD in the ledger afterwards');
  begin
    perform public.enqueue_extraction_run('c3c3c3c3-0000-4000-8000-000000000007', 1);
    raise exception 'the reap''s charge did not count on the next enqueue';
  exception when sqlstate '53400' then
    insert into checks (step, result) values ('the next enqueue is refused too', sqlerrm);
  end;
end $t$;

select step, result from checks order by n;

rollback;
