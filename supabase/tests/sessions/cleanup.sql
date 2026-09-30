-- The lock-order tests (setup.sql): removes the fixture, before a case (in
-- case a killed run left it) and after one, whatever happened. A run of the
-- fixture still in flight is ended at no cost first: a claimed one through
-- its own token, as a failed finish with no model (a 0 USD 'charge' row), a
-- queued one expired at 0. Then the organization (its documents, runs,
-- fields and tokens cascade; its ledger rows stay, as every ledger row does)
-- and the user. Does nothing when there is no fixture.
begin;

do $t$
declare
  v_run record;
begin
  for v_run in
    select r.id, r.status, t.token from public.extraction_runs r
    left join private.extraction_run_tokens t on t.run_id = r.id
    where r.tenant_id = 'f2f2f2f2-0000-4000-8000-000000000001' and r.status in ('queued', 'running')
  loop
    if v_run.token is not null then
      perform public.finish_extraction_run(v_run.id, v_run.token, 'failed', null, null, 0, 0, 0, 0, false,
        'ended by the lock-order test''s cleanup', null, null);
    else
      perform private.reap_extraction_run(v_run.id, 'ended by the lock-order test''s cleanup');
    end if;
  end loop;
end $t$;

delete from public.tenants where id = 'f2f2f2f2-0000-4000-8000-000000000001';
delete from auth.users where id = 'f1f1f1f1-0000-4000-8000-000000000001';

commit;

select not exists (select 1 from public.tenants where id = 'f2f2f2f2-0000-4000-8000-000000000001')
   and not exists (select 1 from auth.users where id = 'f1f1f1f1-0000-4000-8000-000000000001') as removed,
       (select count(*) from pgmq.q_extraction) as queued_messages,
       (select count(*) from public.extraction_runs where status in ('queued', 'running')) as runs_in_flight;
