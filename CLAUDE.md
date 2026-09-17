# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev      # Next.js dev server on http://localhost:3000
npm run build    # production build (also type-checks)
npm run lint     # ESLint 9 flat config (next core-web-vitals + typescript)

# Supabase CLI is a devDependency — run it through npx
npx supabase start                  # local stack: API :54321, Postgres :54322, Studio :54323, Inbucket :54324
npx supabase db reset               # drop local DB, re-apply every migration, then seed
npx supabase migration new <name>   # new timestamped file in supabase/migrations/

npm test                            # Vitest; tenant isolation test against the project in .env.test
npx vitest run -t "cannot upload"   # run tests whose name matches
```

`npm test` hits a real Supabase project with real sign-ups (see README "Tenant isolation test"): it needs `.env.test`, all migrations applied, and email confirmation off. It uses only the publishable key; keep it that way, since the point is to exercise RLS as a signed-in user.

## Stack

- Next.js 16 App Router under `src/app/`, React 19, Tailwind CSS v4 (via `@tailwindcss/postcss`, no `tailwind.config`). Import alias `@/*` → `src/*`.
- Per AGENTS.md, Next 16 differs from older versions: check `node_modules/next/dist/docs/` before writing Next code (e.g. middleware is now `proxy` — see `01-app/01-getting-started/16-proxy.md`; there's also a `02-guides/multi-tenant.md`).
- Supabase for Postgres + auth via `@supabase/ssr`. Use `createClient` from `src/lib/supabase/client.ts` in Client Components and the async one from `src/lib/supabase/server.ts` in Server Components, Server Functions and Route Handlers (a new client per request). `src/proxy.ts` refreshes the session on every request; server clients rely on it because Server Components can't write cookies. Auth checks use `requireUser()` / `getCurrentUser()` from `src/lib/auth.ts` (verified via `getClaims`) and are called in every protected page and Server Action, not in layouts or the proxy.
- Env: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, read in `src/lib/supabase/env.ts`. Copy `.env.example` to `.env.local`. Tests read only `SUPABASE_TEST_*` vars from `.env.test` (template: `.env.test.example`). `.env*` is gitignored except the two example files.
- `supabase/config.toml` points seeding at `supabase/seed.sql`, which doesn't exist yet. There is no Docker on the dev machine, so `npx supabase start` / `db reset` aren't usable here; validate migration SQL against the linked project inside a `begin; … rollback;` block via `npx supabase db query --linked -f file.sql` before `db push`. `db push` is gated: show the SQL and `--dry-run` output first.

## Multi-tenant data model

The core design lives in `supabase/migrations/20260917000001_tenants_and_memberships.sql`, and every future table is expected to follow it:

- `tenants` + `memberships` (user ↔ tenant with `tenant_role` enum: `owner` / `admin` / `member`).
- **Every new table carries `tenant_id`** and enables RLS with policies built on the helper functions `private.is_tenant_member(tenant_id)` and `private.is_tenant_admin(tenant_id)` (admin = owner or admin). They were created in `public` and moved to `private` by `20260917000003`, so older migrations still say `public.`. New code must use `private.`
- **Security definer functions go in `private`**, a schema the API doesn't expose, with `execute` revoked from `public, anon`. The only exception is a function meant to be called as an RPC, such as `create_tenant`. Otherwise the security advisor flags it (lints 0028/0029).
- Those helpers are `security definer` with `set search_path = ''` on purpose: a membership check inside a policy would otherwise re-enter RLS on `memberships` and recurse. Keep new security-definer functions the same way and fully schema-qualify names inside them.
- Tenants are created only via the `public.create_tenant(name, slug)` RPC, which atomically inserts the tenant and the caller's `owner` membership. There is deliberately no INSERT policy/grant on `tenants`. They're deleted only via the owner-only `public.delete_tenant(id)` RPC, which refuses while files remain under the tenant's storage prefix (SQL can't delete storage objects). `public.delete_own_account()` refuses while the caller still owns a tenant.
- Membership role rules (`20260917000004`): nobody changes their own role; only owners grant, change or remove the `owner` role; only `role` is updatable. `private.is_tenant_owner` backs this. A trigger (`memberships_keep_an_owner`, `20260917000007`) refuses any update or delete that would leave a tenant with no owner, for every role, including dashboard user deletion.
- Table auto-exposure is off, and `20260917000006` removed the leftover `truncate`/`references`/`trigger`/`maintain` defaults, so a new table is invisible to the API until you add explicit `grant ... to authenticated` statements (and `revoke execute ... from public, anon` / `grant execute ... to authenticated` for new RPCs), mirroring the end of that migration.
- Slugs must match `^[a-z0-9-]{3,48}$`.

## Documents and uploads (`20260917000008`, `20260917000009`)

Uploads are **row first**. Never send file bytes through a Server Action (1 MB body limit) and never let the client choose a path.

1. A Server Action inserts the `documents` row with **only `tenant_id` and `filename`**. The insert grant covers nothing else: `id`, `uploaded_by` (`auth.uid()`), `status` (`'uploading'`) and timestamps are defaults, and `storage_path` is a **generated column**, always `<tenant_id>/<id>`. Inserting `storage_path` fails with `428C9`; any other extra column fails with `42501`.
2. The browser uploads straight to the `documents` bucket at `storage_path` with the user's session, `upsert: false`, `cacheControl: "0"`. The storage insert policy (`private.can_upload_document_file`) allows it only if a row at that exact path exists, was uploaded by the caller, is still `'uploading'`, and the caller is still a member. There is **no storage update policy**: no overwrite, no move, no upsert.
3. The client calls `public.complete_document_upload(id)`. It requires the caller to be the row's uploader and still a member, the row to be `'uploading'` and the object to exist, then copies `size` and `mimetype` from the storage object's metadata and sets `'pending'`. `size_bytes`, `mime_type` and `status` are never client-writable.

- **Update grant is `filename` only**, and the update policy allows the uploader or a tenant admin, both still members. `filename` is checked to 1–255 characters, not blank, no control characters.
- **Delete is admin only** for both the object and the row, file first: a `before delete` trigger refuses a row while its object exists (`55000`). Because no file can exist without a row, every file is reachable through a row an admin can delete, so `delete_tenant` is never blocked by an orphan.
- **Documents belong to the tenant.** `uploaded_by` is nullable with `on delete set null`; deleting the uploader's account leaves the row.
- **Bucket:** 10 MB, `application/pdf`, `image/png`, `image/jpeg`. This checks the declared `Content-Type` only; the extraction unit must verify magic bytes before anything reaches a model.
- **Download** is a signed URL created on click with a 60 second expiry, never rendered into the page. Don't assert deletion through the authenticated download endpoint: Supabase's CDN can serve a deleted object to the same session for a short while. Use the object index (list, signed URL) instead.
- A row in `'uploading'` whose upload never finishes just stays there. Nothing sweeps them yet.

## Auth and tests

- The dashboard sets the **minimum password length to 15**; Supabase also caps passwords at 72 characters. Test passwords are 40 characters. The sign-up form enforces both client-side and shows Supabase's `weak_password` reasons.
- `tests/tenant-isolation.test.ts` signs up **three users once per run** (A, B, D) and reuses them, to stay under Supabase Auth's sign-up rate limit. Tests within the file are order-dependent (B is promoted and later removed; D deletes their own account). Cleanup in `afterAll` removes files, then tenants, then accounts, and fails the run if anything is left. Only PDF blobs are uploaded because of the bucket's MIME list.
