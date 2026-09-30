-- One lock order for the extraction queue (docs/worker-design.md, section
-- 15). 20260925000002 took the queue message and a run row in opposite
-- orders: the sweep locked a message and then waited for its run, while a
-- finish held the run and then waited to archive the message, and a claim
-- whose pgmq.read had locked an expired message waited for a run that a
-- finish held. PostgreSQL broke each cycle by aborting one side; when it
-- aborted the finish, the sweep or the claim then reaped the run, so a paid
-- result was thrown away and charged as abandoned.
--
-- From here on every function takes these, when it takes them, in this
-- order:
--
--   1. the tenant row      key share, as the run's and the fields' foreign
--                          keys would take it; delete_tenant takes it for
--                          update before anything else
--   2. the document row    for update
--   3. the run row         for update
--   4. the queue message   pgmq.archive (a delete), or pgmq.read
--   5. the limits lock     check_extraction_limits' advisory lock, after
--                          which nothing waits
--
-- A function that must take one out of order never waits for the next:
-- claim_extraction_run's pgmq.read locks the message before it knows the
-- run, so it takes the document and the run with NOWAIT in a subtransaction
-- and, if either is held, rolls the read back and claims nothing this time.
-- The sweep reads its candidates without locking anything, takes each one's
-- document and run with NOWAIT (it still holds the candidates it has already
-- handled), checks the state again under the locks, and only then reaps and
-- archives.
--
-- Replaces, with the same signatures (so the grants stay): reap_extraction_run,
-- open_extraction_run, close_extraction_run, enqueue_extraction_run,
-- claim_extraction_run, finish_extraction_run, sweep_extraction_queue and
-- delete_tenant. Adds private.lock_extraction_run, which takes a run's
-- document and then the run for all of them. 20260925000002 is left as it
-- was applied: editing it would change the repo, not the projects that ran it.

-- The document, then the run -------------------------------------------------

-- Locks a run the way everything that ends or claims one must: its
-- document first, then the run, both for update. The document id is read
-- before either lock; it can only change to null (the document deleted), and
-- then the document's lock finds no row and the run is returned with a null
-- document_id. Returns the run as it is under the lock, all null if there is
-- no such run.
--
-- p_nowait: raise lock_not_available (55P03) instead of waiting, for callers
-- that already hold a lock later in the order (the claim holds the message)
-- or other runs' locks (the sweep). They call it in a subtransaction, so a
-- miss releases whatever it took.
create function private.lock_extraction_run(p_run_id uuid, p_nowait boolean)
returns public.extraction_runs language plpgsql security definer set search_path = '' as $$
declare
  v_doc_id uuid;
  v_run    public.extraction_runs;
begin
  select r.document_id into v_doc_id from public.extraction_runs r where r.id = p_run_id;

  if v_doc_id is not null then
    if p_nowait then
      perform 1 from public.documents d where d.id = v_doc_id for update nowait;
    else
      perform 1 from public.documents d where d.id = v_doc_id for update;
    end if;
  end if;

  if p_nowait then
    select r.* into v_run from public.extraction_runs r where r.id = p_run_id for update nowait;
  else
    select r.* into v_run from public.extraction_runs r where r.id = p_run_id for update;
  end if;

  return v_run;
end;
$$;

revoke execute on function private.lock_extraction_run(uuid, boolean) from public, anon, authenticated;

-- Ending a run nobody finished -------------------------------------------------

-- As in 20260925000002, except that the run is locked through
-- lock_extraction_run: its document, then the run, then (archiving) its
-- message. Its callers hold the document already (enqueue, open) or the
-- document and the run (claim, sweep), so for them those locks don't wait.
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

-- The deployed app's RPCs, until they are dropped ------------------------------

-- As in 20260925000002, except that the tenant's key share is taken before
-- the document: the run's foreign key would otherwise take it after, while
-- the document is held, and delete_tenant takes the tenant first.
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

  -- the tenant, then the document (20260925000003)
  select d.tenant_id into v_tenant_id from public.documents d where d.id = p_document_id;
  perform 1 from public.tenants t where t.id = v_tenant_id for key share;

  -- lock the document so two opens for it are ordered
  select d.* into v_doc from public.documents d
  where d.id = p_document_id
  for update;

  -- one error for missing and not-admin, so the RPC can't be used to probe ids
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

