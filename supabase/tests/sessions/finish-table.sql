-- Session F of the ceiling-check case (setup.sql, limits.sql): a finish
-- that commits while a ceiling check is between its reads.
--
-- It holds extraction_runs in access exclusive mode, which makes any
-- statement that reads the table wait before it takes its snapshot (a
-- statement's locks are taken when it is planned, its snapshot after). So
-- the check's read of the runs in flight waits for this transaction, and a
-- read of the ledger alone doesn't. It holds the lock until the other
-- session is waiting for it (or has finished, or gone), then finishes the
-- fixture's run as finish.sql does, which writes its ledger row and ends the
-- run in one transaction, and commits. A check that read the ledger and the
-- runs in two statements has read the ledger before this commit and the
-- runs after it, and counted the run in neither; one that reads both in one
-- statement sees this commit whole.
--
-- Signals, as in finish.sql: this session holds (20260925, 1) while it holds
-- the lock; the other holds (20260925, 2) from its start until this
-- transaction has ended, and takes (20260925, 3) when it is done.
begin;

lock table public.extraction_runs in access exclusive mode;

select pg_advisory_xact_lock(20260925, 1);

do $t$
declare
  v_other    integer;
  v_deadline timestamptz := clock_timestamp() + interval '60 seconds';
begin
  loop
    select l.pid into v_other from pg_locks l
    where l.locktype = 'advisory' and l.classid = 20260925::oid and l.objid = 2::oid and l.objsubid = 2 and l.granted;
    exit when v_other is not null;
    if clock_timestamp() > v_deadline then
      raise exception 'the other session never started';
    end if;
    perform pg_sleep(0.05);
  end loop;

  loop
    exit when exists (select 1 from pg_locks l
                      where l.pid = v_other and l.locktype = 'advisory'
                        and l.classid = 20260925::oid and l.objid = 3::oid and l.objsubid = 2 and l.granted)
           or exists (select 1 from pg_locks l where l.pid = v_other and not l.granted)
           or not exists (select 1 from pg_locks l
                          where l.pid = v_other and l.locktype = 'advisory'
                            and l.classid = 20260925::oid and l.objid = 2::oid and l.objsubid = 2);
    if clock_timestamp() > v_deadline then
      raise exception 'the other session neither finished nor waited';
    end if;
    perform pg_sleep(0.05);
  end loop;
end $t$;

select r.id, r.status, (public.finish_extraction_run(r.id, t.token, 'succeeded', 'openai', 'gpt-5-nano',
  10, 1, 1200, 1, false, null, null,
  '[{"name":"title","value":"Lock order","confidence":0.95,"band":"high","source_text":"Lock order","clarifying_question":null}]'::jsonb)).status
  as finished
from public.extraction_runs r
join private.extraction_run_tokens t on t.run_id = r.id
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001' and r.status = 'running';

commit;

select 'committed' as finish, r.status::text as run_status
from public.extraction_runs r where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001';
