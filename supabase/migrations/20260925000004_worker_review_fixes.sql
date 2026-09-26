-- Fixes from the two adversarial reviews of the worker branch, each in a
-- section of its own, numbered as the review's items (docs/worker-design.md
-- and SECURITY.md have the whole design). 20260925000003 is left as it was
-- applied.

-- 3. One snapshot per ceiling check ------------------------------------------

-- As in 20260925000002, except that each ceiling reads the ledger and the
-- runs in flight in one statement. Under READ COMMITTED every statement takes
-- its own snapshot: the tenant's ledger sum and its in-flight sum used to be
-- two statements, so a finish (or a reap) committing between them, which
-- writes the run's ledger row and ends the run in one transaction, was seen
-- in neither: not yet in the ledger, no longer in flight. One statement sees
-- that transaction entirely or not at all, so the run is counted exactly
-- once, at its estimate or at its charge. The advisory lock still orders the
-- checks themselves.
create or replace function private.check_extraction_limits(p_tenant_id uuid, p_reaped_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_limits      public.extraction_limits;
  v_month_start timestamptz := date_trunc('month', now(), 'UTC');
  v_total       numeric;
  v_recent_runs integer;
begin
  -- one check at a time, project wide
  perform pg_advisory_xact_lock(hashtext('public.extraction_runs'));

  select l.* into v_limits from public.extraction_limits l;

  -- the tenant's ledger this month plus its runs in flight, in one snapshot
  select (select coalesce(sum(s.cost_usd), 0)
          from private.extraction_spend s
          where s.tenant_id = p_tenant_id
            and s.created_at >= v_month_start
            and s.run_id is distinct from p_reaped_run_id)
       + (select coalesce(sum(e.cost_usd), 0)
          from public.extraction_runs r
          cross join lateral private.abandoned_estimate(r.page_count) e
          where r.tenant_id = p_tenant_id
            and r.status in ('queued', 'running'))
  into v_total;

  if v_total >= v_limits.tenant_monthly_ceiling_usd then
    raise exception 'this organization has reached its monthly extraction spend ceiling (% USD), counting extractions in progress',
      v_limits.tenant_monthly_ceiling_usd
      using errcode = '53400';
  end if;

  -- the same across every tenant, in one snapshot
  select (select coalesce(sum(s.cost_usd), 0)
          from private.extraction_spend s
          where s.created_at >= v_month_start
            and s.run_id is distinct from p_reaped_run_id)
       + (select coalesce(sum(e.cost_usd), 0)
          from public.extraction_runs r
          cross join lateral private.abandoned_estimate(r.page_count) e
          where r.status in ('queued', 'running'))
  into v_total;

  if v_total >= v_limits.global_monthly_ceiling_usd then
    raise exception 'the monthly extraction spend ceiling across all organizations has been reached (% USD), counting extractions in progress',
      v_limits.global_monthly_ceiling_usd
      using errcode = '53400';
  end if;

  select count(*) into v_recent_runs
  from public.extraction_runs r
  where r.tenant_id = p_tenant_id
    and r.started_at > now() - interval '1 hour';

  if v_recent_runs >= v_limits.hourly_run_limit then
    raise exception 'this organization has reached its limit of % extraction runs per hour',
      v_limits.hourly_run_limit
      using errcode = '54000';
  end if;
end;
$$;
