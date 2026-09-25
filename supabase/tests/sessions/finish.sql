-- Session F of the lock-order tests (setup.sql): a finish that holds its
-- run while the other session acts on the run's message.
--
-- In one transaction it takes the locks finish_extraction_run takes first,
-- with the same statements and in the same order (20260925000003): the
-- tenant's key share, the document, the run. It holds them until the other
-- session has done what it does (it holds the advisory lock (20260925, 3)),
-- is waiting for a lock (on this session), or has gone. Then it calls
-- finish_extraction_run in the same transaction, which archives the message,
-- and commits. So the other session always acts while the finish holds the
-- run, and the finish always archives after it.
--
-- Signals, through pg_locks: this session holds (20260925, 1) while it
-- holds the locks; the other session holds (20260925, 2) from its start
-- until this transaction has ended, and takes (20260925, 3) when it is done.
begin;

select 1 from public.tenants t where t.id = 'f2f2f2f2-0000-4000-8000-000000000001' for key share;
select 1 from public.documents d where d.id = 'f3f3f3f3-0000-4000-8000-000000000001' for update;
select 1 from public.extraction_runs r
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001' and r.status = 'running'
for update;

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
