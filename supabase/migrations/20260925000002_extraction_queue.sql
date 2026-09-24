-- The extraction queue (docs/worker-design.md). Extract no longer runs a
-- model inside the user's request: it enqueues the run, and a worker holding
-- the project's secret key claims it, calls the model and finishes it.
--
--   enqueue_extraction_run  as the user: every refusal open_extraction_run
--                           has, then the run as 'queued', a pgmq message
--                           and a wake for the worker (pg_net, sent only if
--                           the enqueue commits)
--   claim_extraction_run    as the worker: reads one message and claims its
--                           run in the same transaction, so read_ct = 1
--                           always means "claimed"; a second read of the
--                           same message is priced as abandoned, never run
--   finish_extraction_run   as the worker: close_extraction_run's rules,
--                           with the claim token, and the message archived
--   sweep_extraction_queue  every minute (pg_cron): gives every run still
--                           queued or running a deadline
--
-- Spend moves to a ledger, private.extraction_spend: one append-only row per
-- terminal run, which no API role can read or write. The ceilings sum the
-- ledger plus an estimate for every run still in flight
-- (private.check_extraction_limits), so concurrent runs can overshoot a
-- ceiling by at most one run's estimate, not one run each.
--
-- Shipped additively (SECURITY.md, "Deploying schema changes"):
-- open_extraction_run and close_extraction_run keep their signatures and
-- grants, and are replaced in place so the deployed app stays metered by the
-- ledger and the in-flight rule. A later migration drops both once no
-- deployment calls them.
--
-- This migration refuses to run while an extraction is in progress: apply it
-- when nothing is extracting.

-- 1. Extensions and the queue ---------------------------------------------

create extension if not exists pgmq;
select pgmq.create('extraction');
create extension if not exists pg_net with schema extensions;

-- Only postgres and the definer functions below touch the queue. The pgmq
-- schema, its functions and the queue's tables are postgres's, so these
-- revokes take effect. Queues -> "Expose Queues via PostgREST" stays off: it
-- would create the exposed pgmq_public schema.
revoke usage on schema pgmq from public, anon, authenticated;
revoke execute on all functions in schema pgmq from public, anon, authenticated;
revoke all on pgmq.q_extraction, pgmq.a_extraction from public, anon, authenticated, service_role;
alter table pgmq.q_extraction enable row level security;
alter table pgmq.a_extraction enable row level security;

-- pg_net's schema, functions and request table belong to supabase_admin,
-- which grants them to PUBLIC, anon, authenticated and service_role. postgres
-- holds no grant option on them, so a revoke here would be a no-op (it only
-- warns); checked on the test project. They stay as Supabase installs them.
-- The API can't reach them anyway: net is not an exposed schema.

-- 2. Runs: the queued state, the claim, one open run per document ----------

alter table public.extraction_runs
  add column queue_msg_id bigint,
  add column claimed_at   timestamptz;

alter table public.extraction_runs
  drop constraint extraction_runs_finished_when_closed,
  add constraint extraction_runs_finished_when_closed
    check ((status in ('queued', 'running')) = (finished_at is null)),
  drop constraint extraction_runs_closed_have_usage,
  add constraint extraction_runs_closed_have_usage
    check (status in ('queued', 'running') or (
      provider is not null and model is not null
      and input_tokens is not null and output_tokens is not null
      and cost_usd is not null and latency_ms is not null
    ) or (status = 'failed' and error is not null));

create unique index extraction_runs_one_open_per_document
  on public.extraction_runs (document_id) where status in ('queued', 'running');
-- the in-flight sums in check_extraction_limits
create index extraction_runs_in_flight_idx
  on public.extraction_runs (tenant_id) where status in ('queued', 'running');

-- 3. Limits ---------------------------------------------------------------

-- How long a claimed message stays invisible: longer than the worker route's
-- maxDuration (240 s), so no second delivery can start while the first
-- worker may still be running, and no longer than stale_run_minutes.
-- Mirrored in src/lib/extraction/config.ts (workerVisibilitySeconds).
alter table public.extraction_limits
  add column worker_visibility_seconds integer not null default 300 check (worker_visibility_seconds > 0);

