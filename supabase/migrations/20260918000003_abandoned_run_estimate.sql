-- A run the stale-run reaper abandons now carries an estimated cost instead
-- of none, derived from the document's page count.
--
-- open_extraction_run fails a run still 'running' after stale_run_minutes
-- (its server died, or the host killed the request). Until now it recorded
-- cost_usd null. The dead server may well have called a model and paid for
-- it, and the spend ceilings sum cost_usd, so every abandoned run was free
-- as far as the budget knew.
--
-- The charge is an estimate of the most that run could have consumed:
--
--   pages     the count the Extract action sent with open_extraction_run
--             (stored on the run as page_count), clamped to 1 ..
--             max_pages_per_document; unknown counts as the maximum
--   in/call   min(prompt_input_tokens + pages * input_tokens_per_page,
--                 max_input_tokens_per_call)
--   input     max_calls_per_run * in/call, then the per-run clamp
--   output    max_calls_per_run * max_output_tokens_per_call, ditto
--   cost      at abandoned_run_price_model's price (Claude Haiku 4.5, the
--             dearest model the app asks for), rounded to 8 places like
--             close_extraction_run
--
-- max_calls_per_run (3) and max_output_tokens_per_call (2048) are what the
-- orchestrator enforces. 4 500 prompt tokens and 3 000 per page leave margin
-- over the recorded eval runs (Haiku: about 5 900 for a one-page document,
-- about 1 850 per further page). 100 pages is Anthropic's per-request PDF
-- limit. One page: 0.05322 USD, 5 % of the tenant ceiling; 100 pages or an
-- unknown count: 0.63072 USD. SECURITY.md, "Stale runs", has the derivation.
--
-- The page count is supplied by the caller, like the token counts at close:
-- any admin can open a run over the API with a false count. It is clamped,
-- and it only changes what an abandoned run is charged.
--
-- The run is marked estimated the way the Extract action marks its own
-- estimates ("cost estimated at ... (...): "), so the app shows it as an
-- estimate and classifyRunError still reads "abandoned". Tokens, provider
-- and model stay null: they are unknown.
--
-- The run just reaped is left out of the same open's ceiling sums and
-- counts from the next open on. A refusal raises, and a raise would roll
-- back the reap with it, leaving the document stuck in processing.
--
-- Shipped additively (SECURITY.md, "Deploying schema changes"): the new
-- open_extraction_run(p_document_id, p_page_count) is added alongside, and
-- the old open_extraction_run(p_document_id) becomes a wrapper that calls
-- it with a null page count, so app code deployed before this migration
-- keeps working until the new code is out. The new function's p_page_count
-- has no default on purpose: with one, a call naming only p_document_id
-- would match both functions and PostgREST would refuse it as ambiguous.
-- A later migration drops the wrapper once the deployed app calls the new
-- signature.
--
-- extraction_limits gains the estimate's parameters, mirrored in
-- src/lib/extraction/config.ts and checked by tests/extraction.test.ts.

alter table public.extraction_limits
  add column max_calls_per_run          integer not null default 3      check (max_calls_per_run between 1 and 4),
  add column max_output_tokens_per_call integer not null default 2048   check (max_output_tokens_per_call >= 0),
  add column max_input_tokens_per_call  integer not null default 200000 check (max_input_tokens_per_call >= 0),
  add column prompt_input_tokens        integer not null default 4500   check (prompt_input_tokens >= 0),
  add column input_tokens_per_page      integer not null default 3000   check (input_tokens_per_page >= 0),
  add column max_pages_per_document     integer not null default 100    check (max_pages_per_document >= 1),
  add column abandoned_run_price_model  text    not null default 'claude-haiku-4-5-20251001'
    references public.extraction_model_prices (model);

-- the page count the run was opened with, as the caller reported it and
-- clamped; null when none was sent
alter table public.extraction_runs
  add column page_count integer check (page_count >= 1);

