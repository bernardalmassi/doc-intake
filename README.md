# doc-intake

A multi-tenant document intake service. People sign up, create an organization, and upload invoices, receipts, contracts and letters as PDF, PNG or JPEG. An admin clicks Extract and a language model reads the document into ten structured fields (type, title, sender, recipient, dates, reference, total, currency, summary), each with a confidence, the text it was read from and, when the model is unsure, one question for a human reviewer. A document with any low-confidence field, or any field the output guard distrusts, is marked `needs_review` for a person to check.

The interesting part is not the extraction but what it survives: tenants that must not see each other, uploads that must not be redirected, a model bill that must not run away, documents written by an attacker, and a model that sometimes answers badly. Postgres is the only security boundary; the app runs as the signed-in user and is not trusted with anything.

Built with Next.js 16 (App Router, Server Actions), React 19, Tailwind CSS 4, Supabase (Postgres, Auth, Storage) and the Anthropic and OpenAI SDKs.

## Architecture

**Request path.** The browser talks to Next.js; Next.js talks to Supabase with the publishable key and the user's own session, never a service key. `src/proxy.ts` refreshes the session cookie on every request and decides nothing. Pages and Server Actions call `requireUser()` (`src/lib/auth.ts`), which verifies the JWT, and then run every query as that user, so row-level security decides what each query can see or change. The app never filters by tenant for security.

**Data.** `tenants` and `memberships` (roles `owner`, `admin`, `member`) are the core. Every other table carries `tenant_id` and has RLS policies built on two `security definer` helpers in a `private` schema the API doesn't expose. Tables are invisible to the API until granted, and grants are column by column: a client can insert only `tenant_id` and `filename` into `documents`, and update only `filename`. Tenants are created and deleted only through RPCs. A trigger refuses any change that would leave a tenant without an owner. Schema: `supabase/migrations/`.

**Uploads, row first.** A Server Action inserts the `documents` row; the database fills in everything else, including `storage_path = <tenant_id>/<id>` as a generated column. The browser then uploads straight to the Storage bucket at that path with the user's session (10 MB, PDF/PNG/JPEG); the storage policy accepts it only if a matching row exists, was created by the same user and is still `uploading`. `complete_document_upload` copies the real size and type from the stored object and marks the row `pending`. There is no update policy on storage objects, so nothing can be overwritten or moved. Downloads are signed URLs valid for 60 seconds, created on click. Deletion is admin-only, file first.

**Extraction.** The Extract Server Action (`src/app/app/extract-action.ts`) runs one run in the request:

1. `open_extraction_run` (SQL) checks the caller is an admin and the document is ready, then, under an advisory lock, the tenant's spend this month (1 USD), everyone's spend (3 USD) and the tenant's runs in the last hour (5). It refuses before any model is called, or inserts a `running` run and returns a close token that never reaches the browser.
2. The action downloads the file with the user's session and checks its magic bytes against the declared type (`src/lib/extraction/sniff.ts`).
3. The orchestrator (`src/lib/extraction/run.ts`) calls the primary provider (Claude Haiku 4.5 by default, `EXTRACTION_PROVIDER=openai` for gpt-5-nano), switches once to the other provider on a timeout or 5xx before any answer, validates the JSON against the schema and formats (`schema.ts`), retries once with the validation error, runs the output guard for signs of prompt injection, and gates each field by confidence: high is written, medium is written with one clarifying question, low sends the document to `needs_review`.
4. `close_extraction_run` (SQL) records the outcome in one transaction and computes the cost itself from the reported token counts, clamped, at the price in its own table. There is no cost parameter. A failed run leaves the document exactly as it was.

