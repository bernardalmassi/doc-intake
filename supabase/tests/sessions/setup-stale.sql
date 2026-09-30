-- The held-document cases of the two-session tests (setup.sql,
-- hold-document.sql or hold-document-long.sql, sweep-stale.sql;
-- 20260925000005, section 7): a second run, of the fixture's second
-- document, enqueued as its owner and left queued, then made older than the
-- stale limit, committed. The sweep's step (d) expires such a run at 0 once
-- it has the run's document and the run.
begin;

select set_config('request.jwt.claims',
  '{"sub":"f1f1f1f1-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.enqueue_extraction_run('f3f3f3f3-0000-4000-8000-000000000002', 1);
update public.extraction_runs r
set started_at = now() - make_interval(mins => (select l.stale_run_minutes + 1 from public.extraction_limits l))
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000002';

commit;

select r.id as run_id, r.status::text as status, q.read_ct
from public.extraction_runs r
join pgmq.q_extraction q on q.msg_id = r.queue_msg_id
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000002';
