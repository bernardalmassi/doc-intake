# doc-intake

A multi-tenant document intake service. People sign up, create an organization, and upload invoices, receipts, contracts and letters as PDF, PNG or JPEG. An admin clicks Extract, the run is queued, and a worker has a language model read the document into eleven structured fields (type, title, sender, recipient, document and due dates, payment terms, reference, total, currency, summary), each with a confidence, the text it was read from and, when the model is unsure, one question for a human reviewer. A document with any low-confidence field, or any field the output guard distrusts, is marked `needs_review` for a person to check.

The interesting part is not the extraction but what it survives: tenants that must not see each other, uploads that must not be redirected, a model bill that must not run away, documents written by an attacker, and a model that sometimes answers badly. Postgres is the only security boundary; the app runs as the signed-in user and is not trusted with anything.

Built with Next.js 16 (App Router, Server Actions, a route handler for the queue worker), React 19, Tailwind CSS 4, Supabase (Postgres, Auth, Storage, and the pgmq, pg_net and pg_cron extensions) and the Anthropic and OpenAI SDKs.

## Architecture

**Request path.** The browser talks to Next.js; Next.js talks to Supabase with the publishable key and the user's own session. The one exception is the extraction worker, below, which holds the project's secret key and is reached only by the database's wake, with a bearer. `src/proxy.ts` refreshes the session cookie on every request and decides nothing. Pages and Server Actions call `requireUser()` (`src/lib/auth.ts`), which verifies the JWT, and then run every query as that user, so row-level security decides what each query can see or change. The app never filters by tenant for security.

**Data.** `tenants` and `memberships` (roles `owner`, `admin`, `member`) are the core. Every other table carries `tenant_id` and has RLS policies built on two `security definer` helpers in a `private` schema the API doesn't expose. Tables are invisible to the API until granted, and grants are column by column: a client can insert only `tenant_id` and `filename` into `documents`, and update only `filename`. Tenants are created and deleted only through RPCs. A trigger refuses any change that would leave a tenant without an owner. Schema: `supabase/migrations/`.

**Uploads, row first.** A Server Action inserts the `documents` row; the database fills in everything else, including `storage_path = <tenant_id>/<id>` as a generated column. The browser then uploads straight to the Storage bucket at that path with the user's session (10 MB, PDF/PNG/JPEG); the storage policy accepts it only if a matching row exists, was created by the same user and is still `uploading`. `complete_document_upload` copies the real size and type from the stored object and marks the row `pending`. There is no update policy on storage objects, so nothing can be overwritten or moved. Downloads are signed URLs valid for 60 seconds, created on click. Deletion is admin-only, file first.

**Extraction, through a queue** ([docs/worker-design.md](docs/worker-design.md)):

1. The Extract Server Action (`src/app/app/extract-action.ts`) downloads the file with the user's session and counts its pages (`src/lib/extraction/pages.ts`). A document over 100 pages, or a PDF whose pages can't be counted, is refused before anything is queued; the upload form refuses the same in the browser. Then it calls `enqueue_extraction_run` and returns: it calls no model and holds no token.
2. `enqueue_extraction_run` (SQL) checks the caller is an admin and the document is ready, ends any earlier run of it still in flight after 10 minutes, then, under an advisory lock, checks the tenant's spend this month (1 USD) and everyone's (3 USD), each counting every run in flight at its estimate, and the tenant's runs in the last hour (5). It refuses, or inserts a `queued` run, sends a pgmq message and has pg_net wake the worker once the transaction commits.
3. The worker route (`src/app/api/extraction-worker/route.ts`) checks the bearer, answers 202 at once and, in `after()`, has the worker (`src/lib/extraction/worker.ts`) claim one run with `claim_extraction_run` (SQL, secret key only). A second delivery of a message is never processed.
4. Before any model call, the worker downloads the file, checks its magic bytes against the declared type (`sniff.ts`) and recounts its pages against the count it was enqueued with (`delivery.ts`). Any mismatch fails the run with no call, at 0 USD.
5. The orchestrator (`src/lib/extraction/run.ts`) calls the primary provider (Claude Sonnet 5 by default, `EXTRACTION_ANTHROPIC_MODEL=claude-haiku-4-5-20251001` for Claude Haiku 4.5, `EXTRACTION_PROVIDER=openai` for gpt-5-nano), switches once to the other provider on a timeout, failed connection or 5xx before any answer, validates the JSON against the schema and formats (`schema.ts`), retries once with the validation error, runs the output guard for signs of prompt injection, and gates each field by confidence: high is written, medium is written with one clarifying question, low sends the document to `needs_review`.
6. `finish_extraction_run` (SQL, secret key only) records the outcome in one transaction and computes the cost itself from the reported token counts, clamped, at the price in its own table, into an append-only spend ledger. There is no cost parameter. A failed run leaves the document exactly as it was.
7. The page polls every 3 s while a document is processing. Every minute, a pg_cron sweep gives every queued or running run a deadline, so nothing waits on a dead worker for more than about 11 minutes.