-- As in 20260925000002, except that it locks in the order: the tenant's key
-- share (the fields' foreign key takes it), then the run's document and the
-- run (lock_extraction_run). Before, it held the run while it waited for the
-- document, the reverse of the enqueue's reaper and of a document's deletion.
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

  -- the tenant, then the document, then the run (20260925000003)
  select r.tenant_id into v_tenant_id from public.extraction_runs r where r.id = p_run_id;
  perform 1 from public.tenants t where t.id = v_tenant_id for key share;
  v_run := private.lock_extraction_run(p_run_id, false);

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

-- The queue's functions -------------------------------------------------------

-- As in 20260925000002, except that the tenant's key share is taken before
-- the document, as in open_extraction_run above.
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

  -- the tenant, then the document (20260925000003)
  select d.tenant_id into v_tenant_id from public.documents d where d.id = p_document_id;
  perform 1 from public.tenants t where t.id = v_tenant_id for key share;

  -- lock the document so two enqueues for it are ordered
  select d.* into v_doc from public.documents d
  where d.id = p_document_id
  for update;

  -- one error for missing and not-admin, so the RPC can't be used to probe ids
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

-- As in 20260925000002, except for how it locks. pgmq.read locks the message
-- before this function knows which run it is for, the reverse of the order,
-- so the run's document and the run are taken with NOWAIT, in the same
-- subtransaction as the read. If either is held (a finish, a reap, the
-- sweep, an enqueue of that document), the subtransaction rolls back: the
-- read is undone, so the message keeps the read_ct and vt it had and is
-- released, and the claim returns no row. The message is not lost: the
-- sweep wakes a worker again for one never read (step b) and ends one
-- claimed and not finished (step a).
create or replace function public.claim_extraction_run()
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
    begin
      select m.msg_id, m.read_ct, m.message into v_msg
      from pgmq.read('extraction', v_limits.worker_visibility_seconds, 1) m;
      if not found then
        return;
      end if;
      v_run := private.lock_extraction_run((v_msg.message ->> 'run_id')::uuid, true);
    exception when lock_not_available then
      return;
    end;

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

-- As in 20260925000002, except that it locks in the order: the tenant's key
-- share (the fields' foreign key takes it), then the run's document and the
-- run (lock_extraction_run), and the message last, when it is archived.
-- Before, it held the run while it waited for the document and the message.
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

  -- the tenant, then the document, then the run (20260925000003)
  select r.tenant_id into v_tenant_id from public.extraction_runs r where r.id = p_run_id;
  perform 1 from public.tenants t where t.id = v_tenant_id for key share;
  v_run := private.lock_extraction_run(p_run_id, false);

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

-- As in 20260925000002, in the same order (a), (c), (d), (b), except for how
-- it locks. Each step reads its candidates without locking anything (step
-- (a) used to lock the message first and then wait for its run). For each
-- candidate it takes the document and the run with NOWAIT, in a
-- subtransaction: it never waits for them, because it already holds the
-- candidates it has handled and a wait could close a cycle with another
-- transaction that takes several (delete_tenant). A candidate someone else
-- holds (a claim, a finish, an enqueue, a reap) is left for the next tick.
-- Under the locks it checks the candidate again, since the run may have
-- ended and its message been archived since the list was read, and only
-- then reaps and archives; the archive, last in the order, may wait.
create or replace function private.sweep_extraction_queue()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_limits public.extraction_limits;
  v_msg    record;
  v_run_id uuid;
  v_run    public.extraction_runs;
  v_wakes  integer;
begin
  select l.* into v_limits from public.extraction_limits l;

  -- (a)
  for v_msg in
    select q.msg_id, (q.message ->> 'run_id')::uuid as run_id from pgmq.q_extraction q
    where q.read_ct >= 1 and q.vt <= now()
    order by q.msg_id
  loop
    begin
      v_run := private.lock_extraction_run(v_msg.run_id, true);
      if exists (select 1 from pgmq.q_extraction q
                 where q.msg_id = v_msg.msg_id and q.read_ct >= 1 and q.vt <= now()) then
        if v_run.id is not null then
          perform private.reap_extraction_run(v_run.id,
            format('claimed but not finished within %s seconds', v_limits.worker_visibility_seconds));
        end if;
        perform pgmq.archive('extraction', v_msg.msg_id);
      end if;
    exception when lock_not_available then
      null;
    end;
  end loop;

  -- (c)
  for v_run_id in
    select r.id from public.extraction_runs r
    where r.status = 'running'
      and coalesce(r.claimed_at, r.started_at) < now() - make_interval(mins => v_limits.stale_run_minutes)
      and not exists (select 1 from pgmq.q_extraction q where q.msg_id = r.queue_msg_id)
    order by r.id
  loop
    begin
      v_run := private.lock_extraction_run(v_run_id, true);
      if v_run.status = 'running'
         and coalesce(v_run.claimed_at, v_run.started_at) < now() - make_interval(mins => v_limits.stale_run_minutes)
         and not exists (select 1 from pgmq.q_extraction q where q.msg_id = v_run.queue_msg_id) then
        perform private.reap_extraction_run(v_run.id,
          format('still running after %s minutes; failed by the sweep', v_limits.stale_run_minutes));
      end if;
    exception when lock_not_available then
      null;
    end;
  end loop;

  -- (d)
  for v_run_id in
    select r.id from public.extraction_runs r
    where r.status = 'queued'
      and r.started_at < now() - make_interval(mins => v_limits.stale_run_minutes)
    order by r.id
  loop
    begin
      v_run := private.lock_extraction_run(v_run_id, true);
      if v_run.status = 'queued'
         and v_run.started_at < now() - make_interval(mins => v_limits.stale_run_minutes) then
        perform private.reap_extraction_run(v_run.id,
          format('not claimed within %s minutes; cancelled at no cost', v_limits.stale_run_minutes));
      end if;
    exception when lock_not_available then
      null;
    end;
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

-- No organization deleted with a run in flight ---------------------------------

-- As in 20260925000002, except that once the refusals have passed it locks
-- the tenant's documents and then its runs before deleting the tenant.
-- Deleting it cascades to both, and Postgres fires those cascades in the
-- order of its foreign keys' trigger names, which nothing here controls;
-- taken first, in the order, those locks make the cascade wait for nothing.
-- The tenant is locked first, so no run can be enqueued or opened for it
-- from here on (both take its key share first), and none in flight is left
-- once the check has passed.
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

  perform 1 from public.documents d where d.tenant_id = p_tenant_id order by d.id for update;
  perform 1 from public.extraction_runs r where r.tenant_id = p_tenant_id order by r.id for update;

  delete from public.tenants where id = p_tenant_id;
end;
$$;
