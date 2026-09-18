-- Tests the stale-run reaper in open_extraction_run against the TEST
-- project (never the app's), inside a transaction that is always rolled
-- back. Run with
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
  'a1a1a1a1-0000-4000-8000-000000000001', 'needs_review', 'application/pdf', 3141);
-- stale.pdf stands for evals/documents/invoice-gbp-numeric-dates.pdf: one
-- page, 3141 bytes, whose real Haiku run read 5915 tokens in and wrote 521
-- out. long.pdf is a 20-page document, to show the charge grows with pages.
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
values ('c3c3c3c3-0000-4000-8000-000000000004', 'b2b2b2b2-0000-4000-8000-000000000002', 'long.pdf',
  'a1a1a1a1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 250000);

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
  v_limits   public.extraction_limits := (select l from public.extraction_limits l);
  v_expected numeric;
  v_real     numeric;
  v_third    record;
  v_long     record;
  v_wrapped  record;
  v_long_run public.extraction_runs;
  v_price    public.extraction_model_prices;
begin
  -- the estimate for a one-page run, from the formula in 20260918000003:
  -- max_calls_per_run calls of the prompt plus one page in and the output
  -- cap out, at abandoned_run_price_model's price
  select p.* into v_price from public.extraction_model_prices p where p.model = v_limits.abandoned_run_price_model;
  v_expected := round((
      v_limits.max_calls_per_run * (v_limits.prompt_input_tokens + v_limits.input_tokens_per_page) * v_price.input_usd_per_million
    + v_limits.max_calls_per_run * v_limits.max_output_tokens_per_call * v_price.output_usd_per_million) / 1000000, 8);
  -- what a real run of the same document cost: its recorded tokens at the
  -- price of the model that served it
  select round((5915 * p.input_usd_per_million + 521 * p.output_usd_per_million) / 1000000, 8)
  into v_real from public.extraction_model_prices p where p.model = 'claude-haiku-4-5-20251001';
  if v_expected is null or v_real is null then
    raise exception 'could not compute the expected estimate (%) or the real cost (%)', v_expected, v_real;
  end if;

  -- 1. open a run and leave it running
  select * into v_first from public.open_extraction_run('c3c3c3c3-0000-4000-8000-000000000003', 1);
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
  if v_run.status <> 'failed' or v_run.finished_at is null or v_run.error not like 'cost estimated at % prices (abandoned; %): abandoned: still running after % minutes%' then
    raise exception 'stale run not failed as expected: % / % / %', v_run.status, v_run.finished_at, v_run.error;
  end if;
  if v_run.cost_usd is distinct from v_expected then
    raise exception 'a reaped run must be charged the estimate %, got %', v_expected, v_run.cost_usd;
  end if;
  if v_run.cost_usd <= v_real then
    raise exception 'the estimate % must be more than a real run of the same document (%)', v_run.cost_usd, v_real;
  end if;
  if v_run.cost_usd >= 0.1 * v_limits.tenant_monthly_ceiling_usd then
    raise exception 'a one-page abandoned run must cost under 10%% of the tenant ceiling %, got %',
      v_limits.tenant_monthly_ceiling_usd, v_run.cost_usd;
  end if;
  if v_run.error not like 'cost estimated at % prices (abandoned; % for 1 page): abandoned: still running after %'
     or v_run.model is not null or v_run.input_tokens is not null then
    raise exception 'a reaped run must be marked estimated and record no usage: % / % / %',
      v_run.error, v_run.model, v_run.input_tokens;
  end if;
  insert into checks (step, result) values ('stale run failed with a reason', v_run.error);
  insert into checks (step, result) values ('one-page stale run charged the estimate: over a real run, under 10% of the ceiling',
    v_run.cost_usd::text || ' USD, real run ' || v_real::text || ' USD');
  insert into checks (step, result) values ('the reaping open still proceeds', 'ok');

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

  -- 6. the charge counts from the next open on, and still leaves the
  --    tenant able to run again
  select * into v_third from public.open_extraction_run('c3c3c3c3-0000-4000-8000-000000000003', 1);
  if v_third.run_id is null then
    raise exception 'the tenant could not run again after the estimate';
  end if;
  insert into checks (step, result) values ('the tenant can run again after the estimate',
    (select sum(cost_usd)::text from public.extraction_runs
     where tenant_id = 'b2b2b2b2-0000-4000-8000-000000000002') || ' USD spent this month');

  -- 7. the charge grows with the page count: a 20-page run left to go stale
  select * into v_long from public.open_extraction_run('c3c3c3c3-0000-4000-8000-000000000004', 20);
  update public.extraction_runs set started_at = now() - make_interval(mins => v_minutes) - interval '1 second'
  where id = v_long.run_id;
  -- reaped by an open through the old one-argument signature, the wrapper
  -- kept for app code deployed before 20260918000003: it opens a run with
  -- no page count
  select * into v_wrapped from public.open_extraction_run('c3c3c3c3-0000-4000-8000-000000000004');
  if v_wrapped.run_id is null
     or (select page_count from public.extraction_runs where id = v_wrapped.run_id) is not null then
    raise exception 'the one-argument open must still open a run, with no page count';
  end if;
  insert into checks (step, result) values ('the old one-argument open still works, with no page count', 'ok');
  select * into v_long_run from public.extraction_runs where id = v_long.run_id;
  if v_long_run.page_count <> 20 or v_long_run.cost_usd <= 2 * v_expected then
    raise exception 'a 20-page abandoned run must cost well over a one-page one (% vs %), pages %',
      v_long_run.cost_usd, v_expected, v_long_run.page_count;
  end if;
  insert into checks (step, result) values ('a 20-page stale run is charged more than a one-page one',
    v_long_run.cost_usd::text || ' USD vs ' || v_expected::text || ' USD');
end $t$;

select step, result from checks order by n;

rollback;
