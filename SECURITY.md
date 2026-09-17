# Security model

This document describes how doc-intake keeps tenants apart, why the database is set up the way it is, what has been tested and what hasn't. It reflects the schema as of migration `20260917000007` and the checks run when that migration was applied. Anything described as "verified" below was checked against the linked Supabase project at that time; anything not marked that way is design intent, not a tested guarantee.

No vulnerability disclosure process exists yet.

## Contents

- [Trust boundaries](#trust-boundaries)
- [Tenant isolation model](#tenant-isolation-model)
- [RLS helper functions](#rls-helper-functions)
- [Storage](#storage)
- [Grants](#grants)
- [Admin self-promotion escalation (found and fixed)](#admin-self-promotion-escalation-found-and-fixed)
- [Isolation test](#isolation-test)
- [Auth configuration](#auth-configuration)
- [Known gaps in the current design](#known-gaps-in-the-current-design)
- [Deliberately not yet implemented](#deliberately-not-yet-implemented)

## Trust boundaries

The browser and the Next.js server both talk to Supabase with the **publishable key plus the signed-in user's JWT**. No service role or secret key is used anywhere in `src/`, `tests/` or the env templates (checked by grepping the repo). This means every read and write from the app runs as the Postgres `authenticated` role, subject to row-level security.

The authoritative enforcement point is therefore the database, not the Next.js app:

| Layer | What it does | Is it a security boundary? |
|---|---|---|
| Postgres RLS policies on `tenants`, `memberships`, `documents` | Decide which rows a user can see or change | **Yes** |
| Table and column grants (API auto-exposure is off) | Decide which tables and columns the Data API can read or write | **Yes** |
| `memberships_keep_an_owner` trigger | Stops any change that would leave a tenant with no owner, from any role or path | **Yes**, as an invariant guard |
| RLS policies on `storage.objects` for the `documents` bucket | Decide which files a user can read or write | **Yes** |
| Check constraint on `documents.storage_path` | Keeps a document row pointing into its own tenant's folder | Yes, as a data integrity guard |
| `requireUser()` in pages and Server Actions (`src/lib/auth.ts`) | Redirects unauthenticated users; verifies the JWT with `getClaims()` | Authentication only. The app never filters by tenant for security; `/app` queries `tenants` with no filter and relies on RLS |
| `src/proxy.ts` | Refreshes the session cookie | **No.** It makes no authorization decisions |

A bug in the Next.js layer could leak data only by leaking a user's own session. It cannot widen what that session is allowed to read, because every query goes through RLS.

## Tenant isolation model

- `tenants` holds organizations. `memberships` links `auth.users` to tenants with a role: `owner`, `admin` or `member`.
- Every tenant-scoped table carries a non-null `tenant_id` with `on delete cascade` to `tenants`, and has RLS enabled with policies that call the helper functions below.
- A tenant is created only through `public.create_tenant(name, slug)`, which inserts the tenant and the caller's `owner` membership in one transaction. There is no insert policy or grant on `tenants`, so there is no other path to create one.

Current policies (after migration `000004`):

| Table | Select | Insert | Update | Delete |
|---|---|---|---|---|
| `tenants` | member | none (RPC only) | admin | none (RPC only) |
| `memberships` | member of that tenant | admin; granting `owner` requires owner | admin, not on own row; touching an `owner` row before or after requires owner | admin; removing an `owner` row requires owner |
| `documents` | member | member, and `uploaded_by` must equal the caller | member | admin |
| `storage.objects` (bucket `documents`) | member of the path's tenant | member | member | admin |

"Admin" means `owner` or `admin` throughout (`private.is_tenant_admin`).

## RLS helper functions

`private.is_tenant_member(tenant_id)`, `private.is_tenant_admin(tenant_id)` and `private.is_tenant_owner(tenant_id)` each return whether the **calling user** (`auth.uid()`) has a membership in that tenant with a given role.

### Why SECURITY DEFINER

The `memberships` policies need to ask "is the caller a member of this tenant?", which means querying `memberships` from inside a policy on `memberships`. As a normal (invoker) function, that query is itself subject to the same policy, which calls the function again, and Postgres fails with `infinite recursion detected in policy`.

As `SECURITY DEFINER`, the function runs as its owner, `postgres`. `postgres` owns the tables and has `BYPASSRLS` (verified), so the lookup inside the function is not filtered by RLS and doesn't recurse.

The cost is that the function body runs with elevated privileges. That's acceptable only because each helper is narrow: it takes one tenant id, reads only the caller's own membership row, and returns a boolean.

### Why an empty search_path

A `SECURITY DEFINER` function that resolves names through the caller's `search_path` can be tricked into using objects the caller controls, running the caller's code with the owner's privileges.

Every definer function in this repo sets `search_path = ''` and schema-qualifies every name (`public.memberships`, `auth.uid()`, `private.is_tenant_owner`):

- Functions, operators and types resolve only from `pg_catalog`, which the caller can't modify.
- An unqualified name fails loudly instead of resolving somewhere unexpected.
- All relations are qualified, so a temporary table can't shadow them.

New definer functions must follow the same pattern.

### Why the private schema

PostgREST exposes every function in an exposed schema (`public`, `graphql_public`) as `POST /rest/v1/rpc/<name>`. By default Postgres grants `EXECUTE` on new functions to `PUBLIC`.

When the helpers lived in `public`, both `anon` and `authenticated` could call them over HTTP. The Supabase security advisor flagged this (lints 0028 and 0029). The practical leak was small: the helpers only answer questions about the caller's own membership, and `anon` always gets `false`. Still, a definer function with no reason to be public shouldn't be.

Migration `000003` moved the helpers into `private`, which PostgREST doesn't expose:

- It used `ALTER FUNCTION ... SET SCHEMA`. Policies reference functions by OID, so all existing policies kept working without being recreated. Verified afterwards: 14 policies referenced `private.`.
- It revoked `EXECUTE` from `PUBLIC` and `anon`.
- `authenticated` keeps `EXECUTE` and `USAGE` on `private`, because policies are evaluated as the calling role. Revoking it would make every policy fail.

The same migration also revoked `EXECUTE` on `public.rls_auto_enable()`. That's a Supabase-managed event trigger function, not from these migrations, and it doesn't need to be callable directly.

### SECURITY DEFINER functions that are intentionally public

These are RPCs the app or test calls. Each performs its own authorization check, since RLS doesn't apply inside it.

| Function | Check inside the function | Why definer |
|---|---|---|
| `public.create_tenant(name, slug)` | Caller must be signed in | Creates the tenant and the owner membership; no user has insert rights on `tenants`, and a new user can't pass the admin-only memberships insert policy |
| `public.delete_tenant(tenant_id)` | Caller must be an owner; refuses while files exist under the tenant's storage prefix | No user has delete rights on `tenants` |
| `public.delete_own_account()` | Caller must be signed in and must not own any tenant | Deleting from `auth.users` needs owner privileges |

As of `000007` the security advisor reports four warnings: 0029 for each of these three functions, which is expected and accepted, and **leaked password protection disabled** (see [Auth configuration](#auth-configuration)).

Two other functions in `public` keep the default `PUBLIC` execute grant:

- `storage_tenant_id(text)` is invoker-rights and pure (it parses a string). Anyone can call it over RPC, but it reads no data.
- `set_updated_at()` returns `trigger` and can't be called directly.

## Storage

- The bucket `documents` is private (`public = false`, verified).
- **Path convention:** every object lives under `<tenant_id>/...`, and the first folder segment decides which tenant the object belongs to.
- All four storage policies are scoped to `bucket_id = 'documents'` and call `private.is_tenant_member` or `private.is_tenant_admin` on `public.storage_tenant_id(name)`.
- **Why `storage_tenant_id` exists.** Policies on `storage.objects` are evaluated against rows from every bucket, and Postgres doesn't guarantee that `bucket_id = 'documents'` is evaluated first. A direct `(storage.foldername(name))[1]::uuid` cast would raise an error on any object anywhere whose first folder isn't a uuid. `storage_tenant_id` returns `null` in that case, so the membership check just returns false. An object with no folder at all also yields `null`.

### The storage_path check constraint

```sql
storage_path text not null unique
  check (split_part(storage_path, '/', 1) = tenant_id::text)
```

A `documents` row can only reference a path inside its own tenant's folder. Without this constraint, a member of tenant B could insert a row in tenant B whose `storage_path` names a file in tenant A. The row would pass RLS, since the row belongs to B.

With the user's own session that isn't directly exploitable, because storage RLS would still refuse the download. But any future component that fetches files with elevated credentials and trusts `storage_path`, such as an extraction worker, would be steered across tenants. The constraint closes that at the data layer.

What the constraint does **not** guarantee:

- **That the object exists.** Nothing links a row to a real object.
- **That the object "belongs" to this row.** A row can reference any other file in the same tenant; `unique` only stops two rows sharing a path.
- **That the path is normalized.** Only the first segment is compared, so a value like `<tenantA>/../<tenantB>/x` passes. Storage RLS evaluates the real object name, so this matters only to code that resolves `storage_path` itself with elevated credentials. Such code must reject `..` segments or fetch through the user's session.
- **That every file has a row.** Members can upload through the Storage API directly without creating a `documents` row.

### Other storage behavior to be aware of

- **Members can overwrite any object in their tenant's folder** (update policy is member-level), including files uploaded by other members. Only deletion is admin-only.
- **Supabase's `storage.protect_delete` trigger blocks deleting from `storage.objects` in SQL** (verified). `delete_tenant` therefore refuses while files remain under the prefix, rather than orphaning them where no member could reach them. Callers must remove files through the Storage API first.
- **Signed URLs are bearer tokens.** Removing a user from a tenant does not revoke signed URLs they already generated; those stay valid until they expire. Not tested.

## Grants

API auto-exposure is off for this project, so `select`, `insert`, `update` and `delete` on a table are unreachable through the Data API until granted explicitly. The migrations grant these to `authenticated` only:

| Table | Data API privileges granted to `authenticated` |
|---|---|
| `tenants` | `select`, `update` (whole table) |
| `memberships` | `select`, `insert`, `delete`, `update (role)` |
| `documents` | `select`, `insert`, `delete`, `update (filename, status)` |

`anon` has no privileges of any kind on these tables, and `authenticated` holds only the privileges in the table above (verified from the table ACLs after `000007`).

**Leftover default privileges (revoked in `000006`).** Turning off auto-expose removed `select`/`insert`/`update`/`delete` from Supabase's default privileges but left `TRUNCATE`, `REFERENCES`, `TRIGGER` and `MAINTAIN` for `anon`, `authenticated` and `service_role` on every table. PostgREST can't issue those statements, so nothing could reach them, but `TRUNCATE` ignores RLS and `MAINTAIN` includes `LOCK TABLE`. They would have become reachable if anything ever let these roles run arbitrary SQL.

Migration `000006`:

- revokes all four from `anon` and `authenticated` on `tenants`, `memberships` and `documents`
- changes `postgres`'s default privileges for new tables in `public` so future tables don't get them. Migrations run as `postgres`, and before this change every new table picked them up again.

Verified after applying: `postgres`'s default table privileges in `public` now grant nothing to `anon` or `authenticated`.

What `000006` doesn't cover:

- **`service_role` keeps the four privileges.** It already bypasses RLS and isn't used by the app or tests.
- **Supabase's `supabase_admin` default privileges are unchanged.** A migration can't alter them. They still grant everything to `anon` and `authenticated`, but only for tables that `supabase_admin` creates, not for tables created by these migrations.
- **Other schemas are untouched,** such as the `postgres` default privileges in `storage`.

**Why updates are column-scoped.** RLS `WITH CHECK` validates the row after an update, but it validates it against the policy, not against the row's previous values. With a whole-table update grant:

- On `documents`, a member of two tenants could move a document between them by rewriting `tenant_id` (both old and new rows pass the member check). A member could also rewrite `uploaded_by` or `storage_path` after insert.
- On `memberships`, an admin could re-point a membership row to a different `user_id`, or move it to another tenant where they are also admin.

Column-scoped grants make those columns immutable to the API after insert. They're rejected by privilege checks before RLS is consulted.

**Where grants are not column-scoped, and what that allows:**

- **`tenants` update is whole-table.** Admins can change `name`, `slug` and `created_at`. Changing `id` fails in practice because `memberships` references it with no `on update cascade`, but nothing explicitly forbids it.
- **Inserts are whole-table on `memberships` and `documents`.** On insert, a member can set `status` to any value (for example `extracted`) and choose `created_at` and `updated_at`. `uploaded_by` is pinned to the caller by the insert policy.
- **`documents.status` is updatable by any member.** Once an extraction pipeline exists, a member could mark a document as extracted or reviewed without it being processed. Status should probably become writable only by the pipeline.

## Admin self-promotion escalation (found and fixed)

**The flaw.** Migration `000001` created:

```sql
create policy memberships_update_admin on public.memberships
  for update to authenticated
  using (public.is_tenant_admin(tenant_id))
  with check (public.is_tenant_admin(tenant_id));

grant select, insert, update, delete on public.memberships to authenticated;
```

Any `admin` could update any membership row in their tenant, including their own and the owner's. Concretely, an admin could:

- promote themselves to `owner`
- demote or delete the real owner (the delete policy had the same shape), taking over the tenant
- rewrite `user_id` or `tenant_id` on membership rows, because the update grant covered every column
- grant `owner` to anyone through the insert policy

**How it was found.** By reading the policies while planning the isolation test, not by a failing test and not from an incident. The flaw was live on the linked project from `000001` until `000004` was applied. When `000004` was applied the project had one non-test user in `auth.users`; nobody has checked whether the flaw was ever exercised.

**The fix, migration `000004`:**

- **Nobody can change their own role.** The update policy's `using` and `with check` both require `user_id <> auth.uid()`.
- **Only owners can create, change or remove an `owner` membership.** A new helper, `private.is_tenant_owner`, backs this.
  - The update policy requires `role <> 'owner' or is_tenant_owner(tenant_id)` in both `using` (the row before the update) and `with check` (the row after). That covers both demoting an owner and promoting someone to owner.
  - The insert and delete policies carry the same owner condition.
- **Only `role` is updatable.** `revoke update` then `grant update (role)`.
- **Admins can still manage `member` and `admin` memberships of other users.** Two admins can't combine to reach `owner`, because granting `owner` requires already being one.

**Test coverage of the fix** (all passing, see below):

- a member cannot raise their own role to `admin` or `owner`
- an admin cannot promote themselves to `owner`
- an admin cannot demote or remove the owner
- an admin cannot insert an `owner` membership. The test inserts a row for the admin themselves. RLS `with check` runs before unique indexes, so the `42501` comes from the policy, not the `(tenant_id, user_id)` unique constraint.
- a non-member cannot add themselves to another tenant

**Not covered by tests:**

- an admin granting `owner` to a *different* user
- an admin trying to change `user_id` or `tenant_id` (the column grant)
- owner-to-owner operations
- admins managing other admins, which is allowed by design

### Last-owner guard (migration `000007`)

`000004` stopped anyone from changing their own role, but a tenant could still end up with no owner:

- a sole owner could delete their own membership, which passes the delete policy
- two owners could remove or demote each other in concurrent transactions
- a non-API path could do the same: the dashboard, `service_role`, or deleting a user in `auth.users`, which cascades to their memberships

Policies can't prevent this. They evaluate one row at a time and can't see what concurrent transactions are doing.

`000007` adds a `before update or delete` trigger on `memberships`, `memberships_keep_an_owner`, backed by `private.enforce_tenant_has_owner()`. It is `SECURITY DEFINER` with an empty `search_path`, and `EXECUTE` is revoked from everyone but `postgres`.

1. It ignores any change that doesn't take an `owner` row out of its tenant.
2. For one that does, it locks the tenant row with `select ... for update`. Owner changes in the same tenant therefore run one at a time, and under `READ COMMITTED` each check sees removals already committed by the transaction that held the lock first.
3. If the tenant row no longer exists, the tenant is being deleted by `delete_tenant`'s cascade and the change is allowed.
4. Otherwise, if no other owner row remains, it raises `23514` "a tenant must keep at least one owner".

The trigger applies to every role, `service_role` and `postgres` included. **Deleting a user who is the sole owner of a tenant now fails, including from the Supabase dashboard.** Transfer ownership or delete the tenant first. `delete_own_account` already refused this case with its own error.

**Test coverage.** One test (below) checks that a sole owner can't demote themselves (refused by the update policy, zero rows) or delete their own membership (refused by the trigger with `23514`). The allowed cascade is exercised on every run, because cleanup's `delete_tenant` calls remove tenants whose only owner row goes with them.

**Not tested:**

- the concurrent case: two owners removing each other at the same moment. The locking argument above has been reasoned through, not exercised.
- an owner leaving when another owner remains, which should be allowed
- the trigger blocking a dashboard or `service_role` user deletion

## Isolation test

`tests/tenant-isolation.test.ts` (Vitest, `npm test`) runs against a real Supabase project using only the publishable key and real signed-in sessions.

**Setup.** It signs up user A and user B.

- A creates tenant A and tenant C; B creates tenant B.
- A uploads a file to `<tenantA>/` and inserts a matching `documents` row.
- A adds B to tenant C as a `member`.

**Assertions (15 tests):**

- **Rows.**
  - B's select on tenant A, its memberships and its documents returns nothing.
  - B's unfiltered `tenants` query returns exactly tenants B and C.
  - B's insert of a document with tenant A's `tenant_id` fails with `42501`.
  - B's update and delete of A's document affect zero rows.
  - B's rename of tenant A affects zero rows.
  - B's call to `delete_tenant` on tenant A fails with `42501`.
- **Storage under A's prefix.**
  - B can't list, download or create a signed URL.
  - B can't upload a new file.
  - B can't overwrite A's file (upload with `upsert`), move it into tenant B, or delete it.
- **Roles.** The five tests listed under the escalation fix, plus the last-owner test under [Last-owner guard](#last-owner-guard-migration-000007).

Every "cannot" assertion is paired with a control that reads the data back as A and checks it is unchanged. The test can't pass just because setup silently failed or the data was never there. Storage deletes by an unauthorized user return success with nothing removed, so the control read is the real assertion there.

**Cleanup.** `afterAll` runs even when tests fail:

1. Removes files through the Storage API.
2. Calls `delete_tenant` for each tenant.
3. Calls `delete_own_account` for each user.

It collects every cleanup error and fails the run if any step didn't succeed.

**Last result.** 15 of 15 passed after migrations `000006` and `000007` were applied. The 14 tests that predate the last-owner test had also passed on two consecutive runs after `000004` and `000005`. After each run a SQL query confirmed none of these remained: test users in `auth.users`, test tenants, test memberships, test documents, or objects in the `documents` bucket.

### How to run it

1. Apply all migrations to the target project: `npx supabase db push`.
2. Turn off email confirmation on that project, since the test needs a session straight from sign-up.
3. Copy `.env.test.example` to `.env.test` and set `SUPABASE_TEST_URL` and `SUPABASE_TEST_PUBLISHABLE_KEY`. Tests read only `SUPABASE_TEST_*` variables, so they can't pick up `.env.local`. Never put a service role key there; the point is to exercise RLS as a signed-in user.
4. Run `npm test`.

See the README section "Tenant isolation test" for details.

### What the test does not prove

- **Unauthenticated access.** No test uses the `anon` role against tables, RPCs or storage. The protection there rests on `anon` holding no privileges on the tables (verified from the ACLs), all policies being `to authenticated`, and `EXECUTE` revoked from `anon` on the definer functions. That has been read, not tested.
- **Anything outside the listed operations.** Specifically untested:
  - a plain member updating their own tenant
  - a member deleting memberships
  - the column-grant rejections (rewriting `tenant_id`, `storage_path` or `uploaded_by` on a document; `user_id` on a membership)
  - the `storage_path` check constraint
  - `delete_tenant` refusing while files exist, or refusing a non-owner admin
  - `delete_own_account` refusing while the caller owns a tenant
  - storage objects with malformed paths or in other buckets
  - signed URLs after membership removal
- **Other API surfaces.**
  - **GraphQL:** `pg_graphql` is not installed on the linked project (verified).
  - **Realtime:** no tables are in the `supabase_realtime` publication (verified), so changes are not broadcast. Neither surface has tests; if either is enabled later, it needs its own review.
- **The Next.js app.** There are no automated tests for the app layer.
  - The sign-up, sign-in, create-tenant and document-list flows have not been exercised end to end with a real user.
  - The only check run was an HTTP smoke test that unauthenticated requests to `/app` redirect to `/sign-in`.
  - `/auth/confirm` has never run successfully, because email confirmation is off.
- **That it stays true.** The test isn't run in CI (there is no CI). It is point-in-time evidence against one project, and a later migration could break isolation without anyone noticing unless the test is run again.
- **Isolation in a separate project.** It runs against the same project the app uses, not a dedicated test project.

## Auth configuration

Auth settings live in the Supabase dashboard, not in this repo. `supabase/config.toml` only configures a local stack, which isn't used. What is known about the linked project:

- **Email confirmation is off** so the isolation test can get a session straight from sign-up. Anyone can create an account with an email address they don't control, and then create tenants.
- **Leaked password protection is off** (security advisor warning).
- **Other auth settings haven't been reviewed.** Nobody has checked the password strength requirements, MFA or auth rate limits on the project. The app implements no MFA.
- **Tests share the production project.** The test suite and the app use one project. A dedicated test project would allow re-enabling email confirmation for real users.

## Known gaps in the current design

These are flaws or sharp edges in what exists today, as distinct from the unbuilt features in the next section.

- **Deletion is hard and irreversible.** `delete_tenant` cascades to memberships and documents immediately, with no soft delete or grace period. `delete_own_account` deletes the `auth.users` row. Recovery depends on whatever backups the Supabase plan provides. Both functions were added so the test could clean up without the service role, and they are now live features.
- **Slug collisions reveal that a slug exists.** `create_tenant` returns a unique violation for a slug already taken by any tenant, including ones the caller can't see.
- **Members see other members' user ids.** Every member of a tenant can list all memberships in it, including other users' `user_id`s. Emails are not exposed, since `auth.users` isn't readable.

## Deliberately not yet implemented

These are known, intentionally deferred, and should not be assumed to exist.

- **Upload limits.** The `documents` bucket has no `file_size_limit` (verified `null`), so only the project-wide storage limit applies, and that is set in the dashboard, not the repo. `documents.size_bytes` is client-reported and never compared to the stored object. There is no per-tenant storage quota.
- **MIME validation.** `documents.mime_type` is free text supplied by the client. The bucket has no `allowed_mime_types` (verified `null`). Nothing inspects file contents, so a file's declared type, extension and actual bytes can disagree.
- **Per-tenant rate limiting.** Nothing limits how often a user or tenant can create tenants, upload files, insert rows or call RPCs. The only limits are Supabase's project-level defaults, which have not been reviewed.
- **LLM spend ceilings.** No extraction pipeline exists yet. When one is added, nothing in the current design bounds model usage or cost per tenant. Combined with the lack of upload limits and rate limiting, a single tenant could drive unbounded spend.
- **Audit logging.** There is no application audit log. Membership and role changes, tenant and account deletion, document changes and file access are not recorded anywhere this repo controls. `pgaudit` is not installed (verified). Supabase's platform logs are the only record, subject to the plan's retention.
