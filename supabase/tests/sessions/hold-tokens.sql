-- Session H of the stuck-claim case (setup.sql, setup-second.sql,
-- claim-stuck.sql; 20260925000005, section 4): holds a lock the claim needs
-- only after it has read its message, so the claim is stuck halfway through.
--
-- It takes private.extraction_run_tokens in exclusive mode, which a claim's
-- insert of its token (row exclusive) must wait for, and holds it until the
-- other session's backend is gone or 15 s have passed. The claim before it
-- has locked the second run, read that run's message and set the run
-- running; its own transaction_timeout (5 s) must then end its session and
-- roll all of that back. With no timeout it waits here for as long as the
-- lock is held, and claims the run once H lets go.
--
-- Signals, through pg_locks, as in finish.sql: this session holds
-- (20260925, 1) while it holds the table; the other session holds
-- (20260925, 2) from its start, and would take (20260925, 3) once its claim
-- returned. H reports, once it has let go: whether the other session waited
-- on it, whether its backend ended while H still held the table, how long it
-- waited, and the second run as the database has it then: its status, its
-- message's read_ct and visibility, and whether it has a token.
create temp table report (
  other_pid       integer,
  waited          boolean,
  wait_started    timestamptz,
  ended_while_held boolean,
  ended_at        timestamptz,
  claim_returned  boolean
);
commit;

begin;
lock table private.extraction_run_tokens in exclusive mode;
select pg_advisory_xact_lock(20260925, 1);

do $t$
declare
  v_other    integer;
  v_start    timestamptz := clock_timestamp();
  v_waiting  timestamptz;
  v_ended    timestamptz;
  v_returned boolean := false;
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

  -- until its backend is gone, it signals that its claim returned, or 15 s
  loop
    if v_waiting is null and exists (select 1 from pg_locks l where l.pid = v_other and not l.granted) then
      v_waiting := clock_timestamp();
    end if;
    -- pg_stat_activity is a snapshot kept for the transaction unless cleared
    perform pg_stat_clear_snapshot();
    if not exists (select 1 from pg_stat_activity a where a.pid = v_other) then
      v_ended := clock_timestamp();
      exit;
    end if;
    if exists (select 1 from pg_locks l
               where l.pid = v_other and l.locktype = 'advisory'
                 and l.classid = 20260925::oid and l.objid = 3::oid and l.objsubid = 2 and l.granted) then
      v_returned := true;
      exit;
    end if;
    exit when clock_timestamp() > v_start + interval '15 seconds';
    perform pg_sleep(0.05);
  end loop;

  insert into report values (v_other, v_waiting is not null, v_waiting, v_ended is not null, v_ended, v_returned);
end $t$;

commit; -- lets go of the table

select r.waited, r.ended_while_held, r.claim_returned,
       round(extract(epoch from r.ended_at - r.wait_started) * 1000) as waited_ms,
       run.status::text as run_status, q.read_ct, q.vt <= clock_timestamp() as visible,
       exists (select 1 from private.extraction_run_tokens t where t.run_id = run.id) as has_token
from report r
cross join public.extraction_runs run
left join pgmq.q_extraction q on q.msg_id = run.queue_msg_id
where run.document_id = 'f3f3f3f3-0000-4000-8000-000000000002';
