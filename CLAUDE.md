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
- `supabase/config.toml` points seeding at `supabase/seed.sql`, which doesn't exist yet.

## Multi-tenant data model

The core design lives in `supabase/migrations/20260917000001_tenants_and_memberships.sql`, and every future table is expected to follow it:

- `tenants` + `memberships` (user ↔ tenant with `tenant_role` enum: `owner` / `admin` / `member`).
- **Every new table carries `tenant_id`** and enables RLS with policies built on the helper functions `private.is_tenant_member(tenant_id)` and `private.is_tenant_admin(tenant_id)` (admin = owner or admin). They were created in `public` and moved to `private` by `20260917000003`, so older migrations still say `public.`. New code must use `private.`
- **Security definer functions go in `private`**, a schema the API doesn't expose, with `execute` revoked from `public, anon`. The only exception is a function meant to be called as an RPC, such as `create_tenant`. Otherwise the security advisor flags it (lints 0028/0029).
- Those helpers are `security definer` with `set search_path = ''` on purpose: a membership check inside a policy would otherwise re-enter RLS on `memberships` and recurse. Keep new security-definer functions the same way and fully schema-qualify names inside them.
- Tenants are created only via the `public.create_tenant(name, slug)` RPC, which atomically inserts the tenant and the caller's `owner` membership. There is deliberately no INSERT policy/grant on `tenants`. They're deleted only via the owner-only `public.delete_tenant(id)` RPC, which refuses while files remain under the tenant's storage prefix (SQL can't delete storage objects). `public.delete_own_account()` refuses while the caller still owns a tenant.
- Membership role rules (`20260917000004`): nobody changes their own role; only owners grant, change or remove the `owner` role; only `role` is updatable. `private.is_tenant_owner` backs this.
- Table auto-exposure is off, so a new table is invisible to the API until you add explicit `grant ... to authenticated` statements (and `revoke execute ... from public, anon` / `grant execute ... to authenticated` for new RPCs), mirroring the end of that migration.
- Slugs must match `^[a-z0-9-]{3,48}$`.
