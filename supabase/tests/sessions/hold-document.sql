-- Session H of a held-document case (setup-stale.sql, sweep-stale.sql;
-- 20260925000005, section 7): holds the second document's row as a rename
-- does (for no key update) while the sweep runs, the document of a run past
-- its deadline. Once the sweep is waiting for it, H holds it one more
-- second, then lets go: a lock held as briefly as a rename's, which the
-- sweep must wait for.
-- Under 20260925000004 the sweep took the document with NOWAIT and skipped
-- the run, which stayed in flight for as long as someone held the row at
-- each tick.
--
-- Signals, through pg_locks, as in finish.sql: this session holds
-- (20260925, 1) while it holds the row; the other session holds
-- (20260925, 2) from its start, and takes (20260925, 3) when its sweep has
-- returned.
begin;
select 1 from public.documents d where d.id = 'f3f3f3f3-0000-4000-8000-000000000002' for no key update;
select pg_advisory_xact_lock(20260925, 1);

do $t$
declare
  v_other   integer;
  v_start   timestamptz := clock_timestamp();
  v_waiting boolean := false;
begin
  loop
    select l.pid into v_other from pg_locks l
    where l.locktype = 'advisory' and l.classid = 20260925::oid and l.objid = 2::oid and l.objsubid = 2 and l.granted;
    exit when v_other is not null;
    if clock_timestamp() > v_start + interval '60 seconds' then
      raise exception 'the other session never started';
    end if;
    perform pg_sleep(0.05);
  end loop;

  -- until the sweep waits on this row, or has returned, or is gone
  loop
    v_waiting := exists (select 1 from pg_locks l where l.pid = v_other and not l.granted);
    exit when v_waiting
           or exists (select 1 from pg_locks l
                      where l.pid = v_other and l.locktype = 'advisory'
                        and l.classid = 20260925::oid and l.objid = 3::oid and l.objsubid = 2 and l.granted)
           or not exists (select 1 from pg_locks l
                          where l.pid = v_other and l.locktype = 'advisory'
                            and l.classid = 20260925::oid and l.objid = 2::oid and l.objsubid = 2);
    if clock_timestamp() > v_start + interval '60 seconds' then
      raise exception 'the sweep neither waited nor returned';
    end if;
    perform pg_sleep(0.05);
  end loop;

  if v_waiting then
    perform pg_sleep(1);
  end if;
end $t$;

commit;

select 'let go' as holder;
