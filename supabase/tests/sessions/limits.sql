-- Session C of the ceiling-check case (setup.sql): check_extraction_limits
-- runs for the fixture's organization while a finish (finish-table.sql)
-- commits the fixture's run in the middle of it.
--
-- Inside a subtransaction that is always rolled back, it adds a ledger row
-- that brings the organization to exactly its ceiling once the fixture's run
-- is counted at the charge the finish records (10 tokens in and 1 out at
-- gpt-5-nano's price), and no further. Then it runs the check. Counted once
-- (at that charge, or at its estimate while still in flight), the run takes
-- the organization to the ceiling and the check refuses with the tenant's
-- 53400. Counted in neither sum, the check passes. The row is never
-- committed: the subtransaction ends in an exception either way.
--
-- It holds (20260925, 2) from its start until F's transaction has ended,
-- and takes (20260925, 3) when it is done. It reports the run's status
-- before and after the check (running, then succeeded: F committed while
-- the check ran), what the check said, and whether its ledger row was left
-- behind (it must not be).
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
      raise exception 'session F never took its lock';
    end if;
    perform pg_sleep(0.05);
  end loop;
end $t$;
commit;

create temp table report (
  run_before_check text,
  run_after_check  text,
  result           text,
  check_started    timestamptz,
  check_returned   timestamptz
);
commit;

do $t$
declare
  v_tenant   uuid := 'f2f2f2f2-0000-4000-8000-000000000001';
  v_limits   public.extraction_limits;
  v_existing numeric;
  v_charge   numeric;
  v_before   text;
  v_result   text;
  v_started  timestamptz;
begin
  select l.* into v_limits from public.extraction_limits l;
  -- what the finish will charge the fixture's run
  select c.cost_usd into v_charge from private.extraction_charge('gpt-5-nano', 'openai', 10, 1) c;
  -- what the organization's ledger already holds this month (earlier runs of
  -- these cases leave their charges, as every ledger row stays)
  select coalesce(sum(s.cost_usd), 0) into v_existing from private.extraction_spend s
  where s.tenant_id = v_tenant and s.created_at >= date_trunc('month', now(), 'UTC');
  select r.status::text into v_before from public.extraction_runs r
  where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001';

  v_started := clock_timestamp();
  begin
    insert into private.extraction_spend (kind, tenant_id, run_id, cost_usd)
    values ('charge', v_tenant, gen_random_uuid(), v_limits.tenant_monthly_ceiling_usd - v_existing - v_charge);
    perform private.check_extraction_limits(v_tenant, null);
    -- rolls the row back
    raise exception 'passed' using errcode = 'P0001';
  exception
    when sqlstate '53400' then v_result := 'refused: ' || sqlerrm;
    when sqlstate 'P0001' then v_result := sqlerrm;
  end;

  insert into report values (
    v_before,
    (select r.status::text from public.extraction_runs r where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000001'),
    v_result,
    v_started,
    clock_timestamp());
end $t$;
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

select run_before_check, run_after_check, result,
       round(extract(epoch from check_returned - check_started) * 1000) as check_ms,
       (select count(*) from private.extraction_spend s
        where s.tenant_id = 'f2f2f2f2-0000-4000-8000-000000000001' and s.kind = 'charge'
          and s.created_at >= check_started and s.run_id not in (select r.id from public.extraction_runs r)) as rows_left
from report;
