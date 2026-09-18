-- The app's Anthropic model is now Claude Sonnet 5 (claude-sonnet-5, $2 / $10
-- per million tokens, already in extraction_model_prices), so an abandoned
-- run is estimated at its price rather than Claude Haiku 4.5's: the reaper
-- prices at the dearest model the app may have called (20260918000003).
--
-- A one-page abandoned run goes from 0.05322 USD to 0.10644 USD. The rule the
-- estimate has to meet is that a handful of abandoned runs can't exhaust a
-- tenant: the hourly run limit's worth (5) of one-page abandoned runs is
-- 0.5322 USD, under the 1 USD tenant ceiling. SECURITY.md, "Stale runs", has
-- the figures for both models. The tenant ceiling is unchanged.
--
-- Only data changes: the limits row and the column's default. The mirror in
-- src/lib/extraction/config.ts (abandonedRunPriceModel) changes with it, and
-- tests/extraction.test.ts checks the two agree.

update public.extraction_limits
set abandoned_run_price_model = 'claude-sonnet-5';

alter table public.extraction_limits
  alter column abandoned_run_price_model set default 'claude-sonnet-5';