**Library layout.** `src/lib/extraction/` holds the config (thresholds, models, and mirrors of the database's limits and prices with a drift test), the schema and prompt, the output guard, the orchestrator, and `providers/` (one interface, two SDK adapters that import `server-only`, and the testable pieces moved out of them: error classification and response interpretation). `src/lib/log.ts` is the only logger. `src/lib/errors.ts` maps every failure a user can hit to one message (table in [ERRORS.md](ERRORS.md)); the pages don't use it yet and still show raw error text, because the UI is being redesigned separately.

## Security model

1. The database is the boundary: every request runs as the signed-in user under row-level security, and no service key exists anywhere in the app or tests.
2. Tenants are kept apart by `tenant_id` and RLS helpers in an unexposed schema; roles can't be self-promoted and a tenant can't lose its last owner.
3. Uploads are row first: the database chooses the path, storage accepts only that path, and size and type are read from storage, not the client.
4. Model spend is checked before each run and costed after it in SQL, from clamped token counts and a price table nobody can write.
5. Documents are untrusted input: the prompt treats them as data, the output must match a fixed schema, a deterministic guard sends suspicious fields to human review, and keys and extracted values can't reach a log line.

Details, verification and the known gaps: [SECURITY.md](SECURITY.md).

## Running it

Requirements: Node.js 22.12 or later (CI uses 24; `openai` and Vite need 22), a Supabase project, and an Anthropic and/or OpenAI API key. The project was built against a hosted Supabase project; `npx supabase start` runs a local stack instead if Docker is available.

```bash
npm ci
```

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from the project's API settings, and at least the primary provider's key (`ANTHROPIC_API_KEY` by default; the other provider's key, if set, is the fallback). Provider keys are server-only and must never get a `NEXT_PUBLIC_` prefix. `NEXT_PUBLIC_REPO_URL` is optional: set it to the repository's URL once it is public, and the landing page links to it; left empty, the page shows no link.

Apply the schema to the project, reviewing the dry run first:

```bash
npx supabase link --project-ref <your-project-ref>
```

```bash
npx supabase db push --dry-run
```

```bash
npx supabase db push
```

In the Supabase dashboard, set the minimum password length to 15. Then:

```bash
npm run dev
```

and open http://localhost:3000.

## Tests

| Command | What it runs | Needs |
|---|---|---|
| `npm run test:unit` | `tests/unit/`: validation, gating, the orchestrator with fake providers, real SDK error handling over a fake `fetch`, the output guard and injection fixtures, the logger's redaction, the error taxonomy | nothing: no database, no network, no secrets |
| `npm test` | the unit tests plus `tests/tenant-isolation.test.ts` and `tests/extraction.test.ts` against a real Supabase project | `.env.test` |
| `npm run test:db` | `supabase/tests/extraction_stale_runs.sql`, the stale-run reaper, in a rolled-back transaction | a linked Supabase CLI |
| `npm run eval` | the offline eval: recorded provider answers replayed and scored (see [Evals](#evals)) | nothing |
| `npm run typecheck` | `next typegen` then `tsc --noEmit` | nothing |

The Supabase suites sign up five throwaway users per run with only the publishable key and assert, as real signed-in users, what each can and can't do: tenant isolation for rows, files and memberships, the upload rules, role changes, the spend ceilings and rate limit, cost computed in the database, and that runs and fields can't be read across tenants or written by anyone. They delete everything they create and fail if cleanup doesn't finish. To run them:

1. Apply every migration to the project (above).
2. Turn email confirmation off (Authentication → Sign In / Providers → Email), since the tests need a session straight from sign-up.
3. Copy `.env.test.example` to `.env.test` and fill in the project URL and publishable key. Never the service role key. Vitest loads only `SUPABASE_TEST_*` variables and blanks both provider keys, so a provider key can't reach a test even from the shell.
4. Run `npm test`: 792 unit tests and 56 Supabase tests, about 30 seconds. Sign-ups count toward the project's auth rate limit, so many runs in a row may be throttled.

**CI** (`.github/workflows/ci.yml`) runs type check, lint, build, the unit tests and the offline evals on every push and pull request, with no secrets. The Supabase suites need the `SUPABASE_TEST_URL` and `SUPABASE_TEST_PUBLISHABLE_KEY` repository secrets and run only when started by hand (Actions → CI → Run workflow → "Also run the Supabase suites"), one at a time, never cancelled mid-run. Those secrets aren't set yet, so the Supabase suites have so far been run locally only.

## Evals

`npm run eval` scores extraction on eleven generated PDFs: eight ordinary documents (a USD invoice, a German receipt with comma decimals, a two-page contract, a letter, a utility statement, a form, a UK VAT invoice with three dates, a price list with most fields absent) and three that carry prompt-injection attacks (override the instructions, copy out the prompt, a hidden 0.01 total). Each provider's answer to each document was recorded once and is committed in `evals/recordings/`. The default mode replays those answers through the real orchestrator, output guard and gating, so it is free, needs no key and runs in CI. It reports per-field accuracy and confidence calibration, and fails when a recording is stale (any change to the prompt, schema, output cap or model), when an injection run fails or leaves a wrong value at high or medium confidence, or when the number of right fields, flagged fields or documents sent to review moves off its recorded baseline.

```bash
npm run eval
```

After changing the prompt, schema or model, re-record against the real providers. This makes real calls: one run per stale fixture per provider, capped at 60 calls and 0.50 USD, and it bypasses the database's spend ceilings.

```bash
npm run eval -- --live
```

Latest results (2026-09-18): Claude Haiku 4.5 got 77 of 80 fields right (96.3%) and gpt-5-nano 73 of 80 (91.3%), with overlapping confidence intervals. Both read every total correctly and both resisted all three injections. Haiku put every field in the high band, so on these documents its confidence never sent anything to review. Scoring rules, calibration tables and limitations are in [EVALS.md](EVALS.md).

## More

- [SECURITY.md](SECURITY.md): the security model, what was verified and how, and what remains.
- [EVALS.md](EVALS.md): extraction accuracy and calibration on the fixture set.
- [ERRORS.md](ERRORS.md): every failure a user can hit and its message.
- [CLAUDE.md](CLAUDE.md): working notes for the codebase's conventions.
