-- Session S of the lock-order tests (setup.sql), case 1: the sweep runs at
-- the claimed message's visibility timeout while a finish (finish.sql)
-- holds the run.
--
-- Once session F holds the document and the run, this expires the message
-- in a transaction of its own, so the sweep finds a claimed message past its
-- visibility timeout, step (a)'s candidate, and runs the sweep. Under
-- 20260925000002 the sweep locked the message and then waited for the run,
-- the finish then waited to archive the message, and PostgreSQL aborted one
-- of them. Under 20260925000003 and 000004 the sweep skipped the run it
-- couldn't lock (NOWAIT) and returned at once. Now (20260925000005) it waits
-- for the document, which F lets go by finishing (F goes on once the sweep
-- waits on it); the sweep then finds the message archived and the run
-- finished, and leaves both. Either way the finish must archive the message
-- and commit with its result (check.sql), with no deadlock.
--
-- It holds (20260925, 2) from its start until F's transaction has ended,
-- and takes (20260925, 3) when it is done. It reports, measured before it
-- signals F to go on: whether the message was a candidate, its xmax before
-- the sweep (0: nothing held it), how long the sweep took, whether F still
-- held its locks when the sweep returned, and the run as the sweep left it.
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

-- the claimed message's visibility timeout passes, as the sweep will see
-- it: the sweep's steps compare vt with now(), and every transaction this
-- file starts has the same now(), the time the file (one query message)
-- arrived, which can be seconds before this update after the wait for
-- session F; a vt set from clock_timestamp() then isn't past it, and the
-- sweep finds no candidate
update pgmq.q_extraction q set vt = now() - interval '1 second'
from public.extraction_runs r
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001' and q.msg_id = r.queue_msg_id;
commit;

create temp table report as
select q.msg_id, q.read_ct >= 1 and q.vt <= now() as candidate, q.xmax::text as xmax_before,
       null::text as xmax_after, clock_timestamp() as sweep_started, null::timestamptz as sweep_returned,
       null::boolean as finish_held_locks, null::text as run_after_sweep
from pgmq.q_extraction q
join public.extraction_runs r on r.queue_msg_id = q.msg_id
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001';
commit;

begin;
select private.sweep_extraction_queue();
commit; -- the sweep's transaction

update report set
  sweep_returned    = clock_timestamp(),
  xmax_after        = (select q.xmax::text from pgmq.q_extraction q where q.msg_id = report.msg_id),
  finish_held_locks = exists (select 1 from pg_locks l
                              where l.locktype = 'advisory' and l.classid = 20260925::oid and l.objid = 1::oid
                                and l.objsubid = 2 and l.granted and l.pid <> pg_backend_pid()),
  run_after_sweep   = (select r.status::text from public.extraction_runs r
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

select candidate, xmax_before, xmax_after,
       round(extract(epoch from sweep_returned - sweep_started) * 1000) as sweep_ms,
       finish_held_locks, run_after_sweep
from report;
