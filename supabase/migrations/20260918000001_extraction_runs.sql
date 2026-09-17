-- LLM extraction harness, database side: every model call is bracketed by
-- two RPCs so that spend is checked before the call and recorded after it.
--
--   1. open_extraction_run(document_id)  -> one transaction: checks this
--      month's spend for the tenant and for everyone, and the tenant's runs
--      in the last hour, against public.extraction_limits; inserts a run in
--      'running'; moves the document to 'processing'; returns the run id and
--      a close token that only the server ever holds.
--   2. the server calls the model (outside the database)
--   3. close_extraction_run(run_id, token, ...) -> one transaction: records
--      real token counts, latency and status, computes the cost itself from
--      public.extraction_model_prices; on success replaces the document's
--      extracted fields and sets it to 'extracted' or 'needs_review'; on
--      failure puts the document back exactly as it was.
--
-- No client writes anything in these tables directly: runs and fields are
-- readable by tenant members and written only by the two RPCs. The caller
-- never supplies a cost: any admin can call these RPCs over PostgREST, so
-- the cost is derived in the database from token counts clamped to a
-- per-run maximum.

-- Limits ------------------------------------------------------------------

-- One row. The RPC reads these, so they are enforced where the spend is
-- recorded. src/lib/extraction/config.ts mirrors the same numbers for the
-- app and a test asserts the two agree.
create table public.extraction_limits (
  singleton                  boolean primary key default true check (singleton),
  tenant_monthly_ceiling_usd numeric(12, 6) not null check (tenant_monthly_ceiling_usd >= 0),
  global_monthly_ceiling_usd numeric(12, 6) not null check (global_monthly_ceiling_usd >= 0),
  hourly_run_limit           integer        not null check (hourly_run_limit >= 0),
  -- Token counts reported at close are clamped to these, so one forged run
  -- can't record an absurd cost. A run makes at most four calls; Haiku 4.5
  -- takes at most 200k input tokens per call, and the app caps output at
  -- 2048 per call.
  max_input_tokens_per_run   integer        not null check (max_input_tokens_per_run  >= 0),
  max_output_tokens_per_run  integer        not null check (max_output_tokens_per_run >= 0),
  -- a run still 'running' after this long is failed by the next open for
  -- its document, and the document is released
  stale_run_minutes          integer        not null check (stale_run_minutes > 0)
);

insert into public.extraction_limits
  (tenant_monthly_ceiling_usd, global_monthly_ceiling_usd, hourly_run_limit,
   max_input_tokens_per_run, max_output_tokens_per_run, stale_run_minutes)
values (1.00, 3.00, 5, 800000, 8192, 10);

alter table public.extraction_limits enable row level security;

create policy extraction_limits_select_authenticated on public.extraction_limits
  for select to authenticated using (true);

grant select on public.extraction_limits to authenticated;

-- Prices ------------------------------------------------------------------

-- USD per million tokens, standard tier, no caching or batch discounts, as
-- read from each provider's own pricing page on checked_on. close uses this
-- to compute every run's cost; a model with no row here can't be recorded.
-- src/lib/extraction/config.ts mirrors this table and a test asserts they
-- agree. Update the date whenever a row changes.
create table public.extraction_model_prices (
  model                  text primary key check (length(model) between 1 and 100),
  provider               text not null check (provider in ('anthropic', 'openai')),
  input_usd_per_million  numeric(12, 6) not null check (input_usd_per_million  >= 0),
  output_usd_per_million numeric(12, 6) not null check (output_usd_per_million >= 0),
  checked_on             date not null,
  source                 text not null
);

insert into public.extraction_model_prices
  (model, provider, input_usd_per_million, output_usd_per_million, checked_on, source)
values
  ('claude-haiku-4-5-20251001', 'anthropic', 1.00, 5.00, '2026-09-18',
   'https://platform.claude.com/docs/en/about-claude/models/overview'),
  ('claude-sonnet-5',           'anthropic', 2.00, 10.00, '2026-09-18',
   'https://platform.claude.com/docs/en/about-claude/models/overview'),
  ('gpt-5-nano',                'openai',    0.05, 0.40, '2026-09-18',
   'https://developers.openai.com/api/docs/pricing'),
  ('gpt-5-mini',                'openai',    0.25, 2.00, '2026-09-18',
   'https://developers.openai.com/api/docs/pricing');

