-- A run can now wait in the extraction queue before a worker claims it
-- (docs/worker-design.md, section 4): enqueue_extraction_run inserts it as
-- 'queued', claim_extraction_run moves it to 'running'.
--
-- In a file of its own, like 20260917000008: a value added to an enum can't
-- be used in the transaction that adds it, and 20260925000002 uses it in
-- checks, indexes and functions.

alter type public.extraction_run_status add value 'queued' before 'running';