**Library layout.** `src/lib/extraction/` holds the config (thresholds, models, and mirrors of the database's limits and prices with a drift test), the schema and prompt, the output guard, the orchestrator, the worker and its delivery, bearer check and project guard, and `providers/` (one interface, two SDK adapters that import `server-only`, and the testable pieces moved out of them: error classification and response interpretation). `src/lib/log.ts` is the only logger. `src/lib/errors.ts` turns every failure a user can hit into a code, and a page shows only that code's message from the catalog (table in [ERRORS.md](ERRORS.md)), so no database, provider or document text reaches the browser.

## Security model

1. The database is the boundary: every request runs as the signed-in user under row-level security. Only the queue's worker holds a secret key, and it can do nothing but claim and finish queued runs through two RPCs no user can call.
2. Tenants are kept apart by `tenant_id` and RLS helpers in an unexposed schema; roles can't be self-promoted and a tenant can't lose its last owner.
3. Uploads are row first: the database chooses the path, storage accepts only that path, and size and type are read from storage, not the client.
4. Model spend is checked before each run, counting every run in flight at its estimate, and costed after it in SQL, from clamped token counts and a price table nobody can write, into a ledger nobody can change.
5. Documents are untrusted input: the prompt treats them as data, the output must match a fixed schema, a deterministic guard sends suspicious fields to human review, and keys and extracted values can't reach a log line.

Details, verification and the known gaps: [SECURITY.md](SECURITY.md).

## Running it

Requirements: Node.js 22.12 or later (CI uses 24; `openai` needs 22, and Vite 22.12 on that line), a Supabase project, and an Anthropic and/or OpenAI API key. The project was built against a hosted Supabase project; `npx supabase start` runs a local stack instead if Docker is available.

```bash
npm ci
```

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from the project's API settings, and at least the primary provider's key (`ANTHROPIC_API_KEY` by default; the other provider's key, if set, is the fallback). Provider keys are server-only and must never get a `NEXT_PUBLIC_` prefix. The worker's `SUPABASE_SECRET_KEY` and `EXTRACTION_WORKER_SECRET` belong in the deployment's environment only (Vercel, Production, marked Sensitive), never in `.env.local`; the same bearer goes into the project's Vault as `extraction_worker_secret`, with the worker's URL as `extraction_worker_url` ([docs/worker-design.md](docs/worker-design.md), section 14). Locally, Extract enqueues into the project it points at, and that project's Vault pair decides which worker is woken. `NEXT_PUBLIC_REPO_URL` is optional: set it to the repository's URL once it is public, and the landing page links to it; left empty, the page shows no link.

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
| `npm run test:unit` | the `unit` Vitest project, `tests/unit/`: validation, gating, the orchestrator and the worker's delivery with fake providers, real SDK error handling over a fake `fetch`, the output guard and injection fixtures, the logger's redaction, the error taxonomy, the worker's boundary, bearer and project guard, and the queue migration's rules | nothing: no database, no network, no secrets |
| `npm test` | the unit tests plus the `supabase` project, `tests/tenant-isolation.test.ts` and `tests/extraction.test.ts`, against a real Supabase project; the extraction suite runs the worker in-process with fake and replayed providers | `.env.test` |
| `npm run test:db` | every file in `supabase/tests/`: the stale-run reaper and the queue (the wake, the sweep, the ceilings, the ledger, the grants), each in a rolled-back transaction, then the two-session lock-order tests in `supabase/tests/sessions/` (a finish racing the sweep, and a claim), which commit one small fixture and remove it, with pg_cron's sweep paused meanwhile, against the test project | `.env.test` and a logged-in Supabase CLI |
| `npm run eval` | the offline eval: recorded provider answers replayed and scored (see [Evals](#evals)) | nothing |
| `npm run typecheck` | `next typegen` then `tsc --noEmit` | nothing |

The Supabase suites sign up five throwaway users per run with only the publishable key and assert, as real signed-in users, what each can and can't do: tenant isolation for rows, files and memberships, the upload rules, role changes, the enqueue and the rate limit, what the worker records, cost computed in the database, and that runs and fields can't be read across tenants or written by anyone. The worker is driven by a local runner with the test project's secret key. They delete everything they create, spend under 0.01 USD, and fail if cleanup doesn't finish. The spend ceilings are tested by `test:db`, inside rolled-back transactions, because spend now goes into a permanent ledger.

**Two projects.** The tests run against their own Supabase project, never the app's. Spend recorded there is permanent for the month, `test:db` reaches both ceilings (1 USD per tenant, 3 USD across all tenants) inside its transactions, and the local runner claims whatever the project has queued, so against the app's project a test run could spend the app's real budget or claim a real user's run. So:

| | App project | Test project |
|---|---|---|
| Used by | `npm run dev`, the deployed app | `npm test`, `npm run test:db` |
| Configured in | `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, publishable key, provider keys); the worker's secrets in the deployment and Vault | `.env.test` (`SUPABASE_TEST_URL`, `SUPABASE_TEST_PUBLISHABLE_KEY`, `SUPABASE_TEST_SECRET_KEY`, `SUPABASE_TEST_EMAIL`); no Vault pair, so nothing there wakes a worker |
| Migrations | `npx supabase db push` (the CLI is linked to it) | `npx supabase db push --project-ref <test ref>` |
| Email confirmation | as the app needs it | off |

Every migration goes to both projects, the test project first. `scripts/supabase-test-target.mjs` makes both Vitest suites and `test:db` refuse to run when the test URL has the same project ref as, or the test key equals, the app's (from any `.env*` file Next.js reads, or `SUPABASE_APP_URL` in the environment). They also refuse when there is no app project to compare against, so a missing `.env.local` doesn't silently skip the check, and the Vitest suites refuse a `SUPABASE_TEST_SECRET_KEY` that isn't an `sb_secret_` key or is the app's. The worker itself refuses the app's project whenever `NODE_ENV` is `test`. `test:db` passes the test project's ref to the CLI, so the CLI stays linked to the app's project.

To run them:

1. Create a second Supabase project for tests and apply every migration to it: `npx supabase db push --project-ref <test ref>` (show `--dry-run` first).
2. Turn email confirmation off on it (Authentication → Sign In / Providers → Email), since the tests need a session straight from sign-up.
3. Copy `.env.test.example` to `.env.test` and fill in the **test** project's URL and publishable key, `SUPABASE_TEST_SECRET_KEY` (a secret key of the **test** project, Settings → API Keys, for the local worker runner only), and `SUPABASE_TEST_EMAIL`: a real mailbox the test users sign up on as plus-addresses, since hosted Supabase refuses `example.com`. Never the app project's keys. Vitest loads only `SUPABASE_TEST_*` variables and blanks both provider keys, so a provider key can't reach a test even from the shell.
4. Run `npm test`. Sign-ups count toward the test project's auth rate limit, so many runs in a row may be throttled.

**CI** (`.github/workflows/ci.yml`) runs type check, lint, build, the unit tests and the offline evals on every push and pull request, with no secrets. The Supabase suites run only when started by hand (Actions → CI → Run workflow → "Also run the Supabase suites"), one at a time, never cancelled mid-run. They need these repository settings, none of which are set yet, so the suites have so far run only locally:

| Name | Kind | Value |
|---|---|---|
| `SUPABASE_TEST_URL` | secret | the test project's URL |
| `SUPABASE_TEST_PUBLISHABLE_KEY` | secret | the test project's publishable key |
| `SUPABASE_TEST_SECRET_KEY` | secret | a secret key of the test project, for the local worker runner |
| `SUPABASE_TEST_EMAIL` | secret | a real mailbox; each test user signs up as a plus-address on it, because hosted Supabase refuses example and test domains ("Example and test domains are currently not supported"). With email confirmation off, nothing is sent |
| `SUPABASE_TEST_EMAIL_DOMAIN` | secret, optional | instead of `SUPABASE_TEST_EMAIL`, a domain for generated addresses, for a project that accepts it |
| `SUPABASE_APP_URL` | variable | the app project's URL, which the guard compares against. It isn't secret; the browser sees it |

CI doesn't run `test:db`. The Supabase CLI reaches a project through a personal access token (`SUPABASE_ACCESS_TOKEN`), and a token is scoped to the whole account, the app project included. Putting one in CI would give the workflow write access to production. Run it locally.

## Evals

`npm run eval` scores extraction on twelve generated PDFs: nine ordinary documents (a USD invoice, a German receipt with comma decimals, a two-page contract, a letter, a utility statement, a form, a UK VAT invoice with three dates, a price list with most fields absent, a UK invoice whose dates are written only in numbers) and three that carry prompt-injection attacks (override the instructions, copy out the prompt, a hidden 0.01 total). Each provider's answer to each document was recorded once and is committed in `evals/recordings/`. The default mode replays those answers through the real orchestrator, output guard and gating, so it is free, needs no key and runs in CI. It reports per-field accuracy and confidence calibration, and fails when a recording is stale (any change to the prompt, schema, output cap or model), when an injection run fails or leaves a wrong value at high or medium confidence, or when the number of right fields, flagged fields or documents sent to review moves off its recorded baseline.

```bash
npm run eval
```

After changing the prompt, schema or model, re-record against the real providers. This makes real calls: one run per stale fixture per provider, capped at 60 calls and 0.50 USD, and it bypasses the database's spend ceilings.

```bash
npm run eval -- --live
```

Latest results (2026-09-18): Claude Sonnet 5 got 97 of 99 fields right (98.0%), Claude Haiku 4.5 95 of 99 in each of three recordings, and gpt-5-nano between 88 and 94. Sonnet 5 is the default, but the eval alone doesn't justify it. Two fields on nine documents is within noise, while a run costs about 0.0202 USD against Haiku's 0.0087, so the 1 USD tenant ceiling allows about 49 runs a month instead of 115 (EVALS.md, "Sonnet 5 against Haiku 4.5"). All three models resisted all three injections. A model once read a UK invoice's "02/09/2026" as 9 February at 0.99 confidence. The prompt now treats numeric dates as ambiguous, and a check against the stated payment terms sends a contradiction to review (EVALS.md, "Numeric dates"). Scoring rules, calibration tables and limitations are in [EVALS.md](EVALS.md).

## More

- [SECURITY.md](SECURITY.md): the security model, what was verified and how, and what remains.
- [EVALS.md](EVALS.md): extraction accuracy and calibration on the fixture set.
- [ERRORS.md](ERRORS.md): every failure a user can hit and its message.
- [CLAUDE.md](CLAUDE.md): working notes for the codebase's conventions.
