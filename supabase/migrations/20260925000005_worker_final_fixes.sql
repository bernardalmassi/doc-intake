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
