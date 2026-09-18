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

npm test                            # Vitest: tenant isolation + extraction suites against the project in .env.test
npx vitest run -t "cannot upload"   # run tests whose name matches
npm run test:db                     # rolled-back SQL test of the stale-run reaper, via the CLI against the linked project
```

`npm test` hits a real Supabase project with real sign-ups (see README "Tests"): it needs `.env.test`, all migrations applied, and email confirmation off. It uses only the publishable key; keep it that way, since the point is to exercise RLS as a signed-in user. No test calls a model: the orchestrator is tested with fake providers, and Vitest only loads `SUPABASE_TEST_*` variables, so provider keys can't reach it.

## Stack

- Next.js 16 App Router under `src/app/`, React 19, Tailwind CSS v4 (via `@tailwindcss/postcss`, no `tailwind.config`). Import alias `@/*` → `src/*`.
- Per AGENTS.md, Next 16 differs from older versions: check `node_modules/next/dist/docs/` before writing Next code (e.g. middleware is now `proxy` — see `01-app/01-getting-started/16-proxy.md`; there's also a `02-guides/multi-tenant.md`).
- Supabase for Postgres + auth via `@supabase/ssr`. Use `createClient` from `src/lib/supabase/client.ts` in Client Components and the async one from `src/lib/supabase/server.ts` in Server Components, Server Functions and Route Handlers (a new client per request). `src/proxy.ts` refreshes the session on every request; server clients rely on it because Server Components can't write cookies. Auth checks use `requireUser()` / `getCurrentUser()` from `src/lib/auth.ts` (verified via `getClaims`) and are called in every protected page and Server Action, not in layouts or the proxy.
- Env: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, read in `src/lib/supabase/env.ts`. Server-only: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `EXTRACTION_PROVIDER` (`anthropic` by default, or `openai`), read only in `src/lib/extraction/providers/select.ts`. Copy `.env.example` to `.env.local`. Tests read only `SUPABASE_TEST_*` vars from `.env.test` (template: `.env.test.example`). `.env*` is gitignored except the two example files.
- Log only through `src/lib/log.ts` (`log.info(event, fields)`): events are a closed list, fields a typed allowlist with no free text, and every line is scrubbed by `src/lib/redact.ts`. ESLint enforces it in `src/lib`. Never log a field value, filename, model answer, URL or error message; log `error_kind`, `http_status` or `db_code` instead. Unit tests silence it via `tests/setup/quiet-logs.ts`; capture lines with `setLogSink`.
- The Anthropic (`@anthropic-ai/sdk`) and OpenAI (`openai`) SDKs are used with `maxRetries: 0` and an explicit timeout; the orchestrator decides what to retry. Before touching Anthropic code, load the `claude-api` skill and check the SDK types in `node_modules`, not memory.
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
- **Download** is a signed URL created on click with a 60 second expiry, never rendered into the page. Don't assert deletion through the authenticated download endpoint: Supabase's CDN serves a deleted object to the same session for a while, and an already-fetched signed URL for the rest of its lifetime. Use the object index (list, minting a signed URL) instead.
- A row in `'uploading'` whose upload never finishes just stays there. Nothing sweeps them yet.

## LLM extraction (`20260918000001`, `20260918000002`)

An admin clicks Extract; the Server Action `src/app/app/extract-action.ts` runs the whole thing in the request (no queue yet; pgmq is next). **Spend is checked in the database before the call and cost is computed in the database after it.** Nothing about cost trusts the app, because the app runs as the user and any admin can call the same RPCs over PostgREST.

1. `public.open_extraction_run(document_id)`: admin only; document must have a file and not be `processing`; then under a project-wide advisory lock it checks `public.extraction_limits` (1 USD per tenant per calendar month, 3 USD across all tenants, 5 runs per tenant per hour) and raises `53400` (a ceiling) or `54000` (the rate limit) **before inserting anything**. Otherwise it inserts the run in `running`, sets the document to `processing` and returns `run_id` plus a `close_token` that lives in `private.extraction_run_tokens` and never reaches the browser. Before the checks it fails any run for that document still `running` after `stale_run_minutes` (10) and restores the document.
2. The action downloads the file with the user's session, **verifies the magic bytes** against the row's `mime_type` (`src/lib/extraction/sniff.ts`), and calls `runExtraction` (`src/lib/extraction/run.ts`): primary provider, one switch to the other provider on timeout/connection failure/5xx, schema validation on the way back, one retry with the validation error, then fail with the raw answer kept. Every call's tokens are summed.
3. `public.close_extraction_run(run_id, token, status, provider, model, input_tokens, output_tokens, latency_ms, attempts, error, raw_response, fields)`: needs the token **and** the caller must be the user who opened the run. **There is no cost parameter.** Cost is computed from the token counts, clamped to `max_input_tokens_per_run` (800 000) and `max_output_tokens_per_run` (8 192), at the price in `public.extraction_model_prices` (a snapshot id is priced by its longest prefix; an unpriced model is refused). On success it replaces the document's `extracted_fields` and sets `extracted`, or `needs_review` if any field is `low`; on failure it restores the document's previous status and writes no fields. All in one transaction.

- **Config lives in two places on purpose.** `src/lib/extraction/config.ts` holds the thresholds (high ≥ 0.85, medium ≥ 0.6), models, output cap (2048 per call), timeout (60 s per call), retry count, and **mirrors** of the limits and prices tables. The database is authoritative; `tests/extraction.test.ts` fails if either mirror drifts. Changing a limit or price means a migration that updates the table **and** the mirror, with the date checked.
- **Runs and fields are readable by tenant members and have no write grant or policy at all.** New tables follow the `private.is_tenant_member` pattern; `extraction_limits` and `extraction_model_prices` are readable by any signed-in user and writable by nobody.
- **The JSON schema must contain no unions.** Anthropic's structured outputs reject more than 16 union-typed parameters (found live). "Absent" is an empty string; `validateExtraction` turns it into null. Both providers get the same schema from `buildJsonSchema()`; OpenAI's strict mode also needs `additionalProperties: false` and every property in `required`.
- **Cheapest usable models by default:** `claude-haiku-4-5-20251001` and `gpt-5-nano`, both verified live on a real PDF. Model ids and prices come from the providers' pricing pages, dated in the table; don't change them from memory.
- Fields: `document_type` (enum), `title`, `sender_name`, `recipient_name`, `document_date`, `due_date` (YYYY-MM-DD), `reference_number`, `total_amount` (plain decimal), `currency` (ISO 4217), `summary`. Each carries `confidence`, `band`, `source_text` and, for medium, one `clarifying_question`. Low-confidence values are stored too, for the reviewer.
- Known gaps are in SECURITY.md under "What remains": forged runs at the clamped cost bounded by the hourly limit, tenant churn resetting the per-tenant budget, in-flight runs not counted, stale documents released only by the next Extract click.

## Auth and tests

- The dashboard sets the **minimum password length to 15**, and the suite proves Supabase enforces it with a direct 14 character `signUp`. Supabase caps passwords at 72 characters. Test passwords are 40 characters. The sign-up form enforces both client-side and shows Supabase's `weak_password` reasons.
- `tests/tenant-isolation.test.ts` signs up **three users once per run** (A, B, D) and reuses them, to stay under Supabase Auth's sign-up rate limit. Tests within the file are order-dependent (B is promoted and later removed; D deletes their own account). Cleanup in `afterAll` removes files, then tenants, then accounts, and fails the run if anything is left. Only PDF blobs are uploaded because of the bucket's MIME list.
- `tests/extraction.test.ts` signs up **two more** (X owns seven tenants, Y is a member of one). It reaches the ceilings by opening runs and closing them with chosen token counts; the forged spend is removed when cleanup deletes the tenants (runs cascade). The stale-run reaper can't be reached through the API (nothing can backdate `started_at`), so it is tested by `supabase/tests/extraction_stale_runs.sql` in a rolled-back transaction.
- The Vitest config aliases `@` to `src/`, so tests import the extraction library directly. Modules that import `server-only` (the two providers and `select.ts`) can't be imported by tests; keep secrets behind that line and test the orchestrator with fake providers.
