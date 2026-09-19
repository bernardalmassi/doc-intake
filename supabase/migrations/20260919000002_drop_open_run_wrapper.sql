-- Drops open_extraction_run(p_document_id uuid), the one-argument wrapper
-- kept since 20260918000003 so that app code deployed before it could still
-- open a run (SECURITY.md, "Deploying schema changes", rule 2).
--
-- The deployed app no longer calls it. On 2026-09-19 Vercel listed three
-- deployments of the project: f8673b0, 540e0cc and 14ed340. All three are
-- production, there are no previews, and none were recently deleted. Each
-- descends from 4253a82, which made the Extract action send p_page_count,
-- so an Instant Rollback can't land on a build that calls the wrapper.
--
-- open_extraction_run(p_document_id uuid, p_page_count integer) is
-- unchanged, and its grants with it. Dropping a function drops its grants,
-- so nothing is left to revoke. A call naming only p_document_id now fails
-- in PostgREST as PGRST202 (no such function) instead of opening a run
-- with no page count.
--
-- No `if exists`: if the wrapper isn't there, the database isn't in the
-- state this migration expects, and the push should stop.

drop function public.open_extraction_run(uuid);
