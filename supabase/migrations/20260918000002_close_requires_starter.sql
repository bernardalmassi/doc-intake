-- close_extraction_run must be called by the user who opened the run. The
-- close token already proves the caller was handed the run by open (the
-- browser never sees it); this adds a second check so a leaked token alone
-- is not enough. Found by the extraction test suite: a member given the
-- token could close another user's run. The function is otherwise the one
-- from 20260918000001.

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

  -- The token proves the caller was handed the run; the starter check is
  -- defense in depth for a token that leaks. The queue worker will replace
  -- this with its own identity.
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