create function public.open_extraction_run(p_document_id uuid, p_page_count integer)
returns table (run_id uuid, close_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id      uuid := (select auth.uid());
  v_doc          public.documents;
  v_limits       public.extraction_limits;
  v_month_start  timestamptz := date_trunc('month', now(), 'UTC');
  v_tenant_spend numeric;
  v_global_spend numeric;
  v_recent_runs  integer;
  v_run_id       uuid;
  v_token        uuid := gen_random_uuid();
  v_previous     public.document_status;
  v_stale_id     uuid;
  v_stale_pages  integer;
  v_pages        integer;
  v_price        public.extraction_model_prices;
  v_in_per_call  numeric;
  v_in           numeric;
  v_out          numeric;
  v_estimate     numeric(12, 8);
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- lock the document so two opens for it are ordered
  select d.* into v_doc from public.documents d
  where d.id = p_document_id
  for update;

  -- one error for missing and not-admin, so the RPC can't be used to probe ids
  if not found or not private.is_tenant_admin(v_doc.tenant_id) then
    raise exception 'document not found or you are not an admin of its organization'
      using errcode = '42501';
  end if;

  if v_doc.status = 'uploading' then
    raise exception 'the document has no file yet' using errcode = '55000';
  end if;

  select l.* into v_limits from public.extraction_limits l;

  -- A run whose server died never closes. Fail any run for this document
  -- that has been 'running' longer than stale_run_minutes, put the document
  -- back where that run found it, and drop its close token so a late close
  -- is refused. Its real usage is unknown: the server may have called a
  -- model and paid for it. So it is charged an estimate of the most it could
  -- have consumed (20260918000003): at most max_calls_per_run calls, each the
  -- prompt plus every page of the document (the count the run was opened
  -- with, or max_pages_per_document if none), capped at max_input_tokens_per_call
  -- in and max_output_tokens_per_call out, at abandoned_run_price_model's
  -- price, rounded like close_extraction_run.
  -- (at most one run per document is ever 'running': open refuses while the
  -- document is 'processing')
  select r.id, r.previous_document_status, r.page_count into v_stale_id, v_previous, v_stale_pages
  from public.extraction_runs r
  where r.document_id = v_doc.id
    and r.status = 'running'
    and r.started_at < now() - make_interval(mins => v_limits.stale_run_minutes)
  order by r.started_at
  limit 1;

  if found then
    v_pages := least(greatest(coalesce(v_stale_pages, v_limits.max_pages_per_document), 1), v_limits.max_pages_per_document);
    v_in_per_call := least(v_limits.prompt_input_tokens + v_pages * v_limits.input_tokens_per_page,
                           v_limits.max_input_tokens_per_call);
    v_in  := least(v_limits.max_calls_per_run * v_in_per_call, v_limits.max_input_tokens_per_run);
    v_out := least(v_limits.max_calls_per_run * v_limits.max_output_tokens_per_call, v_limits.max_output_tokens_per_run);
    select p.* into v_price from public.extraction_model_prices p where p.model = v_limits.abandoned_run_price_model;
    v_estimate := round((v_in * v_price.input_usd_per_million + v_out * v_price.output_usd_per_million) / 1000000, 8);

    update public.extraction_runs
    set status      = 'failed',
        -- marked estimated the way the Extract action marks its estimates
        -- (RUN_ERROR_MARKERS.costEstimated); classifyRunError reads past it
        error       = format('cost estimated at %s prices (abandoned; at most %s calls of %s tokens in and %s out, '
                             'for %s): abandoned: still running after %s minutes; failed by a later open',
                             v_limits.abandoned_run_price_model, v_limits.max_calls_per_run, v_in_per_call,
                             v_limits.max_output_tokens_per_call,
                             case when v_stale_pages is null then format('an unknown page count, charged as %s', v_pages)
                                  when v_pages = 1 then '1 page'
                                  else format('%s pages', v_pages) end,
                             v_limits.stale_run_minutes),
        cost_usd    = v_estimate,
        finished_at = now()
    where id = v_stale_id;
    delete from private.extraction_run_tokens t where t.run_id = v_stale_id;
    update public.documents set status = v_previous where id = v_doc.id
    returning * into v_doc;
  end if;

  if v_doc.status = 'processing' then
    raise exception 'an extraction is already running for this document'
      using errcode = '55000';
  end if;

  -- one open at a time, project wide, so the sums below are consistent
  perform pg_advisory_xact_lock(hashtext('public.extraction_runs'));

  -- The run reaped above is left out of this open's sums, and counts from
  -- the next open on. Counting it here could refuse this open, and a
  -- refusal raises, which would roll the reap back with it: the stale run
  -- would stay running and the document stuck in processing for good.
  select coalesce(sum(r.cost_usd), 0) into v_tenant_spend
  from public.extraction_runs r
  where r.tenant_id = v_doc.tenant_id
    and r.started_at >= v_month_start
    and r.id is distinct from v_stale_id;

  if v_tenant_spend >= v_limits.tenant_monthly_ceiling_usd then
    raise exception 'this organization has reached its monthly extraction spend ceiling (% USD)',
      v_limits.tenant_monthly_ceiling_usd
      using errcode = '53400';
  end if;

  select coalesce(sum(r.cost_usd), 0) into v_global_spend
  from public.extraction_runs r
  where r.started_at >= v_month_start
    and r.id is distinct from v_stale_id;

  if v_global_spend >= v_limits.global_monthly_ceiling_usd then
    raise exception 'the monthly extraction spend ceiling across all organizations has been reached (% USD)',
      v_limits.global_monthly_ceiling_usd
      using errcode = '53400';
  end if;

  select count(*) into v_recent_runs
  from public.extraction_runs r
  where r.tenant_id = v_doc.tenant_id
    and r.started_at > now() - interval '1 hour';

  if v_recent_runs >= v_limits.hourly_run_limit then
    raise exception 'this organization has reached its limit of % extraction runs per hour',
      v_limits.hourly_run_limit
      using errcode = '54000';
  end if;

  -- the page count is the caller's, trusted like the token counts at
  -- close and clamped the same way (SECURITY.md, "Stale runs"); null stays
  -- null, unknown, which the reaper charges as max_pages_per_document
  -- (greatest() would turn a null into 1)
  insert into public.extraction_runs (tenant_id, document_id, started_by, previous_document_status, page_count)
  values (v_doc.tenant_id, v_doc.id, v_user_id, v_doc.status,
          case when p_page_count is null then null
               else least(greatest(p_page_count, 1), v_limits.max_pages_per_document) end)
  returning id into v_run_id;

  insert into private.extraction_run_tokens (run_id, token) values (v_run_id, v_token);

  update public.documents set status = 'processing' where id = v_doc.id;

  return query select v_run_id, v_token;
end;
$$;

revoke execute on function public.open_extraction_run(uuid, integer) from public, anon;
grant  execute on function public.open_extraction_run(uuid, integer) to authenticated;

-- The old signature, now a wrapper: the same checks and the same run, with
-- no page count (an abandoned run is then charged as max_pages_per_document).
-- Security invoker, so it adds no privilege; the function it calls does
-- every check. Replaced in place, so it keeps its grants and is never
-- missing. To be dropped once the deployed app sends p_page_count.
create or replace function public.open_extraction_run(p_document_id uuid)
returns table (run_id uuid, close_token uuid)
language sql security invoker set search_path = '' as $$
  select o.run_id, o.close_token from public.open_extraction_run(p_document_id, null::integer) o;
$$;

revoke execute on function public.open_extraction_run(uuid) from public, anon;
grant  execute on function public.open_extraction_run(uuid) to authenticated;