-- 4. The spend ledger -------------------------------------------------------

-- One row per terminal run, written in the transaction that ends it:
--   charge     finished or closed at its recorded usage
--   estimate   finished or closed at the dearest price on file, because its
--              own model had no price
--   abandoned  failed while running, charged the page-count estimate
--   expired    never claimed, cancelled at no cost
--   backfill   a run that ended before this migration
-- No foreign keys: a deleted organization's, run's or user's spend still
-- counts toward the global ceiling for the rest of the month. RLS on and no
-- policies or grants: the one deliberate exception to "every table gets
-- member policies", since no API role may read or write it.
create table private.extraction_spend (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  kind          text not null check (kind in ('charge', 'estimate', 'abandoned', 'expired', 'backfill')),
  tenant_id     uuid not null,
  user_id       uuid,
  run_id        uuid not null unique,
  provider      text check (provider in ('anthropic', 'openai')),
  model         text check (length(model) between 1 and 100),
  input_tokens  integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  cost_usd      numeric(12, 8) not null check (cost_usd >= 0)
);

create index extraction_spend_created_idx        on private.extraction_spend (created_at);
create index extraction_spend_tenant_created_idx on private.extraction_spend (tenant_id, created_at);

alter table private.extraction_spend enable row level security;
revoke all on private.extraction_spend from public, anon, authenticated, service_role;

-- Append-only, for postgres too: only the owner, disabling the triggers in a
-- reviewed migration, can change a row.
create function private.refuse_spend_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'extraction spend is append-only' using errcode = '42501';
end;
$$;

create trigger extraction_spend_append_only
  before update or delete on private.extraction_spend
  for each row execute function private.refuse_spend_change();
create trigger extraction_spend_no_truncate
  before truncate on private.extraction_spend
  for each statement execute function private.refuse_spend_change();

-- 5. Shared rules -----------------------------------------------------------

-- What a run is charged for its token counts: close_extraction_run's rule,
-- lifted out. Clamped to the per-run maximums, at the price on file for the
-- model (exact id or longest prefix), rounded to 8 places.
create function private.extraction_charge(p_model text, p_provider text, p_input_tokens integer, p_output_tokens integer)
returns table (input_tokens integer, output_tokens integer, cost_usd numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_price  public.extraction_model_prices;
  v_limits public.extraction_limits;
  v_in     integer;
  v_out    integer;
begin
  v_price := private.extraction_price_for_model(p_model);
  if v_price.model is null then
    raise exception 'no price on file for model %', p_model using errcode = '22023';
  end if;
  if p_provider is distinct from v_price.provider then
    raise exception 'model % belongs to provider %', p_model, v_price.provider using errcode = '22023';
  end if;
  select l.* into v_limits from public.extraction_limits l;
  v_in  := least(greatest(coalesce(p_input_tokens, 0), 0),  v_limits.max_input_tokens_per_run);
  v_out := least(greatest(coalesce(p_output_tokens, 0), 0), v_limits.max_output_tokens_per_run);
  return query select v_in, v_out,
    round((v_in * v_price.input_usd_per_million + v_out * v_price.output_usd_per_million) / 1000000, 8);
end;
$$;

-- The most a run of p_page_count pages can cost (20260918000003, SECURITY.md
-- "Stale runs"): max_calls_per_run calls, each the prompt plus every page
-- (an unknown count as max_pages_per_document) up to max_input_tokens_per_call
-- in and max_output_tokens_per_call out, at abandoned_run_price_model's
-- price. What an abandoned run is charged, and what a run in flight holds
-- against the ceilings.
create function private.abandoned_estimate(p_page_count integer)
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
    least(v_limits.max_calls_per_run * v_per_call, v_limits.max_input_tokens_per_run),
    least(v_limits.max_calls_per_run * v_limits.max_output_tokens_per_call, v_limits.max_output_tokens_per_run)) c;
  return query select v_limits.abandoned_run_price_model, v_provider, v_pages, v_per_call,
    v_charge.input_tokens, v_charge.output_tokens, v_charge.cost_usd;
