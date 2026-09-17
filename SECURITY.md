# Security model

This document describes how doc-intake keeps tenants apart, why the database is set up the way it is, what has been tested and what hasn't. It reflects the schema as of migration `20260917000009` and the checks run when that migration was applied. Anything described as "verified" below was checked against the linked Supabase project at that time; anything not marked that way is design intent, not a tested guarantee.

No vulnerability disclosure process exists yet.

## Contents

- [Trust boundaries](#trust-boundaries)
- [Tenant isolation model](#tenant-isolation-model)
- [RLS helper functions](#rls-helper-functions)
- [Storage and the upload flow](#storage-and-the-upload-flow)
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
| Table and column grants (API auto-exposure is off) | Decide which tables and columns the Data API can read or write. On `documents` a client can insert only `tenant_id` and `filename` and update only `filename` | **Yes** |
| `memberships_keep_an_owner` trigger | Stops any change that would leave a tenant with no owner, from any role or path | **Yes**, as an invariant guard |
| RLS policies on `storage.objects` for the `documents` bucket | Decide which files a user can read, create or delete. There is no update policy at all | **Yes** |
| Generated column `documents.storage_path` | Every row's path is `<tenant_id>/<id>`; clients can't supply or change it | Yes, as a data integrity guard |
| `documents_keep_row_while_file_exists` trigger | Refuses deleting a row while its object exists, from any role | Yes, as an invariant guard |
| `public.complete_document_upload` | The only path that sets `size_bytes`, `mime_type` and moves a row out of `uploading`; checks uploader, membership, status and the object | **Yes** |
| Bucket `file_size_limit` and `allowed_mime_types` | 10 MB; `application/pdf`, `image/png`, `image/jpeg`, by declared `Content-Type` | Partly: size yes, type only as declared |
| `requireUser()` in pages and Server Actions (`src/lib/auth.ts`) | Redirects unauthenticated users; verifies the JWT with `getClaims()` | Authentication only. The app never filters by tenant for security; `/app` queries `tenants` with no filter and relies on RLS |
| `src/proxy.ts` | Refreshes the session cookie | **No.** It makes no authorization decisions |

A bug in the Next.js layer could leak data only by leaking a user's own session. It cannot widen what that session is allowed to read, because every query goes through RLS.

## Tenant isolation model

- `tenants` holds organizations. `memberships` links `auth.users` to tenants with a role: `owner`, `admin` or `member`.
- Every tenant-scoped table carries a non-null `tenant_id` with `on delete cascade` to `tenants`, and has RLS enabled with policies that call the helper functions below.
- A tenant is created only through `public.create_tenant(name, slug)`, which inserts the tenant and the caller's `owner` membership in one transaction. There is no insert policy or grant on `tenants`, so there is no other path to create one.

Current policies (after migration `000009`):

| Table | Select | Insert | Update | Delete |
|---|---|---|---|---|
| `tenants` | member | none (RPC only) | admin | none (RPC only) |
| `memberships` | member of that tenant | admin; granting `owner` requires owner | admin, not on own row; touching an `owner` row before or after requires owner | admin; removing an `owner` row requires owner |
| `documents` | member | member, `uploaded_by` = caller, `status` = `uploading` (only `tenant_id` and `filename` are grantable) | uploader or admin, still a member (only `filename` is grantable) | admin, and the trigger refuses while the object exists |
| `storage.objects` (bucket `documents`) | member of the path's tenant | a `documents` row exists at exactly this path, uploaded by the caller, still `uploading`, caller still a member | **none** | admin |

"Admin" means `owner` or `admin` throughout (`private.is_tenant_admin`).

## RLS helper functions

`private.is_tenant_member(tenant_id)`, `private.is_tenant_admin(tenant_id)` and `private.is_tenant_owner(tenant_id)` each return whether the **calling user** (`auth.uid()`) has a membership in that tenant with a given role. `private.can_upload_document_file(name)` (`000009`) answers the storage insert policy: does a `documents` row exist at exactly this path, uploaded by the caller, still `uploading`, in a tenant the caller is still a member of. Two trigger functions, `private.enforce_tenant_has_owner` and `private.refuse_document_delete_while_file_exists`, are also definer with `EXECUTE` revoked from everyone.

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
| `public.complete_document_upload(id)` | Caller must be signed in, must be the row's uploader and still a member; the row must be `uploading`; the object must exist with metadata. Locks the row (`for update`) so two completions can't both pass. Missing and not-mine return the same `42501` so the RPC can't probe ids | Writes `size_bytes`, `mime_type` and `status`, which no client has a grant on, and reads `storage.objects` |

As of `000009` the security advisor reports five warnings (verified with `npx supabase db advisors --linked`): 0029 for each of these four functions, which is expected and accepted, and **leaked password protection disabled** (see [Auth configuration](#auth-configuration)).

Two other functions in `public` keep the default `PUBLIC` execute grant:

- `storage_tenant_id(text)` is invoker-rights and pure (it parses a string). Anyone can call it over RPC, but it reads no data.
- `set_updated_at()` returns `trigger` and can't be called directly.

## Storage and the upload flow

- The bucket `documents` is private (`public = false`, verified), limited to **10 MB** and to `application/pdf`, `image/png`, `image/jpeg` (`000009`, verified after push).
- **Path convention:** every object lives at `<tenant_id>/<document_id>`, the row's generated `storage_path`. The first folder segment decides which tenant the object belongs to.
- All storage policies are scoped to `bucket_id = 'documents'`. Select and delete call `private.is_tenant_member` / `private.is_tenant_admin` on `public.storage_tenant_id(name)`; insert calls `private.can_upload_document_file(name)`.
- **Why `storage_tenant_id` exists.** Policies on `storage.objects` are evaluated against rows from every bucket, and Postgres doesn't guarantee that `bucket_id = 'documents'` is evaluated first. A direct `(storage.foldername(name))[1]::uuid` cast would raise an error on any object anywhere whose first folder isn't a uuid. `storage_tenant_id` returns `null` in that case, so the membership check just returns false. An object with no folder at all also yields `null`.

### Row first

Since `000009` an upload is three steps, and each is enforced by the database rather than the app:

1. **The row.** A Server Action inserts into `documents` with only `tenant_id` and `filename`. The insert grant covers nothing else, so `uploaded_by` (`auth.uid()`), `status` (`uploading`) and timestamps are defaults, and `storage_path` is a **generated column**, `tenant_id || '/' || id`. A client that sends `storage_path` gets `428C9` (can't insert into a generated column); one that sends `status`, `size_bytes`, `mime_type` or `uploaded_by` gets `42501`. The insert policy additionally requires membership, `uploaded_by = auth.uid()` and `status = 'uploading'`.
2. **The bytes.** The browser uploads straight to Storage with the user's session, `upsert: false`, `cacheControl: "0"`. File bytes never pass through a Server Action (1 MB body limit). The storage insert policy accepts the object only if a `documents` row exists at exactly that path, was uploaded by the caller, is still `uploading`, and the caller is still a member. **No file without a row.** There is no update policy on `storage.objects`, so nothing can be overwritten (`upsert` is insert‑on‑conflict‑update and needs update rights) or moved. A second upload to an existing path fails on the unique object name.
3. **Confirmation.** `complete_document_upload(id)` verifies uploader, membership, status and the object's existence, then copies `size` and `mimetype` from `storage.objects.metadata` into the row and sets `pending`. `size_bytes` and `mime_type` are therefore what Storage stored, never what the client claimed. A check constraint (`documents_completed_have_metadata`) keeps both non-null for any status other than `uploading`.

**Deletion** is admin-only for both the object and the row, in that order. `documents_keep_row_while_file_exists` refuses a row delete (`55000`) while the object exists, for every role. Together with "no file without a row" this means every object under a tenant's prefix is always reachable through a row an admin can see, so `delete_tenant`'s refusal while files remain can always be cleared by an admin; no orphan can block it.

**Rename** (`filename`, the only grantable update) is allowed for the row's uploader or a tenant admin, both still members. `filename` is checked to 1–255 characters, not blank, no control characters. Documents belong to the tenant: `uploaded_by` is nullable with `on delete set null`, so deleting the uploader's account leaves the row and file in place (tested).

**Download** in the app is a signed URL created on click with a 60 second expiry and `Content-Disposition: attachment`, never rendered into the page.

### What the generated column does and doesn't guarantee

`storage_path` replaced the old check constraint (`split_part(storage_path, '/', 1) = tenant_id::text`). Since the value is computed from the row, a row can't reference another tenant's folder, another row's file, or an unnormalized path; the previous concerns about `..` segments and rows pointing at unrelated files in the same tenant no longer apply.

It still does **not** guarantee that the object exists. A row can sit in `uploading` forever (see [Known gaps](#known-gaps-in-the-current-design)). Any component that reads files with elevated credentials must still fetch by the row's `storage_path` and treat a missing object as "not uploaded", not as an error to work around.

### Deleted files and the CDN cache

Found while testing admin deletion. Supabase serves the authenticated download endpoint (`/storage/v1/object/<bucket>/<path>`, which `storage.download()` uses) through Cloudflare, and Cloudflare cached the response (`cf-cache-status: HIT`) even with `Cache-Control: public, max-age=0`. After the object was deleted, the **same session** that had downloaded the file before kept receiving the cached bytes for up to about 30 seconds (observed 200/HIT at +0, +5 and +15 s and 400 at +30 s, over one run). Anonymous requests, a bogus bearer token and other users got 400 throughout, so the cache entry is keyed to the requester's credentials and this is not a cross-tenant leak. With the default `cacheControl` of 3600 the window may be up to an hour. The object index (list, `createSignedUrl`) reflects the deletion immediately, so no new signed URL can be minted once the object is gone. The test therefore asserts deletion through the index, not through `download()`. The Supabase client offers no way to send `no-store`.

**Signed URLs that already exist are affected too.** Measured once (probe, not a permanent test): A minted two 60 second signed URLs, fetched one of them, then an admin deleted both objects and rows. The URL that had been fetched kept returning the file as a Cloudflare `HIT` at every sample (every 5 seconds from +2 s to +56 s after the delete) and only started failing at +61 s, when the token expired. The URL that had never been fetched failed immediately after the delete (`400`, `cf-cache-status: BYPASS`), and minting a new URL failed with "Object not found". So the rule is: a signed URL that has been used once is served from the edge for the rest of its lifetime regardless of the object's state, and only its expiry ends that. That is why the app uses a 60 second expiry, and why deletion should be treated as taking effect up to 60 seconds later for anyone who already had a link.

### Other storage behavior to be aware of

- **Supabase's `storage.protect_delete` trigger blocks deleting from `storage.objects` in SQL** (verified). `delete_tenant` therefore refuses while files remain under the prefix, rather than orphaning them where no member could reach them. Callers must remove files through the Storage API first.
- **The bucket's MIME list checks the declared `Content-Type`, not the bytes.** A client can upload anything as `application/pdf`. The extraction unit must verify magic bytes before anything reaches a model.
- **Signed URLs are bearer tokens.** Removing a user from a tenant does not revoke signed URLs they already generated; those stay valid until they expire. The app uses a 60 second expiry. Not tested.
- **Storage `remove()` reports success with nothing removed** when RLS hides the object. The app's delete action relies on the row delete's trigger to surface a file that is still there.

## Grants

API auto-exposure is off for this project, so `select`, `insert`, `update` and `delete` on a table are unreachable through the Data API until granted explicitly. The migrations grant these to `authenticated` only:

| Table | Data API privileges granted to `authenticated` |
|---|---|
| `tenants` | `select`, `update` (whole table) |
| `memberships` | `select`, `insert`, `delete`, `update (role)` |
| `documents` | `select`, `delete`, `insert (tenant_id, filename)`, `update (filename)` |

`anon` has no privileges of any kind on these tables, and `authenticated` holds only the privileges in the table above (verified from the ACLs after `000009`, and anonymous access to every table, RPC and the bucket is now tested).

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
- **Inserts are whole-table on `memberships`.** An admin can choose `created_at` on a membership row. (`documents` inserts are column-scoped since `000009`: `status`, `size_bytes`, `mime_type`, `uploaded_by` and timestamps can't be supplied, and `status` can't be updated by anyone but `complete_document_upload`.)

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

**Setup.** It signs up three users once per run and reuses them: A, B and D.

- A creates tenant A and tenant C; B creates tenant B.
- A uploads and completes a PDF in tenant A through the row-first flow.
- A adds B and D to tenant C as `member`s. D uploads and completes a document in C.

Tests within the file are order-dependent: B is promoted to admin of C part-way through and removed at the end, and D deletes their own account.

**Assertions (39 tests):**

- **Rows.** B's select on tenant A, its memberships and documents returns nothing; B's unfiltered `tenants` query returns exactly B and C; B's insert into tenant A fails `42501`; B's update and delete of A's document affect zero rows; B can't rename tenant A; B's `delete_tenant` on A fails `42501`.
- **Document rows.** Inserting `status`, `size_bytes`, `mime_type` or `uploaded_by` fails `42501` and `storage_path` fails `428C9`; the filename check rejects empty, blank, 256-character and control-character names (`23514`) and accepts 255; `storage_path` is exactly `<tenant_id>/<id>` and a new row starts as `uploading` with null size and type; updating `status` fails `42501` while renaming works.
- **Upload flow.** A completed upload's `size_bytes` equals the blob's byte count and `mime_type` is `application/pdf`; upload is refused with no matching row and for a different member of the same tenant; re-upload and upsert to an existing path are refused; the bucket rejects `text/plain` and a 10 MB + 1 byte PDF, after which the row can't be completed (`55000`); completion is refused for a non-uploader (`42501`), a row already `pending` (`55000`), a row with no object (`55000`) and an unknown id (`42501`).
- **Storage under A's prefix.** B can't list, download or sign; can't upload a new file; can't overwrite, move or delete A's file.
- **Rename and delete.** A member can't rename someone else's document while the uploader (a plain member) and the owner can; a member can't delete a file or a row; an owner can't delete a row while its file exists (`55000`).
- **Roles.** The five escalation tests plus the last-owner test.
- **Admin and removal.** An admin can rename someone else's document and can delete the file, then the row (asserted through the object index); a removed member can't upload to or complete their old rows and no longer sees C's rows or files.
- **Account deletion.** D deletes their account; the owner still sees D's document with `uploaded_by` null and can download it.
- **Guards.** `delete_tenant` refuses while a file remains (`55000`); `delete_own_account` refuses while the caller owns a tenant (`55000`).
- **Auth.** A direct `auth.signUp` with a 14 character password is rejected with `weak_password`; if it were accepted, the test deletes the account and fails.
- **Anonymous.** No session can read any table (`42501`), call any of the four RPCs (`42501`), or list, download or sign in the bucket.

Every "cannot" assertion is paired with a control that reads the data back as an authorized user and checks it is unchanged.

**Cleanup.** `afterAll` runs even when tests fail: removes files through the Storage API as each tenant's owner, calls `delete_tenant` for each tenant, then `delete_own_account` for each user still present. It collects every error and fails the run if any step didn't succeed.

**Last result.** 39 of 39 passed after the password minimum was re-saved (about 24 seconds); the 38 tests that predate the password test had passed on two consecutive runs after `000008` and `000009` were applied. After each run a SQL query confirmed zero test users in `auth.users`, zero test tenants, zero `documents` rows and zero objects in the bucket. The same query after earlier failing runs also showed zero leftovers.

### How to run it

1. Apply all migrations to the target project: `npx supabase db push`.
2. Turn off email confirmation on that project, since the test needs a session straight from sign-up.
3. Copy `.env.test.example` to `.env.test` and set `SUPABASE_TEST_URL` and `SUPABASE_TEST_PUBLISHABLE_KEY`. Tests read only `SUPABASE_TEST_*` variables, so they can't pick up `.env.local`. Never put a service role key there; the point is to exercise RLS as a signed-in user.
4. Run `npm test`. Each run makes three sign-ups, which count toward Supabase Auth's sign-up rate limit.

See the README section "Tenant isolation test" for details.

### What the test does not prove

- **Anything outside the listed operations.** Specifically untested:
  - a plain member updating their own tenant
  - a member deleting memberships
  - an admin granting `owner` to a different user; an admin changing `user_id` or `tenant_id` on a membership
  - a non-owner admin calling `delete_tenant`
  - storage objects with malformed paths or in other buckets
  - signed URLs after membership removal, and the CDN cache window for a removed member
  - the concurrent last-owner case and two concurrent completions of one row
- **Other API surfaces.**
  - **GraphQL:** `pg_graphql` is not installed on the linked project (verified at `000007`).
  - **Realtime:** no tables are in the `supabase_realtime` publication (verified at `000007`), so changes are not broadcast. Neither surface has tests; if either is enabled later, it needs its own review.
- **The Next.js app.** There are no automated tests for the app layer. The upload, download and delete UI was built against the tested database rules but has not been exercised end to end with a browser. `/auth/confirm` has never run successfully, because email confirmation is off.
- **That it stays true.** The test isn't run in CI (there is no CI). It is point-in-time evidence against one project, and a later migration could break isolation without anyone noticing unless the test is run again.
- **Isolation in a separate project.** It runs against the same project the app uses, not a dedicated test project.

## Auth configuration

Auth settings live in the Supabase dashboard, not in this repo. `supabase/config.toml` only configures a local stack, which isn't used. What is known about the linked project:

- **Email confirmation is off** so the isolation test can get a session straight from sign-up. Anyone can create an account with an email address they don't control, and then create tenants.
- **Minimum password length is 15**, enforced by Supabase, not just the form: the test `Supabase itself rejects a password shorter than 15 characters` calls `auth.signUp` directly with 14 characters and expects `weak_password`. It failed on 2026-09-17 because the dashboard setting hadn't been saved (the account it created was removed by the test), and passed once the setting was re-saved the same day. Supabase caps passwords at 72 characters (bcrypt). The sign-up form enforces both before submitting and shows Supabase's `weak_password` reasons when the server rejects one.
- **Leaked password protection is off** (security advisor warning). It requires a paid plan, so passwords are not screened against known breaches.
- **Other auth settings haven't been reviewed.** MFA and auth rate limits on the project haven't been checked. The app implements no MFA.
- **Tests share the production project.** The test suite and the app use one project. A dedicated test project would allow re-enabling email confirmation for real users.

## Known gaps in the current design

These are flaws or sharp edges in what exists today, as distinct from the unbuilt features in the next section. The upload-side gaps listed here before `000009` (files without rows, client-reported size and type, members overwriting each other's files, clients choosing `status` or `storage_path`, no bucket limits) are closed and covered by tests.

- **The 60 second signed URL window.** A download link is a bearer token. Anyone who obtains it within 60 seconds can fetch the file without a session, removing a member does not revoke links they already minted, and a link that has been fetched once keeps serving the file from the CDN cache until it expires even after the file is deleted (measured, see [Deleted files and the CDN cache](#deleted-files-and-the-cdn-cache)). The link is never written into the page, only handed to the browser on click.
- **`uploading` rows that never complete.** If the browser fails between creating the row and calling `complete_document_upload` (closed tab, rejected file, network error), the row stays in `uploading` with no file, visible to members with a disabled download button. Only an admin can delete it. Nothing sweeps them, nothing limits how many a member can create, and a bucket-rejected file still leaves one behind.
- **Deleted files linger in the CDN cache for the session that fetched them**, for up to about 30 seconds with `cacheControl: "0"` and up to an hour with the client default. See [Deleted files and the CDN cache](#deleted-files-and-the-cdn-cache). Not reachable by other users or anonymously.
- **No breached-password screening.** Leaked password protection needs a paid plan, so a 15-character password from a known breach is accepted.
- **MIME type is declared, not detected.** The bucket checks `Content-Type`; nothing inspects file bytes. The extraction unit must verify magic bytes before anything reaches a model.
- **A removed member's JWT stays valid for up to an hour.** Every database and storage request re-checks membership, so they can't read, upload or complete anything (tested), but the CDN window above applies to files they had already fetched.
- **Admins can rename any document in their tenant**, not just their own. This is by design (uploader or admin) but worth knowing.
- **Deletion is hard and irreversible.** `delete_tenant` cascades to memberships and documents immediately, with no soft delete or grace period. `delete_own_account` deletes the `auth.users` row. Recovery depends on whatever backups the Supabase plan provides. Both functions were added so the test could clean up without the service role, and they are now live features.
- **Slug collisions reveal that a slug exists.** `create_tenant` returns a unique violation for a slug already taken by any tenant, including ones the caller can't see.
- **Members see other members' user ids**, and each document's `uploaded_by`. Emails are not exposed, since `auth.users` isn't readable.

## Deliberately not yet implemented

These are known, intentionally deferred, and should not be assumed to exist.

- **Per-tenant storage quota.** The bucket caps each file at 10 MB, but nothing caps how many files or bytes a tenant stores.
- **Content inspection.** The declared type is enforced; the bytes are not examined. The extraction unit will verify magic bytes before any model call.
- **Per-tenant rate limiting.** Nothing limits how often a user or tenant can create tenants, upload files, insert rows or call RPCs. The only limits are Supabase's project-level defaults, which have not been reviewed.
- **LLM spend ceilings.** No extraction pipeline exists yet. When one is added, nothing in the current design bounds model usage or cost per tenant. Combined with the lack of upload limits and rate limiting, a single tenant could drive unbounded spend.
- **Audit logging.** There is no application audit log. Membership and role changes, tenant and account deletion, document changes and file access are not recorded anywhere this repo controls. `pgaudit` is not installed (verified). Supabase's platform logs are the only record, subject to the plan's retention.
