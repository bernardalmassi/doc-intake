-- The lock-order tests (setup.sql): pauses pg_cron's extraction-sweep job
-- for as long as the two-session cases run. Their fixture has a claimed
-- message that a session expires on purpose; a live tick landing on it (in
-- a failed case, once session F has let go of the run) would reap it at the
-- page-count estimate, a permanent 'abandoned' row in the ledger, and would
-- make the case flaky. scripts/test-db.mjs runs sweep-resume.sql in a
-- finally, and fails unless the job is active again and no tick started
-- while it was paused.
--
-- Refuses if the job is already paused: a killed test:db run can leave it
-- so, and then someone has to look before anything turns it back on.
--
-- Refuses, first, on any project whose Vault holds extraction_worker_url:
-- only the app project may hold it (docs/worker-design.md, D2), so that is
-- the app project, or one set up like it, and nothing here may pause its
-- sweep or commit fixtures there. scripts/test-db.mjs runs the guard, the
-- block between the markers, against a pair made inside a rolled-back
-- transaction before every pause, and fails unless it refuses.
begin;

-- guard: begin
do $t$
begin
  if exists (select 1 from vault.secrets s where s.name = 'extraction_worker_url') then
    raise exception 'this project''s Vault holds extraction_worker_url: it is the app project, or set up like it, and the two-session tests never run there';
  end if;
end $t$;
-- guard: end

do $t$
declare
  v_job cron.job;
begin
  select j.* into v_job from cron.job j where j.jobname = 'extraction-sweep';
  if v_job.jobid is null then
    raise exception 'the extraction-sweep cron job is missing';
  end if;
  if not v_job.active then
    raise exception 'the extraction-sweep cron job is already paused (a killed test:db run leaves it so); check the queue, then turn it back on with: select cron.alter_job(%, active := true);', v_job.jobid;
  end if;
  perform cron.alter_job(v_job.jobid, active := false);
end $t$;

commit;

-- pg_cron starts a tick at second 0. Paused in the last seconds of a
-- minute, the scheduler may start one more before it rereads the job, so
-- wait past the boundary; then wait for any tick still running to end.
do $t$
declare
  v_deadline timestamptz := clock_timestamp() + interval '60 seconds';
begin
  if extract(second from clock_timestamp()) >= 55 then
    perform pg_sleep(66 - extract(second from clock_timestamp()));
  end if;
  while exists (select 1 from cron.job_run_details d
                join cron.job j on j.jobid = d.jobid
                where j.jobname = 'extraction-sweep'
                  and d.status not in ('succeeded', 'failed')
                  and d.start_time > now() - interval '10 minutes') loop
    if clock_timestamp() > v_deadline then
      raise exception 'an extraction-sweep tick is still running a minute after the pause';
    end if;
    perform pg_sleep(0.1);
  end loop;
end $t$;

commit;

select j.jobid, j.active, extract(epoch from clock_timestamp()) as paused_at
from cron.job j where j.jobname = 'extraction-sweep';
