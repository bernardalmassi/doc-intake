-- Session S of a held-document case (setup-stale.sql, hold-document.sql or
-- hold-document-long.sql; 20260925000005, section 7): the sweep, as pg_cron
-- runs it, while session H holds the document of a queued run past the
-- stale limit. It must wait for the row, at most its 5 s lock_timeout: with
-- the lock let go after a second it expires the run at 0; held longer, it
-- gives up at its timeout, raises nothing, and leaves the run queued for the
-- next tick. Under 20260925000004 it took the document with NOWAIT and
-- returned at once, the run still queued.
--
-- It holds (20260925, 2) from its start until H's transaction has ended,
-- and takes (20260925, 3) when its sweep has returned. It reports how long
-- the sweep took and the run as the sweep left it.
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
      raise exception 'session H never took its lock';
    end if;
    perform pg_sleep(0.05);
  end loop;
end $t$;
commit;

create temp table report as
select clock_timestamp() as sweep_started, null::timestamptz as sweep_returned,
       null::text as run_status, null::text as run_error;
commit;

begin;
select private.sweep_extraction_queue();
commit; -- the sweep's transaction

update report set
  sweep_returned = clock_timestamp(),
  run_status     = (select r.status::text from public.extraction_runs r
                    where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000002'),
  run_error      = (select left(r.error, 60) from public.extraction_runs r
                    where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000002');
commit;

select pg_advisory_lock(20260925, 3);
commit;

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

select round(extract(epoch from sweep_returned - sweep_started) * 1000) as sweep_ms, run_status, run_error
from report;
