-- The lock-order tests (setup.sql): turns pg_cron's extraction-sweep job
-- back on after the two-session cases (sweep-pause.sql paused it), and
-- reports what scripts/test-db.mjs asserts: that the job is active, and the
-- ticks that started in the last 15 minutes, so it can check none started
-- while the job was paused.
begin;

select cron.alter_job(j.jobid, active := true) from cron.job j where j.jobname = 'extraction-sweep';

commit;

select j.active, extract(epoch from clock_timestamp()) as resumed_at,
       (select coalesce(jsonb_agg(extract(epoch from d.start_time) order by d.start_time), '[]'::jsonb)
        from cron.job_run_details d
        where d.jobid = j.jobid and d.start_time > now() - interval '15 minutes') as recent_starts
from cron.job j where j.jobname = 'extraction-sweep';
