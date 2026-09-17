-- Revoke the table privileges that Supabase's default ACLs still hand to the
-- API roles after auto-expose was turned off. Turning it off removed
-- select/insert/update/delete from the defaults but left:
--
--   TRUNCATE    not subject to RLS; empties a table regardless of policies
--   REFERENCES  lets the role create foreign keys pointing at the table
--   TRIGGER     lets the role create triggers on the table
--   MAINTAIN    VACUUM, ANALYZE, REINDEX, CLUSTER, REFRESH MATERIALIZED VIEW,
--               and LOCK TABLE (Postgres 17+)
--
-- PostgREST can't issue any of these, so nothing reaches them today. This is
-- defense in depth in case anything ever lets these roles run arbitrary SQL.
-- The Data API privileges granted explicitly in earlier migrations are
-- untouched.
--
-- service_role keeps its privileges: it bypasses RLS and is trusted by
-- design, and it isn't used by the app or tests.

revoke truncate, references, trigger, maintain
  on public.tenants, public.memberships, public.documents
  from anon, authenticated;

-- Migrations run as postgres, and postgres's default ACL for new tables in
-- public grants the same four privileges to anon and authenticated. Without
-- this, every future table would get them again. This changes only the
-- defaults owned by postgres; Supabase's own supabase_admin defaults can't be
-- changed from a migration and apply only to tables supabase_admin creates.
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables
  from anon, authenticated;
