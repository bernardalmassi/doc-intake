-- Session C of the stuck-claim case (hold-tokens.sql says how it runs): a
-- claim, as the worker makes it, while session H holds the table the claim
-- writes its token to. The first run (setup.sql) is claimed and its message
-- hidden, so the claim takes the second run (setup-second.sql): it locks the
-- run, reads its message, sets it running, and waits to insert the token.
-- Under 20260925000005 the claim's own transaction_timeout ends this session
-- after 5 s (25P04), and nothing after the claim runs; the runner expects
-- that error. Before it, the claim waited until H let go and then claimed
-- the run, and this session went on to signal (20260925, 3) and report.
--
-- It holds (20260925, 2) from its start, for H to find it by.
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

create temp table claimed as select * from public.claim_extraction_run();
commit; -- the claim's transaction

select pg_advisory_lock(20260925, 3);
commit;
select pg_advisory_unlock_all();
commit;

select count(*) as claimed, min(document_id::text) as claimed_document from claimed;
