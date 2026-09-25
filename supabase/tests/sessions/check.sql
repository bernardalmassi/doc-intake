-- The lock-order tests (setup.sql): what the database recorded once both
-- sessions have ended. The finish must have committed with its result: the
-- run succeeded at its own usage, its field written, the document extracted,
-- one 'charge' row in the ledger at the run's cost, and the token gone. The
-- message must have been archived exactly once, with the read_ct the setup's
-- claim gave it (1): no second read stuck, and no second delivery priced.
-- Every check raises on failure.
do $t$
declare
  v_run      public.extraction_runs;
  v_spend    record;
  v_archived integer;
  v_read_ct  integer;
begin
  select r.* into v_run from public.extraction_runs r
  where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001';
  if v_run.id is null then
    raise exception 'the fixture''s run is gone';
  end if;
  if v_run.status <> 'succeeded' or v_run.model is distinct from 'gpt-5-nano'
     or v_run.input_tokens is distinct from 10 or v_run.output_tokens is distinct from 1 then
    raise exception 'the finish was not kept: the run is % (model %, error %)', v_run.status, v_run.model, v_run.error;
  end if;
  if (select d.status from public.documents d where d.id = v_run.document_id) <> 'extracted' then
    raise exception 'the document is not extracted';
  end if;
  if (select count(*) from public.extracted_fields f where f.run_id = v_run.id) <> 1 then
    raise exception 'the finish''s field was not kept';
  end if;
  select count(*) as n, min(s.kind) as kind, min(s.cost_usd) as cost_usd into v_spend
  from private.extraction_spend s where s.run_id = v_run.id;
  if v_spend.n <> 1 or v_spend.kind <> 'charge' or v_spend.cost_usd is distinct from v_run.cost_usd then
    raise exception 'the ledger holds % rows for the run (kind %, % USD; the run says % USD)',
      v_spend.n, v_spend.kind, v_spend.cost_usd, v_run.cost_usd;
  end if;
  if exists (select 1 from private.extraction_run_tokens t where t.run_id = v_run.id) then
    raise exception 'the claim token outlived the finish';
  end if;
  if exists (select 1 from pgmq.q_extraction q where q.msg_id = v_run.queue_msg_id) then
    raise exception 'the message is still in the queue';
  end if;
  select count(*), min(a.read_ct) into v_archived, v_read_ct
  from pgmq.a_extraction a where a.msg_id = v_run.queue_msg_id;
  if v_archived <> 1 then
    raise exception 'the message was archived % times', v_archived;
  end if;
  if v_read_ct <> 1 then
    raise exception 'the message was archived with read_ct %, not the 1 its claim gave it', v_read_ct;
  end if;
end $t$;

select r.status::text as run_status, r.cost_usd, d.status::text as document_status,
       (select count(*) from public.extracted_fields f where f.run_id = r.id) as fields,
       (select s.kind from private.extraction_spend s where s.run_id = r.id) as ledger_kind,
       (select count(*) from pgmq.a_extraction a where a.msg_id = r.queue_msg_id) as archived,
       (select a.read_ct from pgmq.a_extraction a where a.msg_id = r.queue_msg_id) as archived_read_ct
from public.extraction_runs r
join public.documents d on d.id = r.document_id
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001';
