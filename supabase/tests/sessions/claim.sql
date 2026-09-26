-- Session C of the lock-order tests (setup.sql), case 2: a claim runs while
-- a finish (finish.sql) holds the first run and that run's message is
-- visible again (its visibility timeout has passed), with a second run
-- queued behind it (setup-second.sql).
--
-- Once session F holds the first run's document and the run, this expires
-- that message in a transaction of its own and calls claim_extraction_run as
-- the worker does. Under 20260925000002 pgmq.read locked the message
-- (read_ct 2) and the claim then waited for the run, the finish then waited
-- to archive the message, and PostgreSQL aborted one of them. Under
-- 20260925000003 the claim read the message, failed to lock the document,
-- rolled its read back and returned no row, though the second run was
-- waiting. Now (20260925000004) the claim takes a message's document and
-- run before reading the message: it must fail to lock the first without
-- waiting, leave that message untouched (never locked, read_ct and vt as
-- they were), and claim the second run.
--
-- It holds (20260925, 2) from its start until F's transaction has ended,
-- and takes (20260925, 3) when it is done. It reports, measured before it
-- signals F to go on: the first message's read_ct, vt and xmax before and
-- after the claim (xmax 0 after: nothing locked it), how many rows the
-- claim returned and which document's run, how long it took, and whether F
-- still held its locks then.
select pg_advisory_lock(20260925, 2);
commit;

do $t$
declare
  v_deadline timestamptz := clock_timestamp() + interval '60 seconds';
begin
  while not exists (select 1 from pg_locks l
                    where l.locktype = 'advisory' and l.classid = 20260925::oid and l.objid = 1::oid
                      and l.objsubid = 2 and l.granted and l.pid <> pg_backend_pid()) loop
    if clock_timestamp() > v_deadline then
      raise exception 'session F never took its locks';
    end if;
    perform pg_sleep(0.05);
  end loop;
end $t$;
commit;

-- the claimed message's visibility timeout passes
update pgmq.q_extraction q set vt = clock_timestamp() - interval '1 second'
from public.extraction_runs r
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001' and q.msg_id = r.queue_msg_id;
commit;

create temp table report as
select q.msg_id, q.read_ct as read_ct_before, q.vt as vt_before, q.xmax::text as xmax_before,
       null::integer as read_ct_after, null::timestamptz as vt_after, null::text as xmax_after,
       null::integer as claimed, null::text as claimed_document,
       clock_timestamp() as claim_started, null::timestamptz as claim_returned,
       null::boolean as finish_held_locks, null::text as run_after_claim
from pgmq.q_extraction q
join public.extraction_runs r on r.queue_msg_id = q.msg_id
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001' and q.vt <= clock_timestamp();
commit;

begin;
with claim as (select * from public.claim_extraction_run())
update report set claimed = (select count(*) from claim),
                  claimed_document = (select c.document_id::text from claim c limit 1);
commit; -- the claim's transaction

update report set
  claim_returned    = clock_timestamp(),
  read_ct_after     = (select q.read_ct from pgmq.q_extraction q where q.msg_id = report.msg_id),
  vt_after          = (select q.vt from pgmq.q_extraction q where q.msg_id = report.msg_id),
  xmax_after        = (select q.xmax::text from pgmq.q_extraction q where q.msg_id = report.msg_id),
  finish_held_locks = exists (select 1 from pg_locks l
                              where l.locktype = 'advisory' and l.classid = 20260925::oid and l.objid = 1::oid
                                and l.objsubid = 2 and l.granted and l.pid <> pg_backend_pid()),
  run_after_claim   = (select r.status::text from public.extraction_runs r
                       where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001');
commit;

select pg_advisory_lock(20260925, 3);
commit;

-- Both signals are kept until session F's transaction has ended: this
-- session can get here within one of F's polls of pg_locks, and F must see
-- it to go on.
do $t$
declare
  v_deadline timestamptz := clock_timestamp() + interval '60 seconds';
begin
  while exists (select 1 from pg_locks l
                where l.locktype = 'advisory' and l.classid = 20260925::oid and l.objid = 1::oid
                  and l.objsubid = 2 and l.granted and l.pid <> pg_backend_pid())
        and clock_timestamp() < v_deadline loop
    perform pg_sleep(0.05);
  end loop;
end $t$;
commit;
select pg_advisory_unlock_all();
commit;

select msg_id is not null as candidate, claimed, claimed_document, read_ct_before, read_ct_after,
       vt_after = vt_before as vt_unchanged, xmax_before, xmax_after,
       round(extract(epoch from claim_returned - claim_started) * 1000) as claim_ms,
       finish_held_locks, run_after_claim
from report;