end;
$$;

-- The limits, checked before a run is inserted, by open_extraction_run and
-- enqueue_extraction_run alike so the two can't drift:
--   - the tenant's ledger this UTC month plus the estimate of each of its
--     runs in flight, at or above tenant_monthly_ceiling_usd: 53400
--   - the same across all tenants, at or above global_monthly_ceiling_usd:
--     53400
--   - the tenant's runs started in the last hour at hourly_run_limit: 54000
-- The new run's own estimate is not added, so a 100-page document can still
-- run on a fresh organization. p_reaped_run_id is a run the caller's reaper
-- ended in this transaction: its ledger row counts from the next check on,
-- because a refusal here raises and would roll the reap back with it.
create function private.check_extraction_limits(p_tenant_id uuid, p_reaped_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_limits      public.extraction_limits;
  v_month_start timestamptz := date_trunc('month', now(), 'UTC');
  v_spend       numeric;
  v_in_flight   numeric;
  v_recent_runs integer;
begin
  -- one check at a time, project wide, so the sums below are consistent
  perform pg_advisory_xact_lock(hashtext('public.extraction_runs'));

  select l.* into v_limits from public.extraction_limits l;

  select coalesce(sum(s.cost_usd), 0) into v_spend
  from private.extraction_spend s
  where s.tenant_id = p_tenant_id
    and s.created_at >= v_month_start
    and s.run_id is distinct from p_reaped_run_id;
  select coalesce(sum(e.cost_usd), 0) into v_in_flight
  from public.extraction_runs r
  cross join lateral private.abandoned_estimate(r.page_count) e
  where r.tenant_id = p_tenant_id
    and r.status in ('queued', 'running');

  if v_spend + v_in_flight >= v_limits.tenant_monthly_ceiling_usd then
    raise exception 'this organization has reached its monthly extraction spend ceiling (% USD), counting extractions in progress',
      v_limits.tenant_monthly_ceiling_usd
      using errcode = '53400';
  end if;

  select coalesce(sum(s.cost_usd), 0) into v_spend
  from private.extraction_spend s
  where s.created_at >= v_month_start
    and s.run_id is distinct from p_reaped_run_id;
  select coalesce(sum(e.cost_usd), 0) into v_in_flight
  from public.extraction_runs r
  cross join lateral private.abandoned_estimate(r.page_count) e
  where r.status in ('queued', 'running');

  if v_spend + v_in_flight >= v_limits.global_monthly_ceiling_usd then
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

-- 6. Ending a run nobody finished -------------------------------------------

-- Ends a run that is still queued or running, with p_reason as the
-- engineers' account of why:
--   running  it may have called a model, so it is failed at the page-count
--            estimate (abandoned_estimate), marked estimated the way
--            20260918000003 marks it, with an 'abandoned' ledger row
--   queued   no delivery claimed it, so no model was called: failed at 0
--            with an 'expired' ledger row
-- Either way its token goes (a late finish or close is refused), its
-- document goes back to where the run found it, and its message is
-- archived. A terminal run is left alone. Returns 'abandoned', 'expired' or
-- null.
create function private.reap_extraction_run(p_run_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_run    public.extraction_runs;
  v_limits public.extraction_limits;
  v_est    record;
begin
  select r.* into v_run from public.extraction_runs r
  where r.id = p_run_id
  for update;
  if not found or v_run.status not in ('queued', 'running') then
    return null;
  end if;

  if v_run.status = 'running' then
    select l.* into v_limits from public.extraction_limits l;
    select e.* into v_est from private.abandoned_estimate(v_run.page_count) e;
    update public.extraction_runs
    set status      = 'failed',
        -- RUN_ERROR_MARKERS.costEstimated, then RUN_ERROR_MARKERS.abandoned
        error       = format('cost estimated at %s prices (abandoned; at most %s calls of %s tokens in and %s out, '
                             'for %s): abandoned: %s',
                             v_est.model, v_limits.max_calls_per_run, v_est.input_per_call,
                             v_limits.max_output_tokens_per_call,
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

-- 7. Stale runs, then the ledger's backfill ---------------------------------

do $$
declare
  v_limits public.extraction_limits;
  v_run_id uuid;
begin
  -- Nothing may open, close or reap a run until this migration commits. In
  -- the DO block because db push runs the file as one implicit transaction,
  -- where a top-level LOCK TABLE is refused; the lock is held to the end.
  lock table public.extraction_runs in share row exclusive mode;

  select l.* into v_limits from public.extraction_limits l;
  -- runs the old reaper would fail at the next open of their document
  for v_run_id in
    select r.id from public.extraction_runs r
    where r.status = 'running'
      and r.started_at < now() - make_interval(mins => v_limits.stale_run_minutes)
  loop
    perform private.reap_extraction_run(v_run_id,
      format('still running after %s minutes when the extraction queue was added', v_limits.stale_run_minutes));
  end loop;

  if exists (select 1 from public.extraction_runs r where r.status in ('queued', 'running')) then
    raise exception 'an extraction is in progress; apply this migration when nothing is extracting'
      using errcode = '55000';
  end if;
end;
$$;

-- Every run that ended before now, dated when it started as the old sums
-- dated it, so the ledger's sums equal what the runs summed to. Runs reaped
-- just above already have their row.
insert into private.extraction_spend
  (created_at, kind, tenant_id, user_id, run_id, provider, model, input_tokens, output_tokens, cost_usd)
select r.started_at, 'backfill', r.tenant_id, r.started_by, r.id,
       r.provider, r.model, r.input_tokens, r.output_tokens, coalesce(r.cost_usd, 0)
from public.extraction_runs r
where r.status in ('succeeded', 'failed')
  and not exists (select 1 from private.extraction_spend s where s.run_id = r.id);

-- 8. The deployed app's RPCs, now metered by the ledger ---------------------

-- As in 20260918000003, except that the limits are check_extraction_limits
-- (ledger plus runs in flight), and the reaper ends a queued or running run
-- of this document through reap_extraction_run, measuring a claimed run from
-- its claim. A run it inserts is 'running' at once, with a close token, and
-- has no queue message.
create or replace function public.open_extraction_run(p_document_id uuid, p_page_count integer)
returns table (run_id uuid, close_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id  uuid := (select auth.uid());
  v_doc      public.documents;
  v_limits   public.extraction_limits;
  v_run_id   uuid;
  v_token    uuid := gen_random_uuid();
  v_stale_id uuid;
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

  perform private.check_extraction_limits(v_doc.tenant_id, v_stale_id);

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

-- As in 20260918000002, except that the cost comes from extraction_charge
-- and the run's ledger row is written in the same transaction: kind
-- 'estimate' when the error carries the cost-estimated marker
-- (failedCloseAttempts in src/lib/extraction/run.ts), 'charge' otherwise.
create or replace function public.close_extraction_run(
  p_run_id        uuid,
  p_close_token   uuid,
  p_status        text,
  p_provider      text,
  p_model         text,
  p_input_tokens  integer,
  p_output_tokens integer,
  p_latency_ms    integer,
  p_attempts      integer,
  p_error         text default null,
  p_raw_response  text default null,
  p_fields        jsonb default null
)
returns public.extraction_runs
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id  uuid := (select auth.uid());
  v_run      public.extraction_runs;
  v_token    uuid;
  v_field    jsonb;
  v_any_low  boolean := false;
  v_doc_id   uuid;
  v_charge   record;
  v_in       integer;
  v_out      integer;
  v_cost     numeric(12, 8);
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_status not in ('succeeded', 'failed') then
    raise exception 'status must be succeeded or failed' using errcode = '22023';
  end if;

  select r.* into v_run from public.extraction_runs r
  where r.id = p_run_id
  for update;

  select t.token into v_token from private.extraction_run_tokens t
  where t.run_id = p_run_id;

  -- one error for unknown id, wrong token and no token, so nothing is leaked.
  -- The token row is deleted at close, so closing twice lands here too.
  if not found or v_token is null or v_token <> p_close_token then
    raise exception 'run not found or close token invalid' using errcode = '42501';
  end if;

  -- The token proves the caller was handed the run; the starter check is
  -- defense in depth for a token that leaks.
  if v_run.started_by is distinct from v_user_id then
    raise exception 'only the user who opened the run can close it' using errcode = '42501';
  end if;

  -- unreachable while the token is deleted at close; kept as a guard
  if v_run.status <> 'running' then
    raise exception 'run is already closed' using errcode = '55000';
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
    v_in := null; v_out := null; v_cost := null;
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

  update public.extraction_runs
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
  where id = p_run_id
  returning * into v_run;

  insert into private.extraction_spend
    (kind, tenant_id, user_id, run_id, provider, model, input_tokens, output_tokens, cost_usd)
  values (case when starts_with(coalesce(p_error, ''), 'cost estimated at ') then 'estimate' else 'charge' end,
          v_run.tenant_id, v_run.started_by, v_run.id, p_provider, p_model, v_in, v_out, coalesce(v_cost, 0));

  delete from private.extraction_run_tokens where run_id = p_run_id;

  return v_run;
end;
$$;

-- 9. The queue's functions --------------------------------------------------

-- Wakes the worker: POST {} to extraction_worker_url with
-- "Authorization: Bearer <extraction_worker_secret>", both read from Vault by
-- name. Only the app project has the pair; without it, or with a URL that
-- isn't https://<host>/api/extraction-worker, it does nothing and returns
-- null, so an enqueue never fails on configuration. pg_net sends the request
-- only after the calling transaction commits, and the 5 s timeout bounds only
-- how long it waits for the route's immediate 202.
create function private.wake_extraction_worker()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'extraction_worker_url';
  select s.decrypted_secret into v_secret from vault.decrypted_secrets s where s.name = 'extraction_worker_secret';
  if v_url is null or v_secret is null or v_url !~ '^https://[^/]+/api/extraction-worker$' then
    return null;
  end if;
  return net.http_post(
    url                  := v_url,
    body                 := '{}'::jsonb,
    headers              := jsonb_build_object('Content-Type', 'application/json',
                                               'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 5000);
end;
$$;

-- The user's Extract: open_extraction_run's checks and limits, then the run
-- as 'queued', its message, and a wake. No token: nothing the caller gets
-- back can finish the run. A refusal raises, so nothing is inserted, queued
-- or sent.
create function public.enqueue_extraction_run(p_document_id uuid, p_page_count integer)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id  uuid := (select auth.uid());
  v_doc      public.documents;
  v_limits   public.extraction_limits;
  v_run_id   uuid;
  v_msg_id   bigint;
  v_stale_id uuid;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- lock the document so two enqueues for it are ordered
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

  perform private.check_extraction_limits(v_doc.tenant_id, v_stale_id);

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

-- The worker's claim, as service_role. Reads one message, hidden for
-- worker_visibility_seconds, and in the same transaction:
--   read before (read_ct > 1)  its run is ended as abandoned and the message
--                              archived, never processed a second time
--   run gone or not queued     the message is archived
--   document deleted           the run fails with no call at 0 USD
--   otherwise                  the run goes to 'running' with a fresh claim
--                              token, returned with what the worker needs
-- and tries the next message after any of the first three. No row: the
-- queue is empty.
create function public.claim_extraction_run()
returns table (run_id uuid, claim_token uuid, tenant_id uuid, document_id uuid,
               storage_path text, mime_type text, page_count integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_limits public.extraction_limits;
  v_msg    record;
  v_run    public.extraction_runs;
  v_doc    public.documents;
  v_token  uuid;
begin
  select l.* into v_limits from public.extraction_limits l;

  loop
    select m.msg_id, m.read_ct, m.message into v_msg
    from pgmq.read('extraction', v_limits.worker_visibility_seconds, 1) m;
    if not found then
      return;
    end if;

    select r.* into v_run from public.extraction_runs r
    where r.id = (v_msg.message ->> 'run_id')::uuid
    for update;

    if v_msg.read_ct > 1 then
      if found then
        perform private.reap_extraction_run(v_run.id,
          format('delivered a second time %s seconds after its claim; never processed twice',
                 v_limits.worker_visibility_seconds));
      end if;
      perform pgmq.archive('extraction', v_msg.msg_id);
      continue;
    end if;

    if not found or v_run.status <> 'queued' then
      perform pgmq.archive('extraction', v_msg.msg_id);
      continue;
    end if;

    if v_run.document_id is null then
      update public.extraction_runs r
      set status = 'failed', error = 'the document was deleted before the extraction started',
          cost_usd = 0, finished_at = now()
      where r.id = v_run.id;
      insert into private.extraction_spend (kind, tenant_id, user_id, run_id, cost_usd)
      values ('charge', v_run.tenant_id, v_run.started_by, v_run.id, 0);
      perform pgmq.archive('extraction', v_msg.msg_id);
      continue;
    end if;

    select d.* into v_doc from public.documents d where d.id = v_run.document_id;
    v_token := gen_random_uuid();
    update public.extraction_runs r set status = 'running', claimed_at = now() where r.id = v_run.id;
    insert into private.extraction_run_tokens (run_id, token) values (v_run.id, v_token);

    return query select v_run.id, v_token, v_run.tenant_id, v_run.document_id,
                        v_doc.storage_path, v_doc.mime_type, v_run.page_count;
    return;
  end loop;
end;
$$;

-- The worker's finish, as service_role: close_extraction_run's rules with
-- the claim token in place of the close token and the opener check, the
-- run's cost_usd kept as the display copy (0 for a run that called no
-- model), its ledger row (kind 'estimate' when p_cost_estimated), and its
-- message archived, all in one transaction.
create function public.finish_extraction_run(
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
  v_run      public.extraction_runs;
  v_token    uuid;
  v_field    jsonb;
  v_any_low  boolean := false;
  v_doc_id   uuid;
  v_charge   record;
  v_in       integer;
  v_out      integer;
  v_cost     numeric(12, 8);
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'status must be succeeded or failed' using errcode = '22023';
  end if;

  select r.* into v_run from public.extraction_runs r
  where r.id = p_run_id
  for update;

  select t.token into v_token from private.extraction_run_tokens t
  where t.run_id = p_run_id;

  -- the token row is deleted when the run ends, so finishing twice, or
  -- after a reap, lands here too
  if not found or v_token is null or v_token <> p_claim_token then
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

-- Every minute, from pg_cron as postgres. Gives every run still queued or
-- running a deadline, whether or not a worker or pg_net is alive, in this
-- order so it never wakes a worker for a run it has just ended:
--   (a) a claimed message past its visibility timeout: its worker is gone
--       (the route's maxDuration is shorter), so the run is abandoned at
--       the estimate and the message archived
--   (c) a run 'running' with no live message (opened by the old path, or
--       its message gone) for over stale_run_minutes: abandoned at the
--       estimate
--   (d) a run still 'queued' after stale_run_minutes: expired at 0
--   (b) a message never read, over 60 s old, whose run is younger than
--       stale_run_minutes: its wake never arrived, so wake again, at most 5
--       per tick
-- Rows another transaction holds (a claim or a finish in progress) are
-- skipped until the next tick.
create function private.sweep_extraction_queue()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_limits public.extraction_limits;
  v_msg    record;
  v_run_id uuid;
  v_wakes  integer;
begin
  select l.* into v_limits from public.extraction_limits l;

  -- (a)
  for v_msg in
    select q.msg_id, q.message from pgmq.q_extraction q
    where q.read_ct >= 1 and q.vt <= now()
    for update skip locked
  loop
    perform private.reap_extraction_run((v_msg.message ->> 'run_id')::uuid,
      format('claimed but not finished within %s seconds', v_limits.worker_visibility_seconds));
    perform pgmq.archive('extraction', v_msg.msg_id);
  end loop;

  -- (c)
  for v_run_id in
    select r.id from public.extraction_runs r
    where r.status = 'running'
      and coalesce(r.claimed_at, r.started_at) < now() - make_interval(mins => v_limits.stale_run_minutes)
      and not exists (select 1 from pgmq.q_extraction q where q.msg_id = r.queue_msg_id)
    for update skip locked
  loop
    perform private.reap_extraction_run(v_run_id,
      format('still running after %s minutes; failed by the sweep', v_limits.stale_run_minutes));
  end loop;

  -- (d)
  for v_run_id in
    select r.id from public.extraction_runs r
    where r.status = 'queued'
      and r.started_at < now() - make_interval(mins => v_limits.stale_run_minutes)
    for update skip locked
  loop
    perform private.reap_extraction_run(v_run_id,
      format('not claimed within %s minutes; cancelled at no cost', v_limits.stale_run_minutes));
  end loop;

  -- (b)
  select count(*) into v_wakes from (
    select 1 from pgmq.q_extraction q
    join public.extraction_runs r on r.id = (q.message ->> 'run_id')::uuid
    where q.read_ct = 0
      and q.vt <= now()
      and q.enqueued_at < now() - interval '60 seconds'
      and r.status = 'queued'
      and r.started_at >= now() - make_interval(mins => v_limits.stale_run_minutes)
    limit 5
  ) lost;
  for i in 1 .. v_wakes loop
    perform private.wake_extraction_worker();
  end loop;
end;
$$;

-- 10. No organization deleted with a run in flight --------------------------

-- As in 20260917000005, plus a refusal while any of the tenant's runs is
-- queued or running: deleting it would cascade the run and its token out
-- from under a worker mid-call, and its spend could no longer be recorded.
-- The tenant row is locked first, and an enqueue's insert holds a key share
-- lock on it, so a run enqueued concurrently is either seen here or refused
-- by the foreign key. Every run in flight has a deadline (the sweep), so
-- the refusal ends within about 11 minutes.
create or replace function public.delete_tenant(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_tenant_owner(p_tenant_id) then
    raise exception 'only an owner can delete a tenant'
      using errcode = '42501';
  end if;

  perform 1 from public.tenants t where t.id = p_tenant_id for update;

  if exists (
    select 1 from public.extraction_runs r
    where r.tenant_id = p_tenant_id and r.status in ('queued', 'running')
  ) then
    raise exception 'an extraction is in progress for this tenant'
      using errcode = '55000';
  end if;

  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'documents'
      and o.name like p_tenant_id::text || '/%'
  ) then
    raise exception 'remove the tenant''s files from storage before deleting it'
      using errcode = '55000';
  end if;

  delete from public.tenants where id = p_tenant_id;
end;
$$;

-- Grants --------------------------------------------------------------------

revoke execute on function private.refuse_spend_change() from public, anon, authenticated;
revoke execute on function private.extraction_charge(text, text, integer, integer) from public, anon, authenticated;
revoke execute on function private.abandoned_estimate(integer) from public, anon, authenticated;
revoke execute on function private.check_extraction_limits(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.reap_extraction_run(uuid, text) from public, anon, authenticated;
revoke execute on function private.wake_extraction_worker() from public, anon, authenticated;
revoke execute on function private.sweep_extraction_queue() from public, anon, authenticated;

-- the only user entry point
revoke execute on function public.enqueue_extraction_run(uuid, integer) from public, anon, service_role;
grant  execute on function public.enqueue_extraction_run(uuid, integer) to authenticated;

-- the worker's, through the secret key; in public only because PostgREST
-- exposes nothing else
revoke execute on function public.claim_extraction_run() from public, anon, authenticated;
grant  execute on function public.claim_extraction_run() to service_role;
revoke execute on function public.finish_extraction_run(
  uuid, uuid, text, text, text, integer, integer, integer, integer, boolean, text, text, jsonb
) from public, anon, authenticated;
grant  execute on function public.finish_extraction_run(
  uuid, uuid, text, text, text, integer, integer, integer, integer, boolean, text, text, jsonb
) to service_role;

-- 11. The sweep's schedule --------------------------------------------------

-- Last: the schedule starts calling the sweep at once, so it has to exist.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

select cron.schedule('extraction-sweep', '* * * * *', 'select private.sweep_extraction_queue()');
select cron.schedule('extraction-cron-history-purge', '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
