-- The last fixes on the worker branch before production, from the review of
-- the review fixes (V1 to V12), each in a section of its own, numbered as
-- the items of the brief that asked for them (docs/worker-design.md and
-- SECURITY.md have the whole design). 20260925000004 and every migration
-- before it are left as they were applied.

-- 1. The per-call bound, calibrated from real counts (V1) --------------------

-- The per-call input bound (the prompt plus a figure per page) was 4 500 +
-- 3 000 a page, measured on sparse text PDFs, and since 20260925000004 it
-- is enforced: no call is sent whose counted input is over it. Claude
-- Sonnet 5's prompt alone counts 4 798, and a full-resolution phone photo
-- 4 743 more, so most photos and scans failed as too dense on the default
-- model, and many one-page validation retries were not sent.
--
-- The figures now come from Anthropic's token counting endpoint (free), on
-- every Anthropic model the app may select, for exactly the input a call
-- sends: the prompt with no attachment, the twelve eval fixtures, each
-- fixture's validation retry (the first call plus the recorded answer plus
-- the retry prompt with the longest validation error), a 3024x4032 phone
-- photo and an A4 page scanned at 150 dpi (evals/token-counts.json, counted
-- 2026-09-29). Each is the observed maximum plus 25%:
--
--   prompt_input_tokens    4 798 (Sonnet 5's prompt)             -> 5 998
--   input_tokens_per_page  4 743 (Sonnet 5, the phone photo)     -> 5 929
--   retry_input_tokens     1 418 (Sonnet 5, the retry of the
--                          numeric-dates invoice over its first
--                          call)                                 -> 1 773
--
-- A first call may read prompt + pages x page, at most
-- max_input_tokens_per_call (the prompt plus 100 pages, 598 898); the
-- validation retry that much plus retry_input_tokens. A run makes at most
-- max_calls_per_run (3) calls of which at most one is the retry, so the
-- estimate a run holds in flight, and an abandoned run is charged, is three
-- first calls plus the retry allowance, clamped per run as before. One page
-- is now 37 554 in and 6 144 out, 0.136548 USD at Sonnet 5 prices (it was
-- 0.10644); the per-run clamp (800 000 in) binds from 44 pages (it was 88),
-- where the estimate is 1.66144 USD as before.
--
-- The mirror in src/lib/extraction/config.ts changes with it;
-- tests/extraction.test.ts checks the two agree, and
-- tests/unit/input-bound.test.ts that every count passes the bound and that
-- these figures are the counts' maxima plus 25%.

alter table public.extraction_limits
  add column retry_input_tokens integer not null default 1773 check (retry_input_tokens >= 0);

update public.extraction_limits
set prompt_input_tokens       = 5998,
    input_tokens_per_page     = 5929,
    max_input_tokens_per_call = 598898,
    retry_input_tokens        = 1773;

alter table public.extraction_limits
  alter column prompt_input_tokens       set default 5998,
  alter column input_tokens_per_page     set default 5929,
  alter column max_input_tokens_per_call set default 598898;

-- As in 20260925000002, except that the run's input is three first calls
-- plus the retry allowance: max_calls_per_run * input_per_call +
-- retry_input_tokens, then the per-run clamp. input_per_call is still a
-- first call's.
create or replace function private.abandoned_estimate(p_page_count integer)
returns table (model text, provider text, pages integer, input_per_call integer,
               input_tokens integer, output_tokens integer, cost_usd numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limits   public.extraction_limits;
  v_provider text;
  v_pages    integer;
  v_per_call integer;
  v_charge   record;
begin
  select l.* into v_limits from public.extraction_limits l;
  select p.provider into v_provider from public.extraction_model_prices p
  where p.model = v_limits.abandoned_run_price_model;
  v_pages    := least(greatest(coalesce(p_page_count, v_limits.max_pages_per_document), 1),
                      v_limits.max_pages_per_document);
  v_per_call := least(v_limits.prompt_input_tokens + v_pages * v_limits.input_tokens_per_page,
                      v_limits.max_input_tokens_per_call);
  select c.* into v_charge from private.extraction_charge(
    v_limits.abandoned_run_price_model, v_provider,
    least(v_limits.max_calls_per_run * v_per_call + v_limits.retry_input_tokens, v_limits.max_input_tokens_per_run),
    least(v_limits.max_calls_per_run * v_limits.max_output_tokens_per_call, v_limits.max_output_tokens_per_run)) c;
  return query select v_limits.abandoned_run_price_model, v_provider, v_pages, v_per_call,
    v_charge.input_tokens, v_charge.output_tokens, v_charge.cost_usd;
end;
$$;

-- As in 20260925000003, except that an abandoned run's error states the
-- retry allowance too, since the estimate now includes it. The parenthesis
-- still holds no parenthesis of its own (classifyRunError's pattern).
create or replace function private.reap_extraction_run(p_run_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_run    public.extraction_runs;
  v_limits public.extraction_limits;
  v_est    record;
begin
  v_run := private.lock_extraction_run(p_run_id, false);
  if v_run.id is null or v_run.status not in ('queued', 'running') then
    return null;
  end if;

  if v_run.status = 'running' then
    select l.* into v_limits from public.extraction_limits l;
    select e.* into v_est from private.abandoned_estimate(v_run.page_count) e;
    update public.extraction_runs
    set status      = 'failed',
        -- RUN_ERROR_MARKERS.costEstimated, then RUN_ERROR_MARKERS.abandoned
        error       = format('cost estimated at %s prices (abandoned; at most %s calls of %s tokens in, %s more on the retry, '
                             'and %s out, for %s): abandoned: %s',
                             v_est.model, v_limits.max_calls_per_run, v_est.input_per_call,
                             v_limits.retry_input_tokens, v_limits.max_output_tokens_per_call,
                             case when v_run.page_count is null then format('an unknown page count, charged as %s', v_est.pages)
                                  when v_est.pages = 1 then '1 page'
                                  else format('%s pages', v_est.pages) end,
                             p_reason),
        cost_usd    = v_est.cost_usd,
        finished_at = now()
    where id = p_run_id;
    insert into private.extraction_spend
      (kind, tenant_id, user_id, run_id, provider, model, input_tokens, output_tokens, cost_usd)
    values ('abandoned', v_run.tenant_id, v_run.started_by, v_run.id,
            v_est.provider, v_est.model, v_est.input_tokens, v_est.output_tokens, v_est.cost_usd);
  else
    update public.extraction_runs
    set status      = 'failed',
        -- RUN_ERROR_MARKERS.expired
        error       = format('expired: %s', p_reason),
        cost_usd    = 0,
        finished_at = now()
    where id = p_run_id;
    insert into private.extraction_spend (kind, tenant_id, user_id, run_id, cost_usd)
    values ('expired', v_run.tenant_id, v_run.started_by, v_run.id, 0);
  end if;

  delete from private.extraction_run_tokens t where t.run_id = p_run_id;
  update public.documents d
  set status = v_run.previous_document_status
  where d.id = v_run.document_id and d.status = 'processing';
  if v_run.queue_msg_id is not null then
    perform pgmq.archive('extraction', v_run.queue_msg_id);
  end if;

  return case when v_run.status = 'running' then 'abandoned' else 'expired' end;
end;
$$;

-- 3. A finish with no token is refused, before any lock -------------------------

-- As in 20260925000003, except for the claim token. It was compared with
-- "v_token <> p_claim_token", which is null, so not true, for a null
-- p_claim_token: a finish with no token passed the check, as the old path's
-- close did until 20260925000004. Only service_role may call it, but the
-- token is what makes a finish the claimant's. Now a null token, or the nil
-- uuid (a uuid can't be an empty string; PostgREST refuses '' before the
-- call), is refused with the same 42501 as a wrong one, and, as the close
-- does, the token is checked before any row is locked, then again under the
-- locks, since a reap or another finish may delete it in between.
create or replace function public.finish_extraction_run(
  p_run_id         uuid,
  p_claim_token    uuid,
  p_status         text,
  p_provider       text,
  p_model          text,
  p_input_tokens   integer,
  p_output_tokens  integer,
  p_latency_ms     integer,
  p_attempts       integer,
  p_cost_estimated boolean,
  p_error          text,
  p_raw_response   text,
  p_fields         jsonb
)
returns public.extraction_runs
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant_id uuid;
  v_run       public.extraction_runs;
  v_token     uuid;
  v_field     jsonb;
  v_any_low   boolean := false;
  v_doc_id    uuid;
  v_charge    record;
  v_in        integer;
  v_out       integer;
  v_cost      numeric(12, 8);
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'status must be succeeded or failed' using errcode = '22023';
  end if;

  -- the token, before any lock: none, the nil uuid (an empty one) and a
  -- wrong one get the same error as an unknown run
  if p_claim_token is null or p_claim_token = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'run not found or claim token invalid' using errcode = '42501';
  end if;
  select t.token into v_token from private.extraction_run_tokens t where t.run_id = p_run_id;
  if v_token is distinct from p_claim_token then
    raise exception 'run not found or claim token invalid' using errcode = '42501';
  end if;

  -- the tenant, then the document, then the run (20260925000003)
  select r.tenant_id into v_tenant_id from public.extraction_runs r where r.id = p_run_id;
  perform 1 from public.tenants t where t.id = v_tenant_id for key share;
  v_run := private.lock_extraction_run(p_run_id, false);

  -- again under the lock: the token row is deleted when the run ends, so
  -- finishing twice, or after a reap, lands here too
  select t.token into v_token from private.extraction_run_tokens t
  where t.run_id = p_run_id;
  if not found or v_token is distinct from p_claim_token then
    raise exception 'run not found or claim token invalid' using errcode = '42501';
  end if;

  -- unreachable while the token is deleted when the run ends; kept as a guard
  if v_run.status <> 'running' then
    raise exception 'run is not running' using errcode = '55000';
  end if;

  if p_status = 'failed' then
    if p_fields is not null then
      raise exception 'a failed run cannot carry fields' using errcode = '22023';
    end if;
    if p_error is null or length(trim(p_error)) = 0 then
      raise exception 'a failed run needs an error' using errcode = '22023';
    end if;
  end if;

  v_doc_id := v_run.document_id;

  -- usage and cost
  if p_model is null then
    if p_status = 'succeeded' then
      raise exception 'a successful run must name its model' using errcode = '22023';
    end if;
    if coalesce(p_input_tokens, 0) <> 0 or coalesce(p_output_tokens, 0) <> 0 then
      raise exception 'token counts without a model' using errcode = '22023';
    end if;
    v_in := null; v_out := null; v_cost := 0;
  else
    select c.* into v_charge from private.extraction_charge(p_model, p_provider, p_input_tokens, p_output_tokens) c;
    v_in := v_charge.input_tokens; v_out := v_charge.output_tokens; v_cost := v_charge.cost_usd;
  end if;

  if p_status = 'succeeded' then
    if p_fields is null or jsonb_typeof(p_fields) <> 'array' then
      raise exception 'fields must be a JSON array' using errcode = '22023';
    end if;

    for v_field in select * from jsonb_array_elements(p_fields) loop
      if jsonb_typeof(v_field) <> 'object'
        or jsonb_typeof(v_field -> 'name') <> 'string'
        or jsonb_typeof(v_field -> 'confidence') <> 'number'
        or jsonb_typeof(v_field -> 'band') <> 'string'
        or (v_field ->> 'band') not in ('high', 'medium', 'low')
        or coalesce(jsonb_typeof(v_field -> 'value'), 'null') not in ('string', 'null')
        or coalesce(jsonb_typeof(v_field -> 'source_text'), 'null') not in ('string', 'null')
        or coalesce(jsonb_typeof(v_field -> 'clarifying_question'), 'null') not in ('string', 'null')
      then
        raise exception 'malformed field: %', v_field using errcode = '22023';
      end if;
      if (v_field ->> 'band') = 'low' then
        v_any_low := true;
      end if;
    end loop;

    -- the document may have been deleted while the run was in flight; the
    -- run is still recorded, there is just nothing to write fields to
    if v_doc_id is not null then
      delete from public.extracted_fields f where f.document_id = v_doc_id;

      insert into public.extracted_fields
        (tenant_id, document_id, run_id, name, value, confidence, band, source_text, clarifying_question)
      select
        v_run.tenant_id,
        v_doc_id,
        v_run.id,
        f ->> 'name',
        f ->> 'value',
        (f ->> 'confidence')::numeric,
        (f ->> 'band')::public.confidence_band,
        f ->> 'source_text',
        f ->> 'clarifying_question'
      from jsonb_array_elements(p_fields) f;

      update public.documents
      set status = case when v_any_low then 'needs_review' else 'extracted' end::public.document_status
      where id = v_doc_id;
    end if;
  else
    -- put the document back exactly where it was; fields are untouched
    update public.documents
    set status = v_run.previous_document_status
    where id = v_doc_id;
  end if;

  update public.extraction_runs r
  set status        = p_status::public.extraction_run_status,
      provider      = p_provider,
      model         = p_model,
      attempts      = p_attempts,
      input_tokens  = v_in,
      output_tokens = v_out,
      cost_usd      = v_cost,
      latency_ms    = p_latency_ms,
      error         = p_error,
      raw_response  = p_raw_response,
      finished_at   = now()
  where r.id = p_run_id
  returning * into v_run;

  insert into private.extraction_spend
    (kind, tenant_id, user_id, run_id, provider, model, input_tokens, output_tokens, cost_usd)
  values (case when p_cost_estimated then 'estimate' else 'charge' end,
          v_run.tenant_id, v_run.started_by, v_run.id, p_provider, p_model, v_in, v_out, v_cost);

  if v_run.queue_msg_id is not null then
    perform pgmq.archive('extraction', v_run.queue_msg_id);
  end if;
  delete from private.extraction_run_tokens t where t.run_id = p_run_id;

  return v_run;
end;
$$;

-- 4. A claim that doesn't finish in time rolls back ------------------------------

-- The claim had no time limit of its own: service_role, which the worker
-- calls it as, has no statement timeout. A claim held up long enough (behind
-- a migration's table lock, say) could commit after the worker invoking it
-- was gone: the run claimed, its message hidden for the visibility timeout,
-- nobody working on it, and the sweep abandoning it later at the estimate
-- though no model was called.
--
-- A statement_timeout set on a function does not apply to the call already
-- running (measured on the test project, 2026-09-27: a call ran 2.5 s past a
-- 1 s limit). A transaction_timeout does: PostgreSQL 17 arms it when the
-- function's setting takes effect and disarms it when the function returns
-- (measured too), so it bounds exactly the claim's own run. When it fires
-- the database ends the session (25P04), which rolls the claim back whole:
-- the message's read, the run's status and its token. The worker waits 8 s
-- for the claim's answer (CLAIM_REQUEST_TIMEOUT_MS), longer than this, so by
-- the time it gives up the claim has committed or rolled back. A caller
-- already running under a transaction_timeout of its own keeps that one (a
-- function's setting doesn't re-arm a running timer; measured); no API role
-- sets one, which extraction_queue.sql checks. Mirrored in config.ts as
-- CLAIM_TIMEOUT_MS; queue-migration.test.ts checks the two agree.
alter function public.claim_extraction_run() set transaction_timeout = '5s';

-- 5. The enqueue's check counts the run its reaper just reaped (V2) ----------------

-- check_extraction_limits took the id of a run the caller's reaper had just
-- ended and left that run's ledger row out of its sums, because a refusal
-- would roll the reap back too. But the run was no longer in flight either,
-- so it was counted nowhere: a stale run of up to 1.66144 USD, abandoned by
-- the very enqueue that then passed the check, let a tenant, or the whole
-- project, go past a ceiling by that run's estimate as well as the new
-- run's (the review's V2; SECURITY.md said "at most one estimate"). Now the
-- check counts every ledger row, the reaped run's included. When that
-- refuses the enqueue, the refusal rolls the reap back with it: the stale
-- run stays in flight, counted at its estimate as before, and the sweep ends
-- it on its next tick (step (a) or (c) for a claimed or old-path run, (d)
-- for a queued one), after which the admin can enqueue again.
--
-- A new signature, with no reaped-run parameter; enqueue and open call it,
-- and the old one is dropped (it is private: no deployed app calls it).
create function private.check_extraction_limits(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_limits      public.extraction_limits;
  v_month_start timestamptz := date_trunc('month', now(), 'UTC');
  v_total       numeric;
  v_recent_runs integer;
begin
  -- one check at a time, project wide
  perform pg_advisory_xact_lock(hashtext('public.extraction_runs'));

  select l.* into v_limits from public.extraction_limits l;

  -- the tenant's ledger this month plus its runs in flight, in one snapshot
  select (select coalesce(sum(s.cost_usd), 0)
          from private.extraction_spend s
          where s.tenant_id = p_tenant_id
            and s.created_at >= v_month_start)
       + (select coalesce(sum(e.cost_usd), 0)
          from public.extraction_runs r
          cross join lateral private.abandoned_estimate(r.page_count) e
          where r.tenant_id = p_tenant_id
            and r.status in ('queued', 'running'))
  into v_total;

  if v_total >= v_limits.tenant_monthly_ceiling_usd then
    raise exception 'this organization has reached its monthly extraction spend ceiling (% USD), counting extractions in progress',
      v_limits.tenant_monthly_ceiling_usd
      using errcode = '53400';
  end if;

  -- the same across every tenant, in one snapshot
  select (select coalesce(sum(s.cost_usd), 0)
          from private.extraction_spend s
          where s.created_at >= v_month_start)
       + (select coalesce(sum(e.cost_usd), 0)
          from public.extraction_runs r
          cross join lateral private.abandoned_estimate(r.page_count) e
          where r.status in ('queued', 'running'))
  into v_total;

  if v_total >= v_limits.global_monthly_ceiling_usd then
    raise exception 'the monthly extraction spend ceiling across all organizations has been reached (% USD), counting extractions in progress',
      v_limits.global_monthly_ceiling_usd
      using errcode = '53400';
  end if;

  select count(*) into v_recent_runs
  from public.extraction_runs r
  where r.tenant_id = p_tenant_id
    and r.started_at > now() - interval '1 hour';

  if v_recent_runs >= v_limits.hourly_run_limit then
    raise exception 'this organization has reached its limit of % extraction runs per hour',
      v_limits.hourly_run_limit
      using errcode = '54000';
  end if;
end;
$$;

revoke execute on function private.check_extraction_limits(uuid) from public, anon, authenticated;

-- As in 20260925000004, except for the check above.
create or replace function public.enqueue_extraction_run(p_document_id uuid, p_page_count integer)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id   uuid := (select auth.uid());
  v_tenant_id uuid;
  v_doc       public.documents;
  v_limits    public.extraction_limits;
  v_run_id    uuid;
  v_msg_id    bigint;
  v_stale_id  uuid;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- the caller, before any lock
  select d.tenant_id into v_tenant_id from public.documents d where d.id = p_document_id;
  if v_tenant_id is null or not private.is_tenant_admin(v_tenant_id) then
    raise exception 'document not found or you are not an admin of its organization'
      using errcode = '42501';
  end if;

  -- the tenant, then the document (20260925000003)
  perform 1 from public.tenants t where t.id = v_tenant_id for key share;

  -- lock the document so two enqueues for it are ordered
  select d.* into v_doc from public.documents d
  where d.id = p_document_id
  for update;

  -- again under the lock: one error for missing and not-admin, so the RPC
  -- can't be used to probe ids
  if not found or v_doc.tenant_id is distinct from v_tenant_id or not private.is_tenant_admin(v_doc.tenant_id) then
    raise exception 'document not found or you are not an admin of its organization'
      using errcode = '42501';
  end if;

  if v_doc.status = 'uploading' then
    raise exception 'the document has no file yet' using errcode = '55000';
  end if;

  select l.* into v_limits from public.extraction_limits l;

  -- the backstop for this document: a run still in flight past
  -- stale_run_minutes (from its claim if it has one) is ended
  select r.id into v_stale_id
  from public.extraction_runs r
  where r.document_id = v_doc.id
    and r.status in ('queued', 'running')
    and coalesce(r.claimed_at, r.started_at) < now() - make_interval(mins => v_limits.stale_run_minutes)
  order by r.started_at
  limit 1;

  if v_stale_id is not null then
    perform private.reap_extraction_run(v_stale_id,
      format('not finished after %s minutes; ended by a later extraction', v_limits.stale_run_minutes));
    select d.* into v_doc from public.documents d where d.id = p_document_id;
  end if;

  if v_doc.status = 'processing' then
    raise exception 'an extraction is already running for this document'
      using errcode = '55000';
  end if;

  -- the ledger this counts includes the row the reap above just wrote: a
  -- refusal raises, rolling the reap back with everything else, and the
  -- sweep ends the run on its next tick
  perform private.check_extraction_limits(v_doc.tenant_id);

  -- the page count is the caller's, clamped; the worker recounts it and
  -- refuses a run whose file doesn't match before any model call
  insert into public.extraction_runs
    (tenant_id, document_id, started_by, status, previous_document_status, page_count)
  values (v_doc.tenant_id, v_doc.id, v_user_id, 'queued', v_doc.status,
          case when p_page_count is null then null
               else least(greatest(p_page_count, 1), v_limits.max_pages_per_document) end)
  returning id into v_run_id;

  update public.documents set status = 'processing' where id = v_doc.id;

  select m into v_msg_id from pgmq.send('extraction', jsonb_build_object('run_id', v_run_id)) m;
  update public.extraction_runs set queue_msg_id = v_msg_id where id = v_run_id;

  perform private.wake_extraction_worker();

  return v_run_id;
end;
$$;

-- As in 20260925000004, except for the check above.
create or replace function public.open_extraction_run(p_document_id uuid, p_page_count integer)
returns table (run_id uuid, close_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id   uuid := (select auth.uid());
  v_tenant_id uuid;
  v_doc       public.documents;
  v_limits    public.extraction_limits;
  v_run_id    uuid;
  v_token     uuid := gen_random_uuid();
  v_stale_id  uuid;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- the caller, before any lock
  select d.tenant_id into v_tenant_id from public.documents d where d.id = p_document_id;
  if v_tenant_id is null or not private.is_tenant_admin(v_tenant_id) then
    raise exception 'document not found or you are not an admin of its organization'
      using errcode = '42501';
  end if;

  -- the tenant, then the document (20260925000003)
  perform 1 from public.tenants t where t.id = v_tenant_id for key share;

  -- lock the document so two opens for it are ordered
  select d.* into v_doc from public.documents d
  where d.id = p_document_id
  for update;

  -- again under the lock: one error for missing and not-admin
  if not found or v_doc.tenant_id is distinct from v_tenant_id or not private.is_tenant_admin(v_doc.tenant_id) then
    raise exception 'document not found or you are not an admin of its organization'
      using errcode = '42501';
  end if;

  if v_doc.status = 'uploading' then
    raise exception 'the document has no file yet' using errcode = '55000';
  end if;

  select l.* into v_limits from public.extraction_limits l;

  -- a run of this document still in flight past stale_run_minutes (from its
  -- claim if it has one) is ended, and the document released
  select r.id into v_stale_id
  from public.extraction_runs r
  where r.document_id = v_doc.id
    and r.status in ('queued', 'running')
    and coalesce(r.claimed_at, r.started_at) < now() - make_interval(mins => v_limits.stale_run_minutes)
  order by r.started_at
  limit 1;

  if v_stale_id is not null then
    perform private.reap_extraction_run(v_stale_id,
      format('not finished after %s minutes; ended by a later extraction', v_limits.stale_run_minutes));
    select d.* into v_doc from public.documents d where d.id = p_document_id;
  end if;

  if v_doc.status = 'processing' then
    raise exception 'an extraction is already running for this document'
      using errcode = '55000';
  end if;

  -- counting the reap above, as the enqueue does
  perform private.check_extraction_limits(v_doc.tenant_id);

  -- the page count is the caller's, clamped; null stays null (unknown)
  insert into public.extraction_runs
    (tenant_id, document_id, started_by, status, previous_document_status, page_count)
  values (v_doc.tenant_id, v_doc.id, v_user_id, 'running', v_doc.status,
          case when p_page_count is null then null
               else least(greatest(p_page_count, 1), v_limits.max_pages_per_document) end)
  returning id into v_run_id;

  insert into private.extraction_run_tokens (run_id, token) values (v_run_id, v_token);

  update public.documents set status = 'processing' where id = v_doc.id;

  return query select v_run_id, v_token;
end;
$$;

drop function private.check_extraction_limits(uuid, uuid);

-- 6. complete_document_upload checks the caller before any lock (V3) ------------

-- As in 20260917000009, except that the caller is checked before the row is
-- locked, as 20260925000004 did for the enqueue, open and close: the
-- document's uploader and organization are read without a lock, and a caller
-- who didn't upload it, or is no longer a member, is refused there, with the
-- same errors. Before, it locked the named document for update and only
-- then checked, so anyone who knew a document's id could hold that row and
-- make the claim and the sweep, which take it without waiting, skip its run.
-- Both checks are made again under the lock, since the row or the
-- membership can change in between.
create or replace function public.complete_document_upload(p_document_id uuid)
returns public.documents language plpgsql security definer set search_path = '' as $$
declare
  v_user_id  uuid := (select auth.uid());
  v_uploader uuid;
  v_tenant   uuid;
  v_doc      public.documents;
  v_meta     jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- the caller, before any lock: one error for missing and not-mine, so the
  -- RPC can't be used to probe ids
  select d.uploaded_by, d.tenant_id into v_uploader, v_tenant from public.documents d where d.id = p_document_id;
  if v_uploader is null or v_uploader is distinct from v_user_id then
    raise exception 'document not found or not uploaded by you'
      using errcode = '42501';
  end if;
  if not private.is_tenant_member(v_tenant) then
    raise exception 'you are no longer a member of this tenant'
      using errcode = '42501';
  end if;

  -- lock the row so two completions can't both pass the status check
  select d.* into v_doc from public.documents d
  where d.id = p_document_id
  for update;

  -- again under the lock
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
