-- Fixes from the two adversarial reviews of the worker branch, each in a
-- section of its own, numbered as the review's items (docs/worker-design.md
-- and SECURITY.md have the whole design). 20260925000003 is left as it was
-- applied.

-- 3. One snapshot per ceiling check ------------------------------------------

-- As in 20260925000002, except that each ceiling reads the ledger and the
-- runs in flight in one statement. Under READ COMMITTED every statement takes
-- its own snapshot: the tenant's ledger sum and its in-flight sum used to be
-- two statements, so a finish (or a reap) committing between them, which
-- writes the run's ledger row and ends the run in one transaction, was seen
-- in neither: not yet in the ledger, no longer in flight. One statement sees
-- that transaction entirely or not at all, so the run is counted exactly
-- once, at its estimate or at its charge. The advisory lock still orders the
-- checks themselves.
create or replace function private.check_extraction_limits(p_tenant_id uuid, p_reaped_run_id uuid)
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
            and s.created_at >= v_month_start
            and s.run_id is distinct from p_reaped_run_id)
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
          where s.created_at >= v_month_start
            and s.run_id is distinct from p_reaped_run_id)
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

-- 5. The caller first, then the locks; a claim that skips a busy run ---------

-- As in 20260925000003, except that the caller is checked before any row is
-- locked: the document's organization is read without a lock, and a caller
-- who isn't one of its admins is refused there, with the same 42501 as a
-- missing document. Before, anyone signed in could take the key share of any
-- organization and a row lock on any document by naming its id, and hold
-- them while being refused. The check is made again under the lock, since
-- the document or the membership can change in between.
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

-- As in 20260925000003, with the caller checked before any lock, as in
-- enqueue_extraction_run above.
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

-- As in 20260925000003, except that the caller is checked before any lock:
-- the close token and the user who opened the run are read without locking,
-- and a wrong token or another user is refused there. Before, a caller with
-- any run id could lock that run's organization, document and run. The
-- token is checked again under the lock, since a reap or another close may
-- have deleted it in between.
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
  v_user_id   uuid := (select auth.uid());
  v_tenant_id uuid;
  v_starter   uuid;
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
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_status not in ('succeeded', 'failed') then
    raise exception 'status must be succeeded or failed' using errcode = '22023';
  end if;

  -- the caller, before any lock. One error for unknown id, wrong token and
  -- no token, so nothing is leaked.
  select r.tenant_id, r.started_by into v_tenant_id, v_starter from public.extraction_runs r where r.id = p_run_id;
  select t.token into v_token from private.extraction_run_tokens t where t.run_id = p_run_id;
  if v_token is null or v_token <> p_close_token then
    raise exception 'run not found or close token invalid' using errcode = '42501';
  end if;
  -- The token proves the caller was handed the run; the starter check is
  -- defense in depth for a token that leaks.
  if v_starter is distinct from v_user_id then
    raise exception 'only the user who opened the run can close it' using errcode = '42501';
  end if;

  -- the tenant, then the document, then the run (20260925000003)
  perform 1 from public.tenants t where t.id = v_tenant_id for key share;
  v_run := private.lock_extraction_run(p_run_id, false);

  -- again under the lock. The token row is deleted at close, so closing
  -- twice lands here too.
  select t.token into v_token from private.extraction_run_tokens t
  where t.run_id = p_run_id;
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

-- As in 20260925000003, except for how it picks a message. It reads the
-- visible messages, oldest first, without locking any, and for each takes
-- the run's document and the run first, as the lock order wants, with
-- NOWAIT, and only then reads that one message (pgmq.read of the message
-- whose body names the run), so the message is locked last. A run someone
-- else holds (a finish, a reap, the sweep, an enqueue of that document) is
-- skipped and the next message tried, up to 5 skipped per claim; before, the
-- first such message made the claim return nothing. Its message is not
-- touched, so it keeps its read_ct and vt. A message that is read and turns
-- out to be a second delivery, a run no longer queued, or a run whose
-- document is gone is ended and archived as before, and the next tried.
create or replace function public.claim_extraction_run()
returns table (run_id uuid, claim_token uuid, tenant_id uuid, document_id uuid,
               storage_path text, mime_type text, page_count integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_limits    public.extraction_limits;
  v_candidate record;
  v_msg       record;
  v_run       public.extraction_runs;
  v_doc       public.documents;
  v_token     uuid;
  v_skipped   bigint[] := '{}';
begin
  select l.* into v_limits from public.extraction_limits l;

  loop
    select q.msg_id, (q.message ->> 'run_id')::uuid as run_id into v_candidate
    from pgmq.q_extraction q
    where q.vt <= clock_timestamp()
      and q.msg_id <> all (v_skipped)
    order by q.msg_id
    limit 1;
    if not found then
      return;
    end if;

    begin
      v_run := private.lock_extraction_run(v_candidate.run_id, true);
      select m.msg_id, m.read_ct, m.message into v_msg
      from pgmq.read('extraction', v_limits.worker_visibility_seconds, 1,
                     jsonb_build_object('run_id', v_candidate.run_id)) m;
    exception when lock_not_available then
      -- the subtransaction's locks are released; the message is untouched
      v_skipped := v_skipped || v_candidate.msg_id;
      if cardinality(v_skipped) >= 5 then
        return;
      end if;
      continue;
    end;

    if v_msg.msg_id is null then
      -- gone, or read by someone else since the candidates were listed
      v_skipped := v_skipped || v_candidate.msg_id;
      if cardinality(v_skipped) >= 5 then
        return;
      end if;
      continue;
    end if;

    if v_msg.read_ct > 1 then
      if v_run.id is not null then
        perform private.reap_extraction_run(v_run.id,
          format('delivered a second time %s seconds after its claim; never processed twice',
                 v_limits.worker_visibility_seconds));
      end if;
      perform pgmq.archive('extraction', v_msg.msg_id);
      continue;
    end if;

    if v_run.id is null or v_run.status <> 'queued' then
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