alter table public.extraction_model_prices enable row level security;

create policy extraction_model_prices_select_authenticated on public.extraction_model_prices
  for select to authenticated using (true);

grant select on public.extraction_model_prices to authenticated;

-- Providers report the snapshot they served, for example
-- gpt-5-nano-2025-08-07 for gpt-5-nano. Exact match first, then the longest
-- priced id the reported id extends with a '-' suffix. Null when unknown.
create or replace function private.extraction_price_for_model(p_model text)
returns public.extraction_model_prices language sql stable security definer set search_path = '' as $$
  select p.* from public.extraction_model_prices p
  where p.model = p_model or p_model like p.model || '-%'
  order by (p.model = p_model) desc, length(p.model) desc
  limit 1;
$$;

revoke execute on function private.extraction_price_for_model(text) from public, anon, authenticated;

-- Runs --------------------------------------------------------------------

create type public.extraction_run_status as enum ('running', 'succeeded', 'failed');
create type public.confidence_band       as enum ('high', 'medium', 'low');

create table public.extraction_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  -- set null, not cascade: deleting a document must not erase its spend
  document_id   uuid references public.documents (id) on delete set null,
  started_by    uuid default auth.uid() references auth.users (id) on delete set null,
  status        public.extraction_run_status not null default 'running',
  -- which provider and model actually answered; known only at close
  provider      text check (provider in ('anthropic', 'openai')),
  model         text check (length(model) between 1 and 100),
  -- model calls made, across the retry and the fallback provider
  attempts      integer not null default 0 check (attempts between 0 and 4),
  input_tokens  integer check (input_tokens  >= 0),
  output_tokens integer check (output_tokens >= 0),
  cost_usd      numeric(12, 8) check (cost_usd >= 0),
  latency_ms    integer check (latency_ms >= 0),
  error         text check (length(error) <= 2000),
  -- the model's last answer, kept only when the run failed validation
  raw_response  text check (length(raw_response) <= 100000),
  -- restored on failure so a failed run leaves the document as it was
  previous_document_status public.document_status not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  constraint extraction_runs_finished_when_closed
    check ((status = 'running') = (finished_at is null)),
  constraint extraction_runs_closed_have_usage
    check (status = 'running' or (
      provider is not null and model is not null
      and input_tokens is not null and output_tokens is not null
      and cost_usd is not null and latency_ms is not null
    ) or (status = 'failed' and error is not null))
);

create index extraction_runs_tenant_started_idx on public.extraction_runs (tenant_id, started_at desc);
create index extraction_runs_started_idx        on public.extraction_runs (started_at);
create index extraction_runs_document_idx       on public.extraction_runs (document_id);

alter table public.extraction_runs enable row level security;

create policy extraction_runs_select_member on public.extraction_runs
  for select to authenticated
  using (private.is_tenant_member(tenant_id));

-- read only; no insert, update or delete grant or policy for any API role
grant select on public.extraction_runs to authenticated;

-- The close token: returned once by open_extraction_run to the caller, and
-- never readable afterwards. A tenant member can see a run's id but can't
-- close it out from under the server without the token.
create table private.extraction_run_tokens (
  run_id uuid primary key references public.extraction_runs (id) on delete cascade,
  token  uuid not null
);

alter table private.extraction_run_tokens enable row level security;
-- no grants: only the definer functions below (running as postgres) touch it

-- Fields ------------------------------------------------------------------

create table public.extracted_fields (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  document_id         uuid not null references public.documents (id) on delete cascade,
  run_id              uuid not null references public.extraction_runs (id) on delete cascade,
  name                text not null check (name ~ '^[a-z][a-z0-9_]{0,63}$'),
  value               text check (length(value) <= 4000),
  confidence          numeric(4, 3) not null check (confidence between 0 and 1),
  band                public.confidence_band not null,
  source_text         text check (length(source_text) <= 4000),
  clarifying_question text check (length(clarifying_question) <= 1000),
  created_at          timestamptz not null default now(),
  -- one value per field per document: a new run replaces the old set
  unique (document_id, name)
);

create index extracted_fields_tenant_idx on public.extracted_fields (tenant_id);
create index extracted_fields_run_idx    on public.extracted_fields (run_id);

alter table public.extracted_fields enable row level security;

