-- The claim case of the two-session tests (setup.sql, claim.sql): a second
-- run, of the fixture's second document, enqueued as its owner and left
-- queued, committed. Its message comes after the first run's, so a claim
-- that can't lock the first run must skip that message and claim this one
-- (20260925000004).
begin;

select set_config('request.jwt.claims',
  '{"sub":"f1f1f1f1-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.enqueue_extraction_run('f3f3f3f3-0000-4000-8000-000000000002', 1);

commit;

select r.id as run_id, r.status::text as status, q.read_ct
from public.extraction_runs r
join pgmq.q_extraction q on q.msg_id = r.queue_msg_id
where r.document_id = 'f3f3f3f3-0000-4000-8000-000000000002';
