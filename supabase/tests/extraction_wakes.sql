-- Tests the queue's wakes (20260925000004) against the TEST project (never
-- the app's), inside a transaction that is always rolled back. Run with
--   npm run test:db
-- It creates a throwaway user, an organization and documents as postgres,
-- acts as their owner through auth.uid(), and as pg_cron by calling
-- sweep_extraction_queue as postgres. Every check raises on failure, so a
-- non-zero exit is a failed test; the final select lists what was checked.
--
-- Nothing is sent: pg_net sends a request only after its transaction
-- commits, and this one never does.
begin;

create temp table checks (n serial, step text, result text);

do $t$
begin
  -- the sweeps below must see this test's rows only
  if exists (select 1 from pgmq.q_extraction) or exists (select 1 from public.extraction_runs where status in ('queued', 'running')) then
    raise exception 'the extraction queue is not idle (a suite run in progress, or one killed less than about 11 minutes ago); run test:db again once the sweep has ended it';
  end if;
end $t$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
values ('d1d1d1d1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated',
  'authenticated', 'wake-test-owner@example.invalid', 'x', now(), now(), now(), '{}', '{}', false, false);
insert into public.tenants (id, name, slug) values ('d2d2d2d2-0000-4000-8000-000000000001', 'Wake test', 'wake-test');
insert into public.memberships (tenant_id, user_id, role)
values ('d2d2d2d2-0000-4000-8000-000000000001', 'd1d1d1d1-0000-4000-8000-000000000001', 'owner');
insert into public.documents (id, tenant_id, filename, uploaded_by, status, mime_type, size_bytes)
select ('d3d3d3d3-0000-4000-8000-00000000000' || n)::uuid, 'd2d2d2d2-0000-4000-8000-000000000001',
       'wake-' || n || '.pdf', 'd1d1d1d1-0000-4000-8000-000000000001', 'pending', 'application/pdf', 3141
from generate_series(1, 4) n;

select set_config('request.jwt.claims',
  '{"sub":"d1d1d1d1-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- 1. A wake that fails doesn't undo the tick's reaps -------------------------

do $t$
declare
  v_minutes integer := (select stale_run_minutes from public.extraction_limits);
  v_stale   uuid;
  v_lost    uuid;
  v_run     public.extraction_runs;
begin
  -- a run queued past the deadline, which step (d) expires, and a message
  -- never read for over 60 s, which step (b) wakes a worker for
  v_stale := public.enqueue_extraction_run('d3d3d3d3-0000-4000-8000-000000000001', 1);
  update public.extraction_runs set started_at = now() - make_interval(mins => v_minutes) - interval '1 second'
  where id = v_stale;
  v_lost := public.enqueue_extraction_run('d3d3d3d3-0000-4000-8000-000000000002', 1);
  update pgmq.q_extraction q set enqueued_at = now() - interval '61 seconds', vt = now() - interval '61 seconds'
  from public.extraction_runs r where r.id = v_lost and q.msg_id = r.queue_msg_id;

  -- every wake fails, as one would if pg_net or Vault raised (the real
  -- function comes back when this transaction rolls back)
  execute $f$
    create or replace function private.wake_extraction_worker()
    returns bigint language plpgsql security definer set search_path = '' as $b$
    begin
      raise exception 'a wake that fails' using errcode = 'XX000';
    end;
    $b$
  $f$;

  begin
    perform private.sweep_extraction_queue();
  exception when others then
    raise exception 'a failing wake failed the whole sweep (SQLSTATE %: %)', sqlstate, sqlerrm;
  end;

  select r.* into v_run from public.extraction_runs r where r.id = v_stale;
  if v_run.status <> 'failed' or v_run.error not like 'expired: %'
     or (select kind from private.extraction_spend where run_id = v_stale) is distinct from 'expired' then
    raise exception 'the tick''s reap was not kept: %, %', v_run.status, v_run.error;
  end if;
  if (select status from public.extraction_runs where id = v_lost) <> 'queued' then
    raise exception 'the run whose wake failed must stay queued, for the next tick';
  end if;
  insert into checks (step, result) values
    ('a wake that fails is its own subtransaction: the sweep returns and keeps the tick''s reap', v_run.error);
end $t$;

select step, result from checks order by n;

rollback;