create policy extracted_fields_select_member on public.extracted_fields
  for select to authenticated
  using (private.is_tenant_member(tenant_id));

grant select on public.extracted_fields to authenticated;

-- Open --------------------------------------------------------------------

-- Admin only. Serialises every open with an advisory lock so two concurrent
-- opens can't both pass the same limit check. Raises and inserts nothing
-- when a limit is hit, so a refused run never counts as a run.
--
--   53400 configuration_limit_exceeded  a monthly spend ceiling is reached
--   54000 program_limit_exceeded        the tenant's hourly run limit is reached
create or replace function public.open_extraction_run(p_document_id uuid)
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
  -- is refused. Its cost is unknown and recorded as null.
  -- (at most one run per document is ever 'running': open refuses while the
  -- document is 'processing')
  select r.id, r.previous_document_status into v_stale_id, v_previous
  from public.extraction_runs r
  where r.document_id = v_doc.id
    and r.status = 'running'
    and r.started_at < now() - make_interval(mins => v_limits.stale_run_minutes)
  order by r.started_at
  limit 1;

  if found then
    update public.extraction_runs
    set status      = 'failed',
        error       = format('abandoned: still running after %s minutes; failed by a later open',
                             v_limits.stale_run_minutes),
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

  select coalesce(sum(r.cost_usd), 0) into v_tenant_spend
  from public.extraction_runs r
  where r.tenant_id = v_doc.tenant_id
    and r.started_at >= v_month_start;

  if v_tenant_spend >= v_limits.tenant_monthly_ceiling_usd then
    raise exception 'this organization has reached its monthly extraction spend ceiling (% USD)',
      v_limits.tenant_monthly_ceiling_usd
      using errcode = '53400';
  end if;

  select coalesce(sum(r.cost_usd), 0) into v_global_spend
  from public.extraction_runs r
  where r.started_at >= v_month_start;

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

  insert into public.extraction_runs (tenant_id, document_id, started_by, previous_document_status)
  values (v_doc.tenant_id, v_doc.id, v_user_id, v_doc.status)
  returning id into v_run_id;

  insert into private.extraction_run_tokens (run_id, token) values (v_run_id, v_token);

  update public.documents set status = 'processing' where id = v_doc.id;

  return query select v_run_id, v_token;
end;
$$;

revoke execute on function public.open_extraction_run(uuid) from public, anon;
grant  execute on function public.open_extraction_run(uuid) to authenticated;

-- Close -------------------------------------------------------------------

-- Records the outcome and, in the same transaction, either replaces the
-- document's fields and advances its status, or restores the status the
-- document had before the run. p_fields is a JSON array of
--   {name, value, confidence, band, source_text, clarifying_question}
-- and is only accepted with p_status = 'succeeded'. The document goes to
-- 'needs_review' if any field is 'low', otherwise 'extracted'.
--
-- The cost is never supplied. It is computed here from the token counts,
-- clamped to extraction_limits.max_*_tokens_per_run, at the price on file
-- for p_model. A run that made no call (p_model null) records no usage.
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
  v_limits   public.extraction_limits;
  v_price    public.extraction_model_prices;
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
    v_price := private.extraction_price_for_model(p_model);
    if v_price.model is null then
      raise exception 'no price on file for model %', p_model using errcode = '22023';
    end if;
    if p_provider is distinct from v_price.provider then
      raise exception 'model % belongs to provider %', p_model, v_price.provider using errcode = '22023';
    end if;
    select l.* into v_limits from public.extraction_limits l;
    v_in   := least(greatest(coalesce(p_input_tokens, 0), 0),  v_limits.max_input_tokens_per_run);
    v_out  := least(greatest(coalesce(p_output_tokens, 0), 0), v_limits.max_output_tokens_per_run);
    v_cost := round(
      (v_in * v_price.input_usd_per_million + v_out * v_price.output_usd_per_million) / 1000000,
      8);
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

  delete from private.extraction_run_tokens where run_id = p_run_id;

  return v_run;
end;
$$;

revoke execute on function public.close_extraction_run(
  uuid, uuid, text, text, text, integer, integer, integer, integer, text, text, jsonb
) from public, anon;
grant  execute on function public.close_extraction_run(
  uuid, uuid, text, text, text, integer, integer, integer, integer, text, text, jsonb
) to authenticated;
