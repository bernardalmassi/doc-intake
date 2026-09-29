# pgmq queue worker: design

Phase 0 design, approved on 2026-09-24 with the decisions and fixes in section 13. Base: origin/main at `a8efa8f`. Nothing here is built yet.

Sources for the platform facts:
- Supabase docs, through the docs search tool.
- pgmq's own SQL at tag v1.5.1.
- The Next 16.3.5 docs bundled in `node_modules`.
- The coordination chat, for the Vercel facts marked VERIFIED in section 12 (vercel.com is blocked from the design environment).

## 0. Repo against the live state

**They agree.**
- **Migrations:** the repo has the same 15 as both projects, ending at `20260919000002_drop_open_run_wrapper.sql`.
- **Extensions:** the only extension any migration creates is `pgcrypto` (`create extension if not exists`, already installed). No migration mentions pgmq, pg_net, pg_cron or vault.

## 1. State answers

- **design-landing is not merged.** It is 14 commits ahead of main, forked at `540e0cc`. Main has 2 commits since then (`14ed340`, `a8efa8f`).
- **The tenant isolation test is on main:** `tests/tenant-isolation.test.ts`.
- **`tests/fixtures/test-invoice-messy-scan.pdf` is tracked only on `origin/design-landing`.** It was added in `158d802` ("Commit the scan's PDF, and derive the landing image from it in the test"). No other ref has it; main has no `tests/fixtures/` at all.
- **Last 12 commits of origin/main:**
```
a8efa8f Drop the one-argument open_extraction_run wrapper
14ed340 Ignore .vscode/: it's local editor config
540e0cc Derive an organization's web address on the server when none is typed
f8673b0 Bring the README up to date, and put the time limits in SECURITY.md
90e7644 Run the functions in Frankfurt, next to the database
0554bdc Give the Extract action's page a 240 second function limit
e9bec13 Ignore the local Codex plugin folder
1439a02 Write the session 4 handover
19d1b8c Let the abandoned-run estimate count all 100 pages per call
8658369 Refuse documents over 100 pages, and say why Sonnet 5 is the default
12177f6 Default Claude extraction to Sonnet 5, with Haiku 4.5 still selectable
4253a82 Charge an abandoned run an estimate from its page count
```

## 2. The run lifecycle today

### From the Extract button to the run history row

1. **The button.** `DocumentActions` (`src/app/app/[slug]/document-actions.tsx:59`, `useActionState`) calls `operations.extractAction`, which `LiveOperations` sets to `extractDocument` (`live-operations.tsx:77`).
2. **`extractDocument`** (`src/app/app/extract-action.ts:47`) runs as the user's session throughout:
   - `requireUser()`, then selects the document row.
   - `downloadFile` (`:132`) downloads the file.
   - `countPages` and `checkPageCount` (`:88-95`) refuse a document over 100 pages, or one whose pages can't be counted, before any run exists.
   - `rpc("open_extraction_run", { p_document_id, p_page_count })` (`:98`).
   - `registerSecret(closeToken)` (`:105`).
   - `runAndClose`: the magic-byte check (`:182`), `selectProviders()`, `runExtraction` (`:193-201`), then `rpc("close_extraction_run", toCloseParams(...))` (`:223`).
   - If the close is refused, `closeAsFailed` (`:263`) walks `failedCloseAttempts` (`run.ts:332`): first with the run's usage, then at the dearest price, marked "cost estimated".
   - `revalidatePath`, and a `FormState` is returned.
3. **The history row.**
   - `page.tsx:79-85` selects the runs.
   - `toRunRow` (`types.ts`) turns the stored `error` into a code plus `cost_estimated`.
   - `buildEntries` sets `staleRun` once a run has been running longer than 10 minutes (`entries.ts:33,43`).
   - `RunHistory` renders the row.

### The function that opens a run, and what it reserves

The function is **`public.open_extraction_run(p_document_id uuid, p_page_count integer)`**, created in `20260918000003`. It is security definer and granted to `authenticated`. In one transaction it:
1. Locks the document row. A missing document and a non-admin caller get the same error (42501). A document still `uploading` gets 55000.
2. Runs the reaper (below).
3. Refuses a document already `processing` (55000).
4. Takes `pg_advisory_xact_lock(hashtext('public.extraction_runs'))`.
5. Checks the limits:
   - the tenant's `sum(cost_usd)` for the UTC month (by `started_at`) at or above 1 USD: 53400
   - the global sum at or above 3 USD: 53400
   - the tenant's runs started in the last hour at 5 or more: 54000
6. Inserts the run as `running`, with `previous_document_status` and `page_count` clamped to 1..100 (null stays null).
7. Inserts a token into `private.extraction_run_tokens`, sets the document to `processing`, and returns `(run_id, close_token)`.

**What an open run reserves today:**
- **The document:** it stays `processing`, and every other open is refused.
- **One of the tenant's 5 hourly slots:** it counts by `started_at` for an hour, whatever the outcome.
- **A close token.**
- **No spend.** `cost_usd` is null while running, so running runs are in neither ceiling sum (SECURITY.md's "in-flight overshoot"). The new design changes this (section 4, "Ceilings").

### Who can execute `close_extraction_run`

- **Grants:** `authenticated`, granted in `20260918000001`. `create or replace` in `20260918000002` kept the grants. It is revoked from `public` and `anon`.
- **Checks inside:** `auth.uid()` must not be null, the token must match, and `started_by = auth.uid()`.
- **In effect:** the admin who opened the run and holds the token. Because any admin can call open over PostgREST, any admin can close their own runs with invented token counts, bands and error text. That cost is clamped to 800 000 in and 8 192 out, at most 1.68192 USD at Sonnet 5 prices.
- **What close computes:** the cost in SQL, using `private.extraction_price_for_model` (exact id or longest prefix), the clamp, and rounding to 8 places. On success it replaces the fields and sets the document to `extracted` or `needs_review`. On failure it restores the previous status. Either way it deletes the token.

### How abandoned runs are priced

The rule comes from `20260918000003`, with the price model changed in `...0004`, the per-call cap in `20260919000001`, and the figures and the retry allowance calibrated from real counts in `20260925000005` (SECURITY.md, "Stale runs"):

| Term | Rule |
|---|---|
| pages | `clamp(coalesce(page_count, 100), 1, 100)` |
| input per call | `min(5 998 + 5 929 × pages, 598 898)`; the validation retry may read 1 773 more |
| input | `min(3 × input per call + 1 773, 800 000)` |
| output | `min(3 × 2 048, 8 192)` = 6 144 |
| price | `claude-sonnet-5`, $2 in / $10 out per million |

Examples:
- 1 page: 37 554 in / 6 144 out = **0.136548 USD**
- 20 pages: 0.812454 USD
- 44 pages or more, or unknown: 1.66144 USD

The run's error is marked `cost estimated at claude-sonnet-5 prices (abandoned; ...): abandoned: ...`. Tokens, provider and model stay null on the run. The app-side mirror is `abandonedRunUsage` / `abandonedRunCostUsd` in `config.ts`.

### How the reaper runs

Only inside `open_extraction_run`, only for the document being opened, and only for a run still `running` with `started_at` older than `stale_run_minutes` (10). Nothing is scheduled.

When it acts, it:
- fails the run and charges the estimate
- deletes the token
- restores the document
- leaves that run out of the same open's sums, because a refusal would roll back the reap

A reap is still rolled back if the same open is refused by the hourly limit. In the UI, the badge says "Extraction stalled" after 10 minutes and the button goes back to "Extract again"; that click is what triggers the reap. It is tested by `supabase/tests/extraction_stale_runs.sql`, which backdates `started_at` inside a rolled-back transaction.

### How the 180 s bound and maxDuration 240 interact

- **180 s:** `PROVIDER_TIMEOUT_MS` is 60 000 per call (`config.ts:94`; the SDK timeout, `maxRetries: 0`). A run makes at most 3 calls: the primary, one switch to the fallback before any answer, and one validation retry. That is 180 s of model time.
- **240 s:** Next applies a page's `maxDuration` to the Server Actions on it (bundled docs, "Server Actions"). So `src/app/app/[slug]/page.tsx:20` exports `maxDuration = 240`:
  - 180 s plus 60 s for the download and the two RPCs
  - under Hobby's 300 s
  - under the 600 s reaper, so a live run can't be reaped
- **The test:** `tests/unit/max-duration.test.ts` asserts 180 < 240 < 600 and that only `[slug]` imports the action.
- **What isn't bounded:** nothing times the download or the RPCs individually. If Vercel kills the action at 240 s, the run stays `running`. The document stays `processing` until someone clicks Extract after 10 minutes and the reaper charges the estimate.

## 3. The model call seam

- **Harness entry:** `runExtraction(input: RunInput)` in `src/lib/extraction/run.ts:86`. The providers are injected: `primary: ExtractionProvider` and `fallback: ExtractionProvider | null`. The interface (`providers/types.ts:38`) is `name`, `model` and `extract(request)`.
- **Real providers:** `selectProviders()` in `providers/select.ts:60`, which is server-only.
  - `EXTRACTION_PROVIDER` picks the primary; the other provider is the fallback if its key is set.
  - The keys are read only there and registered with the redactor.
  - The SDK clients use `maxRetries: 0` and a 60 s timeout.
- **How the fallback is called:** inside `call()` (`run.ts:128-185`).
  - On a `ProviderError` whose `fallbackEligible` is true (transport or 5xx, `types.ts:63`), before any provider has answered and at most once per run, the same request goes to the fallback (`continue`).
  - It never switches after an answer.
  - The validation retry (`MAX_VALIDATION_RETRIES = 1`) goes to whichever provider answered.
  - At most 3 calls.
- **How eval replay avoids real calls:**
  - `replayFixture` (`evals/harness.ts:83`) calls `runExtraction` with `replayProvider(recording)` (`evals/recording.ts:167`) as the primary and `fallback: null`. It serves recorded answers by request fingerprint and throws `StaleRecordingError` on any drift.
  - `vitest.eval.config.mts` sets both provider keys to `""` unless `EVAL_MODE=live`.
  - Only `evals/live.ts`, loaded dynamically in live mode, calls `selectProviders`, under a 0.50 USD `CallBudget`.
  - The unit and Supabase suites use `tests/helpers/fake-provider.ts`, and `vitest.config.mts` blanks both keys.
- **What the worker does:** it calls `runExtraction` exactly as the action does today, with the providers passed in:
  - the route passes `selectProviders()`
  - the local runner passes fakes or a `replayProvider`

  The worker never builds a provider, never calls one directly, and never retries a run.

## 4. The new lifecycle

1. **Extract (Server Action, user session).** It does what it does today up to the page count (`requireUser`, read the row, download, `countPages`, `checkPageCount`). Then it calls `rpc("enqueue_extraction_run", { p_document_id, p_page_count })`, then `revalidatePath`, and returns `{}`. No token, no model call, no close. `maxDuration` comes off the page.
2. **`enqueue_extraction_run` (one transaction, as the user, security definer).**
   - What `open_extraction_run` does today up to its limit checks: document lock, admin check, not `uploading`, the reaper, not `processing`.
   - `private.check_extraction_limits(tenant_id, reaped_run_id)`: the advisory lock, both ceilings and the hourly limit (below).
   - Then it inserts the run as **`queued`**. `started_at` is now the enqueue time, and `page_count` is clamped as before.
   - It sets the document to `processing`.
   - `pgmq.send('extraction', {"run_id": ...})`, with the returned `msg_id` stored on the run.
   - `private.wake_extraction_worker()`.
   - It returns `run_id`.
   - A refusal raises: nothing is inserted, nothing is queued, nothing is sent.
3. **pg_net** sends `POST <extraction_worker_url>` with `Authorization: Bearer <extraction_worker_secret>`, body `{}`, and `timeout_milliseconds => 5000`. It sends only after the enqueue commits.
4. **The route** is `src/app/api/extraction-worker/route.ts`, `export const maxDuration = 240`, POST only.
   - Wrong or missing bearer: 401, and nothing is read.
   - Otherwise: `after(() => processOneDelivery({ providers: selectProviders() }))` and an immediate 202.
   - Nothing touches the queue before the 202 goes out.
5. **In `after()`,** `src/lib/extraction/worker.ts` (server-only) creates a Supabase client with `SUPABASE_SECRET_KEY` and calls `rpc("claim_extraction_run")`, which works like this:
   - `pgmq.read('extraction', vt => 300, qty => 1)`. Empty queue: it returns nothing, and the worker logs "idle" and exits.
   - `read_ct > 1`: it reaps the run by the abandoned rule, archives the message and reads the next one. The message is never processed.
   - Run missing or not `queued`: it archives the message and reads the next one.
   - Document deleted: it fails the run with no call and a 0 USD ledger row, archives the message, and reads the next one.
   - Otherwise it sets `running` and `claimed_at = now()`, inserts a fresh claim token, and returns the run id, token, `storage_path`, `mime_type` and `page_count`.

   Reading the message and claiming the run are one transaction, so `read_ct = 1` always means "claimed".

   Since `20260925000003` (section 15), the read locks the message before the claim knows its run, so the run's document and the run are taken with NOWAIT. If either is held, the read is rolled back (`read_ct` and `vt` as they were) and the claim returns no row.
6. **Preflight in the worker.**
   - It downloads the object with the secret key.
   - It checks the magic bytes against the row's type.
   - It recounts the pages, and requires the count to equal `run.page_count` and to be at most 100.
   - Any failure finishes the run as failed with no model call (model null, 0 tokens). A count forged at enqueue therefore never reaches a model.
7. **`runExtraction`** runs with the same calls as today. It gets no filename.
8. **`rpc("finish_extraction_run", ...)`** does the following in one transaction:
   - checks the token (refusing none, before any lock, since `20260925000005`) and that the run is `running`
   - computes the cost with the same SQL rule
   - writes fields and document status exactly as `close_extraction_run` does
   - updates the run, including `cost_usd` as the display copy
   - inserts one ledger row, kind `charge` (or `estimate`)
   - `pgmq.archive`s the message and deletes the token

   If it is refused, the worker walks `failedCloseAttempts` exactly as today. Only finish calls are repeated, never model calls. If every attempt is refused, the message is left alone and the sweep prices the run.
9. **The page** polls with `router.refresh()` every 3 s while any document is `processing` and not stale. It stops when none is.

**Why model calls happen in exactly one delivery:**
- A run is claimed only from `queued`, under a row lock, in the same transaction as the read that sets `read_ct` to 1.
- `read_ct > 1` is archived and priced, never processed, both in the claim and in the sweep.
- Finish needs that claim's token and the `running` status.
- `unique (run_id)` on the ledger means no run can be charged twice.
- One invocation handles one message.
- A retry is a new user enqueue, through the ceilings.

### Ceilings: ledger plus in-flight estimates

One private function, **`private.check_extraction_limits(p_tenant_id uuid)`** (with a second parameter, the run the caller's reaper had just ended, to leave out of its sums, until `20260925000005` removed it: section 17), holds the ceiling check. `open_extraction_run` (until migration 3) and `enqueue_extraction_run` both call it, so the two can't drift. It also holds the advisory lock and the hourly limit.

- **In-flight runs** are every run with status `queued` or `running`, the old path's included. Each counts at its abandoned estimate, `private.abandoned_estimate(page_count)`: the rule in section 2, 0.136548 USD for one page and 1.66144 USD from 44 pages.
- **Tenant ceiling:** refuse with 53400 when the tenant's ledger sum for the UTC month plus the tenant's in-flight estimates is at or above 1 USD.
- **Global ceiling:** refuse with 53400 when the ledger sum for the month across all tenants plus every in-flight estimate is at or above 3 USD.
- **The new run's own estimate is not added**, so a 100-page document can still run on a fresh organization.
- **The run reaped by the same call** is terminal by then, so it is not in flight. Its ledger row is left out of that call's sums, as today.
- **Hourly limit:** unchanged. Refuse with 54000 when the tenant has started 5 or more runs in the last hour (`extraction_runs.started_at`).
- **The 53400 message** says the limit includes extractions in progress, since a large run in flight can now cause it. `errors.ts` and `ERRORS.md` change with it.

**What this buys:** overshoot drops from one run per concurrent run to at most one run. When a check passes, the ledger plus everything in flight is under the ceiling, and only the admitted run can take the total past it, by at most its estimate. A real run can't cost more than its estimate, because the worker verifies the page count before any call.

**What it costs:**
- One 100-page run in flight holds 1.66144 USD against its organization, so every other enqueue there is refused until it finishes or reaches its deadline (section 6).
- Two such runs in flight anywhere hold 3.32288 USD against the global ceiling, so every organization is refused for the same window.
- The window is at most 240 s for a live run. For a run that dies, it ends at its sweep deadline: 360 s after the claim, or 10 minutes plus a sweep tick for a queued or old-path run.
- One-page runs are unaffected in practice: the hourly limit (5) binds before 10 of them in flight would reach 1 USD.

**What an in-flight run reserves:**
- the document
- one hourly slot
- its abandoned estimate, against both ceilings, until it is terminal

**Deleting an organization with a run in flight:** `delete_tenant` now refuses with 55000 while any of the organization's runs is `queued` or `running`. A reservation can't be orphaned. Deleting the organization would otherwise cascade the run and its token under a worker mid-call, and its spend would be unrecordable.

Every non-terminal state has a deadline the sweep enforces (section 6), so the refusal lasts at most 16 min 10 s after the run's enqueue, even with a dead worker or a dead pg_net (section 17: this stated an 11-minute bound, which a run claimed just short of the stale limit exceeded).

Once every run is terminal, deletion cascades runs, fields and tokens as today. The archived queue messages stay; they hold only a run id. The ledger rows stay (no foreign keys) and keep counting toward the global ceiling for the rest of the month. A new organization still starts with a fresh per-organization sum.

Deleting a document mid-run sets `document_id` to null: finish records the spend and writes no fields, as close does now. Deleting an account sets `started_by` to null, and the ledger keeps the user id.

## 5. Tables, functions and grants

### Migration 1 (`20260925000001_extraction_run_queued.sql`), in its own file like `000008`

`alter type public.extraction_run_status add value 'queued' before 'running';`

### Migration 2 (`20260925000002_extraction_queue.sql`), additive

In this order:

1. **Extensions and queue.**
   - `create extension if not exists pgmq;`
   - `select pgmq.create('extraction');` (a logged queue)
   - `create extension if not exists pg_net with schema extensions;`
   - `revoke usage on schema pgmq, net from public, anon, authenticated;`, `revoke execute on all functions in schema pgmq, net from public, anon, authenticated;`, and `revoke all on pgmq.q_extraction, pgmq.a_extraction from public, anon, authenticated, service_role;`
   - RLS enabled on both queue tables, with no policies.
2. **`public.extraction_runs` changes.**
   - Add `queue_msg_id bigint` and `claimed_at timestamptz`.
   - Checks become `(status in ('queued','running')) = (finished_at is null)` and `status in ('queued','running') or <usage present> ...`.
   - New indexes:
     - `create unique index extraction_runs_one_open_per_document on public.extraction_runs (document_id) where status in ('queued','running');`
     - `create index extraction_runs_in_flight_idx on public.extraction_runs (tenant_id) where status in ('queued','running');` for the in-flight sums
3. **`public.extraction_limits`** adds `worker_visibility_seconds integer not null default 300 check (worker_visibility_seconds > 0)`, mirrored in `config.ts`.
4. **`private.extraction_spend`, the ledger.**

   | Column | Definition |
   |---|---|
   | `id` | `bigint generated always as identity primary key` |
   | `created_at` | `timestamptz not null default now()` |
   | `kind` | `text not null check (kind in ('charge','estimate','abandoned','expired','backfill'))` |
   | `tenant_id` | `uuid not null` (the org id; named to match the repo) |
   | `user_id` | `uuid` |
   | `run_id` | `uuid not null unique` |
   | `provider` | `text check (provider in ('anthropic','openai'))` |
   | `model` | `text check (length(model) between 1 and 100)` |
   | `input_tokens` | `integer check (input_tokens >= 0)` |
   | `output_tokens` | `integer check (output_tokens >= 0)` |
   | `cost_usd` | `numeric(12,8) not null check (cost_usd >= 0)` |

   - No foreign keys.
   - RLS enabled with zero policies.
   - `revoke all ... from public, anon, authenticated, service_role`.
   - Indexes on `(created_at)` and `(tenant_id, created_at)`.
   - Triggers: `before update or delete ... for each row` and `before truncate ... for each statement`, both calling `private.refuse_spend_change()`, which raises 42501 "extraction spend is append-only".
   - Exactly one row per terminal run. An `abandoned` row records the estimate's model, provider and tokens.
   - This is the one deliberate exception to CLAUDE.md's "every new table gets member policies".
5. **Shared rules:**
   - `private.extraction_charge(model, provider, in, out)` returns the clamped tokens and cost: `close_extraction_run`'s rule, lifted out.
   - `private.abandoned_estimate(page_count)` returns the model, provider, tokens and cost of today's formula.
   - `private.check_extraction_limits(p_tenant_id, p_reaped_run_id)`: the advisory lock, both ceilings (ledger plus in-flight estimates) and the hourly limit, as in section 4.
6. **`private.reap_extraction_run(p_run_id uuid, p_reason text)`** locks the run, then:
   - **`running`:** fail it with the existing estimate marker, set `cost_usd`, insert an `abandoned` ledger row, delete the token, restore the document, and archive the message if there is one.
   - **`queued`:** expire it at 0: fail it with cost 0 and an `expired` ledger row, restore the document, and archive the message.
   - **Terminal:** nothing.
7. **Backfill and stale runs.**
   - Take `lock table public.extraction_runs in share row exclusive mode`.
   - Reap every run already stale by today's rule.
   - Raise 55000 if any run is still `running`, so the migration is applied while nothing is extracting.
   - Insert one `backfill` row per terminal run: `created_at = started_at`, `cost_usd = coalesce(cost_usd, 0)`, the run's tokens, model and provider.

   After this, the ledger sums equal today's sums over the runs, and nothing is in flight.
8. **`open_extraction_run(uuid, integer)` and `close_extraction_run(...)` are replaced in place** with the same signatures and grants. Open calls `private.check_extraction_limits`, and its reaper calls `reap_extraction_run`. Close inserts its ledger row (kind `estimate` when `p_error` starts with the cost-estimated marker). The deployed app keeps working and stays metered, now under the in-flight rule.
9. `enqueue_extraction_run`, `claim_extraction_run`, `finish_extraction_run`, `wake_extraction_worker`, `sweep_extraction_queue`.
10. `delete_tenant` gains the 55000 refusal while the tenant has a `queued` or `running` run.
11. **Cron:**
    - `create extension if not exists pg_cron with schema pg_catalog;`
    - `grant usage on schema cron to postgres; grant all privileges on all tables in schema cron to postgres;`
    - `cron.schedule('extraction-sweep', '* * * * *', 'select private.sweep_extraction_queue()')`
    - `cron.schedule('extraction-cron-history-purge', '17 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$)`

### Migration 3 (`20260926000001_drop_user_run_rpcs.sql`)

- Guard: raise 55000 if any run is `running` with `queue_msg_id is null`.
- `drop function public.close_extraction_run(uuid, uuid, text, text, text, integer, integer, integer, integer, text, text, jsonb);`
- `drop function public.open_extraction_run(uuid, integer);`

`open` goes too: it hands a close token to users, and after close is dropped an opened run could only be reaped at a user-supplied page count.

### Who can execute what

| Object | Kind | anon | authenticated | service_role | Notes |
|---|---|---|---|---|---|
| `public.enqueue_extraction_run(uuid, integer) returns uuid` | definer | no | **yes** | no | the only user entry point |
| `public.claim_extraction_run() returns table(run_id, claim_token, tenant_id, document_id, storage_path, mime_type, page_count)` | definer | no | no | **yes** | in `public` because PostgREST exposes nothing else |
| `public.finish_extraction_run(p_run_id, p_claim_token, p_status, p_provider, p_model, p_input_tokens, p_output_tokens, p_latency_ms, p_attempts, p_cost_estimated boolean, p_error, p_raw_response, p_fields)` | definer | no | no | **yes** | |
| `public.open_extraction_run(uuid, integer)` | definer | no | yes until M3 | no | dropped in M3 |
| `public.close_extraction_run(...)` | definer | no | yes until M3 | no | dropped in M3 |
| `public.delete_tenant(uuid)` | definer | no | yes | no | new refusal |
| `private.extraction_charge`, `private.abandoned_estimate`, `private.check_extraction_limits`, `private.reap_extraction_run`, `private.wake_extraction_worker`, `private.sweep_extraction_queue`, `private.refuse_spend_change` | definer or trigger | no | no | no | `revoke execute ... from public, anon, authenticated`; only the functions above and pg_cron (as postgres) call them |
| `private.extraction_spend` | table | none | none | none | RLS on, no policies, append-only triggers |
| `pgmq.q_extraction`, `pgmq.a_extraction`, `pgmq.*()` | queue | none | none | none | not in the exposed schemas |
| `net.http_post` and the rest of `net.*` | pg_net | none | none | (unchanged) | revoked explicitly |
| `extraction_runs` | table | none | select (member RLS) | | new columns are readable, and harmless |
| `private.extraction_run_tokens` | table | none | none | none | now holds claim tokens |

## 6. Trigger mechanics, with numbers

**The wake.**
- `private.wake_extraction_worker()` reads `extraction_worker_url` and `extraction_worker_secret` from `vault.decrypted_secrets`.
- If either is missing, or the URL doesn't match `^https://[^/]+/api/extraction-worker$`, it returns null without raising, so an enqueue never fails on configuration.
- Otherwise it calls `net.http_post(url, '{}'::jsonb, headers => {Content-Type, Authorization: Bearer ...}, timeout_milliseconds => 5000)`.
- The call is inline in the one function that inserts queued runs, which is the same as an after-insert trigger.
- The request is sent only after commit (Supabase docs), so a refused or rolled-back enqueue sends nothing.

**The pg_net timeout: 5 000 ms, set explicitly** (the docs give 2 000 ms as the default).
- It only bounds how long pg_net waits for the 202. The handler answers before any work, so it covers routing plus a cold start.
- If it times out before the function started, `read_ct` stays 0 and the sweep wakes the worker again within about 60 to 120 s.
- If the function did start, `after()` keeps running up to the route's 240 s through `waitUntil`, whatever pg_net did (VERIFIED).
- Because the worker reads nothing before the 202, no timeout outcome can cause a model call without a claim.

**Worker bounds:**
- model time 3 × 60 s = 180 s
- route `maxDuration` 240 s (180 s plus a minute for the download and RPCs, under Hobby's 300 s)
- visibility timeout `worker_visibility_seconds` 300 s, above 240, so a message stays invisible for as long as its function can still run
- stale threshold `stale_run_minutes` 10 (600 s)

The unit test asserts 180 < 240 < 300 ≤ 600.

**The sweep** runs every 60 s. It has four steps and runs them in the order (a), (c), (d), (b), so it never wakes a worker for a run it has just expired:
- **(a) Claimed runs past their visibility timeout.** For messages with `read_ct >= 1 and vt <= now()`: reap the run by the abandoned rule and archive the message. Since `20260925000003` the sweep reads these without locking the message, and locks as section 15 says. `20260925000002` used `for update skip locked` on `pgmq.q_extraction`, which locked the message before the run.
- **(b) Wakes that never arrived.** For messages with `read_ct = 0 and vt <= now() and enqueued_at < now() - 60 s`, whose run is still younger than `stale_run_minutes`: one wake each, at most 5 per tick.
- **(c) Old-path runs.** For runs `running` with no live message and `coalesce(claimed_at, started_at)` older than 10 minutes: `reap_extraction_run`, at the abandoned estimate. This closes "a stale document is released only by the next click".
- **(d) Queued runs past the deadline.** For runs `queued` with `started_at` older than `stale_run_minutes`: expire the run at 0 and archive its message.

**Every non-terminal state's deadline:**

| State | Enforced by | Outcome | Latest |
|---|---|---|---|
| `queued` (never claimed) | sweep (d), or the enqueue reaper | expired at 0, message archived | 10 min + 60 s after the enqueue (+ the sweep's 5 s lock wait since `20260925000005`) |
| `running`, claimed through the queue | sweep (a), or the claim on a second read | abandoned at the estimate, message archived | 300 s + 60 s after the claim (+ 5 s for the claim and 5 s for the lock wait since `20260925000005`); a claim can come just short of 10 min after the enqueue, so 16 min 10 s after the enqueue at most |
| `running`, old path (no message) | sweep (c), or the enqueue reaper | abandoned at the estimate | 10 min + 60 s after the open (+ 5 s since `20260925000005`) |

These deadlines also bound how long a dead run holds its estimate against the ceilings and how long `delete_tenant` waits. A dead pg_net worker leaves runs queued, and step (d) still releases them, because pg_cron doesn't depend on pg_net.

**The enqueue reaper stays as a backstop** for the document being enqueued. It measures staleness from `claimed_at` for `running` runs and from `started_at` for `queued` ones.

**Month attribution:** ledger rows are dated when written, and the ceilings sum `created_at >= date_trunc('month', now(), 'UTC')`. A run enqueued before midnight UTC and finished after it counts in the new month. That is never looser than today, which dates by `started_at`. In-flight estimates count whatever month the run started in.

**Cost of an idle tick:**
- one pg_cron run, which is a few index scans on an empty queue and the runs table
- one `cron.job_run_details` row, purged after 7 days (about 10 000 rows kept)
- **zero** pg_net requests
- **zero** Vercel invocations

A busy run costs one invocation, plus one per lost wake.

## 7. Extensions: how, in which order, and whose step

All three are created in migration 2, test project first, in this order:
1. **pgmq:** the queue has to exist before the functions that call it.
2. **pg_net:** the wake.
3. **pg_cron, last:** its schedule starts calling the sweep immediately, so the sweep has to exist first.

The SQL forms are the documented ones (Queues guide, pg_net page, Cron install page).

The dashboard step exists only if `db push` refuses `create extension`: then enable them in Database → Extensions in the same order, and the migration's `if not exists` becomes a no-op. Leave Integrations → Queues → "Expose Queues via PostgREST" **off**, because it creates the exposed `pgmq_public` schema.

## 8. Migrations before app code, and what must hold before the drop

1. **Migration 1, then migration 2** go to the test project with `npx supabase db push --project-ref jqhqvtkhijrrvhfwseaq`. First validate them in a `begin; ... rollback;` via `db query`.
2. **Full gate on the test project:** `npm test` (with the local runner), `npm run test:db`, `npm run eval`.
3. **Migrations 1 and 2 to the app project,** at a moment when nothing is extracting; migration 2's guard enforces this. The deployed app keeps opening and closing runs, now metered in the ledger and under the in-flight rule.
4. **Set the Vercel env vars and the app project's Vault pair,** then deploy the app change: Extract enqueues, plus the worker route and module, the polling and the tests.
5. **Migration 3, test project first, then the app project, only when all of these hold:**
   - Every deployment Vercel lists (and so every Instant Rollback target) descends from the app-change commit. The same check as `20260919000002`.
   - No run opened by the old path is still `running` (`queue_msg_id is null`). The guard raises otherwise, and sweep step (c) reaps stragglers within 10 minutes.
   - At least one real run on production has gone enqueue → claim → finish, and `cron.job_run_details` shows `extraction-sweep` succeeding.
   - The unit test proving that no file in `src/` names `open_extraction_run` or `close_extraction_run` is green on main.
   - The full gate is green on the test project with migration 3 applied.

## 9. UI (minimum)

- **`types.ts`:** `RunRecord.status` gains `queued`, and `page.tsx` also selects `claimed_at`.
- **`entries.ts`:** `staleRun` uses `coalesce(claimed_at, started_at)`.
- **`<RefreshWhileExtracting active>`** (client): `setInterval(router.refresh, 3000)` while `active`, cleared when it turns false. `active = entries.some(e => e.document.status === "processing" && !e.staleRun)`, so polling stops at a terminal state, or when a run goes stale after 10 minutes.
- **What the worker writes:**
  - run status: `queued` at enqueue, `running` at claim, `succeeded` or `failed` at finish, reap or expiry
  - document status: `processing`, then `extracted`, `needs_review`, or the previous status
- **For the other session:** queued is "processing and the latest run is `queued`"; running is "processing and the latest run is `running`". Everything else is today's fields. Presentation stays with that session.
- **Proxy:** add `/api/extraction-worker` to the exclusions in `src/proxy.ts`'s matcher, so the worker's cookieless requests skip the `getClaims` session refresh.

## 10. Tests

### Unit (`tests/unit`, CI, no database)

- **`worker-boundary.test.ts`:**
  - Only `src/app/api/extraction-worker/route.ts`, `tests/helpers/local-worker.ts` and this test reference `extraction/worker` anywhere in `src/`, `scripts/`, `evals/` and `tests/`.
  - `SUPABASE_SECRET_KEY`, `EXTRACTION_WORKER_SECRET`, `"claim_extraction_run"` and `"finish_extraction_run"` appear in `src/` only in `worker.ts`.
  - `"open_extraction_run"` and `"close_extraction_run"` appear nowhere in `src/`.
  - `worker.ts` starts with `import "server-only"`.
  - The route exports only `POST` and a literal `maxDuration`.
- **`delivery.test.ts`** covers the pure preflight helpers, which live outside `worker.ts` so they can be imported:
  - A magic-byte mismatch, a page-count mismatch and more than 100 pages each yield a failed outcome with zero provider calls.
  - A clean preflight makes the same calls as today (primary, then fallback), at most 3, with the existing matrix in `orchestrator.test.ts`.
  - A refused finish repeats only finishes.
- **`worker-target.test.ts`:**
  - `NODE_ENV=test` with the `rimxdhisbmhjhjdvultm` URL throws before any request.
  - The test ref passes.
  - A malformed URL throws.
  - Vitest's `NODE_ENV` really is `test`.
- **`worker-auth.test.ts`:** a missing header, a wrong scheme, a wrong or different-length value, and an unset or short (under 32 characters) configured secret are all refused; `timingSafeEqual` is used.
- **`max-duration.test.ts`, rewritten:** 180 < the route's `maxDuration` < 300, `maxDuration` < `workerVisibilitySeconds` ≤ `staleRunMinutes` × 60, and the Extract page no longer needs `maxDuration`.
- **`queue-migration.test.ts`,** which reads the migrations like `model-prices.test.ts`:
  - The visibility timeout matches the mirror.
  - Every `net.http_post` passes an explicit timeout.
  - The Vault secrets are referenced by name only.
  - **No migration contains an http(s) literal** other than the pricing sources.
- **Existing tests:** `sql-raises`, `errors`, `ERRORS.md` and `log` cover the new raises, the reworded 53400, run error texts and events. `shouldPoll` gets a pure-function test.

### Supabase suites (Vitest `supabase` project)

Users sign in with the publishable key. Only the local runner uses `SUPABASE_TEST_SECRET_KEY`.

- **Configuration:** the drift checks, now including `worker_visibility_seconds`.
- **Enqueue:**
  - anon and member callers are refused
  - an admin gets `queued` with no token, and the document goes to `processing`
  - a second enqueue gets 55000
- **Worker functions:** users calling `claim` and `finish` get 42501. After migration 3, `open` and `close` return PGRST202. `private`, `pgmq` and `net` are not reachable over the API.
- **Runner outcomes:**
  - success: gated fields, `extracted` or `needs_review`, and a cost equal to `computeCostUsd`
  - a failed provider restores the document
  - fallback: two calls, recorded as the fallback provider
  - an unpriced model: an estimate close
  - a forged page count, or a magic-byte mismatch: failed, zero calls, cost 0
  - an empty queue: idle, zero calls
  - a second runner pass after a finish: does nothing
- **One replayed fixture end to end:** `invoice-usd.pdf` with its OpenAI recording. The suite PDFs must be real, countable PDFs from `evals/pdf.ts`; `pdfBytes()` has no page tree and would fail preflight.
- **Limits and deletion:**
  - the rate limit gets 54000 on the 6th enqueue (one-page documents: five in-flight estimates are 0.5322 USD, under the tenant ceiling)
  - `delete_tenant` is refused while a run is queued and allowed after it finishes
- **Guards:**
  - the worker refuses the app URL under `NODE_ENV=test`
  - members see `queued`, then `running`, then a terminal status, and other tenants see nothing
- **Spend budget:** the suite sums its runs' cost and asserts under 0.01 USD. Fakes answer at `gpt-5-nano`, 1 000 in / 100 out = 0.00009 USD a call, which leaves room for over 300 suite runs a month.
- **Moved to `test:db`:** the tenant ceiling, global ceiling and unpriced-model-then-ceiling tests. Ledger spend is now permanent, so one forged 3 USD would block the test project until the month ends.

### `test:db` (as postgres, rolled back)

- **`extraction_stale_runs.sql`, updated:**
  - a claimed run older than 10 minutes is reaped by the enqueue reaper at the estimate, in both the run and the ledger, and its message is archived
  - a never-claimed run is `expired` at 0
  - the reaped run is left out of the same enqueue's sums (until `20260925000005`: section 17)
  - a late finish with the reaped token is refused
- **New `extraction_queue.sql`:**
  - **No persistent Vault pair:** before anything else, the test project's Vault has no `extraction_worker_url`, and no `pgmq_public` exists.
  - **Dispatch over the real grants (fix 2):**
    - As postgres, create the Vault pair inside the transaction, with `https://worker.invalid/api/extraction-worker` and a dummy secret.
    - `set local role authenticated`, and set `request.jwt.claims` to a seeded admin's claims.
    - Call `public.enqueue_extraction_run(...)`.
    - `reset role`.
    - Assert exactly one `net.http_request_queue` row for that URL: POST, the bearer header, 5000 ms, body `{}`.
    - This runs the definer's Vault read the way production will hit it, and sends nothing, because the transaction rolls back.
  - **A refused enqueue** (at a ceiling) writes no net row.
  - **`read_ct > 1`:** claim, then `set_vt(0)`, then claim again. The message is archived, the run is abandoned at the estimate, no token is issued and no row is returned.
  - **Sweep, one test per non-terminal state (fix 1):**
    - **queued:** a run with `started_at` backdated past 10 minutes is expired at 0, with an `expired` ledger row and its message archived
    - **claimed:** a claimed run whose message's `vt` has passed is abandoned at the estimate, with an `abandoned` ledger row and its message archived
    - **old-path running:** a run inserted as postgres in `running` with no message, as the old path leaves them (so the test still works after migration 3), with `started_at` backdated past 10 minutes, is abandoned at the estimate
    - **wake:** a never-read message older than 60 s gets one wake while the in-transaction Vault pair exists
    - **idle:** a tick with nothing to do changes nothing and writes no net row
  - **Ceilings from the ledger:** ledger rows up to 1 USD for a tenant, or 3 USD across tenants, cause 53400. Last month's rows don't count. A deleted tenant's rows still count toward the global ceiling.
  - **In-flight estimates (fix 3):**
    - On a fresh organization, a first enqueue at 100 pages succeeds: its own estimate is not added.
    - Its estimate, 1.66144 USD, now crosses the tenant ceiling, so a second enqueue for another document of the same organization is refused with 53400.
    - Once the first run is terminal at its real cost, the second enqueue succeeds.
  - **Ledger integrity:**
    - update, delete and truncate each raise, as postgres too
    - a second row for the same `run_id` is refused
    - `run.cost_usd` equals the ledger's `cost_usd`
  - **Grants:** `has_function_privilege` and `has_table_privilege` match section 5's table.
  - **Backfill:** checked once when migration 2 is validated: the backfill rows' sum and count equal the pre-migration runs.

## 11. Env vars and where each lives

| Variable | Where | Used by |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel, `.env.local` (as today) | app; the worker takes its URL from here |
| **`SUPABASE_SECRET_KEY`** (new) | Vercel **Production only**, marked Sensitive; never in `.env.local` | `worker.ts` only |
| **`EXTRACTION_WORKER_SECRET`** (new) | Vercel Production only, Sensitive; same value as the app project's Vault `extraction_worker_secret` | `worker.ts` bearer check |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `EXTRACTION_PROVIDER`, `EXTRACTION_ANTHROPIC_MODEL` | Vercel (unchanged); `.env.local` for `eval --live` | `select.ts`, reached only through the route |
| `SUPABASE_TEST_URL`, `SUPABASE_TEST_PUBLISHABLE_KEY` | `.env.test` | suites |
| **`SUPABASE_TEST_SECRET_KEY`** (new) | `.env.test`; a CI secret only if the manual job is used | the Vitest `supabase` project maps it to `SUPABASE_SECRET_KEY` (and `SUPABASE_TEST_URL` to `NEXT_PUBLIC_SUPABASE_URL`) for the local runner only |
| Vault `extraction_worker_url`, `extraction_worker_secret` | **app project only**; the URL is `https://doc-intake-ten.vercel.app/api/extraction-worker` | `private.wake_extraction_worker()` |

Local dev enqueues to the app project, which wakes the production worker. That is the same spend path as today's dev Extract.

**Tooling for the test key:**
- The Vitest config splits into `unit` (no alias, a server-only import still throws) and `supabase` (`server-only` aliased to empty, as the eval config already does).
- `test:unit` becomes `vitest run --project unit`.
- `supabase-test-target.mjs` also requires `SUPABASE_TEST_SECRET_KEY` to start with `sb_secret_` and to differ from any app `SUPABASE_SECRET_KEY`.
- `.env.test.example` changes its "never a secret" line to say the test project's secret key is allowed, for the local runner only.

**The test project can never call production, for four reasons:**
- It has no persistent Vault pair, so the wake does nothing there, and `test:db` fails if a URL appears in its Vault. Fix 2's pair exists only inside a rolled-back transaction and points at `worker.invalid`.
- The migrations contain no URL, which a unit test enforces.
- The bearer secret is per project, so even a misplaced URL gets a 401 before anything is read.
- The local runner is held to the test ref by the target guard and the `NODE_ENV` guard.

**No new dependencies.**

## 12. Platform facts

| # | Fact | Status |
|---|---|---|
| 1 | Vercel Hobby with Fluid compute: 300 s default and maximum duration, and Fluid is on by default for new projects | VERIFIED (coordination chat) |
| 2 | `after()` runs for the route's `maxDuration` through `waitUntil`, and its work is cancelled if the function times out | VERIFIED (coordination chat; Next's bundled docs agree) |
| 3 | Vercel doesn't cancel a function whose client disconnects before the response | unverified, tolerated by design: the worker reads nothing before its 202, so a cancelled invocation leaves `read_ct` at 0 and sweep step (b) wakes it again |
| 4 | The production domain is public: the app loads from `doc-intake-ten.vercel.app` without auth | VERIFIED (coordination chat) |
| 5 | Hobby's included invocations, Active CPU and memory are enough (about 140 runs a month at the 3 USD ceiling), and idle ticks make no requests | accepted as stated |
| 6 | `supabase db push`, as postgres, may `create extension` pgmq, pg_net and pg_cron, and postgres can call `pgmq.create` and own the queue tables | proven by the test project push |
| 7 | Supabase's pgmq 1.5.1 is upstream v1.5.1 and adds no grants to the API roles on `pgmq` | proven by the test project push (and the `test:db` grant checks) |
| 8 | pg_net 0.20.4 matches the docs (default timeout 2 000 ms, sent after commit, unlogged queue, 6 h response TTL), and revoking net privileges from anon and authenticated breaks nothing (no Database Webhooks here) | proven by the test project push |
| 9 | A definer function called as `authenticated` can read `vault.decrypted_secrets` | proven by fix 2's `test:db` case |
| 10 | Secret keys run as `service_role`, so `grant execute ... to service_role` is what the worker needs | VERIFIED (coordination chat) |
| 11 | Postgres on Supabase can't set `session_replication_role`, so only the owner, by disabling triggers in a reviewed migration, can bypass the append-only triggers | accepted as stated |
| 12 | Free-plan pausing, and whether pg_cron activity keeps a project awake | a separate unit |
| 13 | The pg_net background worker can die, leaving runs `queued` until `select net.worker_restart();` | bounded by fix 1: sweep step (d) expires queued runs at 0 after 10 minutes, and pg_cron doesn't depend on pg_net |

## 13. Decisions and fixes (settled 2026-09-24)

**Decisions:**
- **D1, accepted:** a run reaped while still `queued` is expired at 0 (`expired`), not charged the estimate. The claim is the database's only record that any delivery could have called a model.
- **D2, accepted:** the test project has no persistent Vault pair. The only worker is production, so any URL there would be production's.
- **D3, accepted:** `.env.test` holds the test project's secret key, and only the local runner uses it. User sessions stay on the publishable key.
- **D4, accepted with fix 1:** `delete_tenant` refuses while a run is in flight, with a new error code. Fix 1 gives every in-flight state a deadline, so a dead worker can't block organization deletion forever.
- **D5, overruled:** in-flight runs count toward both ceilings at their abandoned estimate. Refuse when the ledger sum plus in-flight estimates is at or above the ceiling, without adding the new run's own estimate. One private function, `private.check_extraction_limits`, holds the check, and open and enqueue both call it (section 4, "Ceilings").

**Fixes:**
1. Every non-terminal state has a deadline the sweep enforces. Sweep step (d) expires a queued run older than `stale_run_minutes` at 0 and archives its message. Queued, claimed and old-path running runs each have a sweep test (section 10).
2. `test:db` proves the Vault read the way production will hit it: a Vault pair created as postgres inside the rolled-back transaction, the enqueue called under `set local role authenticated` with a seeded admin's claims, and exactly one `net.http_request_queue` row asserted. Nothing is sent.
3. `test:db` has a case for D5: the first enqueue's estimate crosses the tenant ceiling, and a second enqueue is refused with 53400.

**SECURITY.md after migration 3:**
- **Closed:** forged runs, the trusted band, the trusted page count for any run that reaches a model, the admin-to-member error text channel, global-ceiling churn, and stale documents waiting for a click.
- **Narrowed:** in-flight overshoot, from one run per concurrent run to at most one run's estimate beyond each ceiling.
- **Remaining:** per-tenant churn, the page-counter heuristic, and the fact that the secret key's holder can do anything.

## 14. Dashboard steps (the owner's)

**Test project (`jqhqvtkhijrrvhfwseaq`), first:**
1. Settings → API Keys: create a secret key named `local-runner` and put it in `.env.test` as `SUPABASE_TEST_SECRET_KEY`.
2. Set **no** Vault secrets here, and keep Queues → "Expose Queues via PostgREST" off.
3. Only if `db push` refuses an extension: Database → Extensions, enable pgmq, then pg_net, then pg_cron, and push again.
4. After the push: Integrations → Cron shows `extraction-sweep` (every minute) and `extraction-cron-history-purge` (daily), both succeeding.

**App project (`rimxdhisbmhjhjdvultm`):**

5. Same as steps 3 and 4, with Queues exposure off.
6. API Keys: create a secret key named `extraction-worker`.
7. Vercel → Environment Variables, Production, Sensitive:
   - `SUPABASE_SECRET_KEY` = that key
   - `EXTRACTION_WORKER_SECRET` = a fresh random value, for example `openssl rand -base64 48`
8. Vault, app project only:
   - `select vault.create_secret('<same value>', 'extraction_worker_secret');`
   - `select vault.create_secret('https://doc-intake-ten.vercel.app/api/extraction-worker', 'extraction_worker_url');`

**Before migration 3:**

9. Vercel → Deployments: every deployment descends from the app-change commit (or delete the rest).
10. This query returns 0: `select count(*) from public.extraction_runs where status = 'running' and queue_msg_id is null;`
11. One production run has been seen end to end.

**Ongoing:**
- Rotating the bearer means changing Vercel and Vault together. Wakes in between get 401 and stay at `read_ct` 0, and the sweep wakes them again.
- If runs sit `queued`, check the pg_net worker and run `select net.worker_restart();`. Until then, sweep step (d) expires them at 0 after 10 minutes.

## 15. Lock order (`20260925000003`)

**The bug.** In `20260925000002` the queue took a message and its run in opposite orders. A Codex adversarial review found it:
- Sweep step (a) locked the message (`for update skip locked`) and then waited for the run in `reap_extraction_run`.
- `finish_extraction_run` held the run and then waited to archive the message.
- `claim_extraction_run` did what the sweep did: `pgmq.read` locked an expired message, and then it waited for the run.

A finish arriving as its visibility timeout ran out made a cycle, and Postgres aborted one side. If it aborted the finish, the sweep or the claim went on to reap the run. The worker's retries then found the claim token gone, so a paid result was dropped and charged as abandoned.

**The order.** Every function takes these, whenever it takes them, in this order:

| # | What | How it is taken |
|---|---|---|
| 1 | the tenant row | key share (enqueue, open, finish, close); update (`delete_tenant`) |
| 2 | the document row | `for update` |
| 3 | the run row | `for update` |
| 4 | the queue message | `pgmq.archive` (a delete), or `pgmq.read` (skip locked, then an update) |
| 5 | the limits' advisory lock | `check_extraction_limits`; nothing waits after it |

**Why this order.**
- **The tenant first.** `delete_tenant` has to lock the tenant before it can check for runs in flight. Inserting a run or its fields takes the tenant's key share through the foreign key. Before, the enqueue took that key share after the document, so it could wait for `delete_tenant` while holding the document that `delete_tenant`'s cascade would wait for. Enqueue, open, finish and close now take it first.
- **The document before the run.** Two things lock them in that order and can't be turned round. The enqueue locks the document to order enqueues for it before it knows whether a run of it is stale. A document's deletion locks the document and then, through `on delete set null`, its runs. Everything else follows them.
- **The message after the run.** Archiving it is the last thing that ending a run does, and nothing holding a message needs more than its run's rows.
- **The advisory lock last.** The enqueue takes it after everything else, and after it only inserts rows nobody else can hold.

**Function by function.** `private.lock_extraction_run(run_id, nowait)` is the one place a run is locked. It reads the run's document id, locks the document, then locks the run, and returns the run as it is under the lock.

| Function | Takes, in order | Waits? |
|---|---|---|
| `enqueue_extraction_run`, `open_extraction_run` | tenant (key share); document; for a stale run of that document, its run and message (`reap_extraction_run`); the limits lock | yes |
| `finish_extraction_run`, `close_extraction_run` | tenant (key share); document and run (`lock_extraction_run`); the message (finish only) | yes |
| `reap_extraction_run` | document and run (`lock_extraction_run`); the message | yes. Its callers already hold the document (enqueue, open) or the document and the run (claim, sweep). |
| `claim_extraction_run` | the message (`pgmq.read`), then document and run | **Out of order, so it never waits.** The document and the run are taken with NOWAIT, in the same subtransaction as the read. On a miss the subtransaction rolls back: the message keeps its `read_ct` and `vt` and is released, and the claim returns no row. |
| `sweep_extraction_queue` (a), (c), (d) | every candidate's document, by id; then every candidate's run, by id; then each message | Candidates are read with no lock. Since `20260925000005` (section 17) each document and run is waited for, at most the sweep's 5 s `lock_timeout`, in a subtransaction of its own; before, taken with NOWAIT. The state is checked again under the locks before any reap or archive. |
| sweep (b) | nothing | |
| `delete_tenant` | tenant (update); all its documents, then all its runs, by id; then the cascade | yes |
| a user deleting a document | document, then its runs (the cascade) | yes, already in order |

**Why the sweep took documents and runs with NOWAIT, until `20260925000005`.** It ends many runs in one transaction and keeps their locks until it commits. Waiting for one candidate while holding others could close a cycle with another transaction that locks several documents, such as `delete_tenant`. So it skipped what it couldn't lock, and the next tick saw it again; but then whoever held a candidate's row at each tick kept it in flight past its deadline (section 17, item 7). Now it takes all its candidates' documents before any run, each in id order, as `delete_tenant` does, so no wait can close a cycle with it, and each wait is bounded by its 5 s `lock_timeout` anyway.

**Why `delete_tenant` locks before the cascade.** Deleting the tenant cascades to its documents and runs in the order Postgres fires the foreign keys' triggers, which is the order of their names. On the test project that happens to be documents before runs, but nothing guarantees it. Locked first, in the order, the cascade waits for nothing.

**What a miss costs.**
- A claim that misses returns no row, and the worker logs `idle`. A message never read is woken again by sweep (b) after 60 s; a claimed one is ended by sweep (a) at its visibility timeout.
- A miss needs someone holding the run's document or the run at the moment of the read: a finish, a reap, the sweep, an enqueue of that document, or a user renaming it.
- A sweep candidate that misses waits one tick.

**Tested** by the two-session tests in `supabase/tests/sessions/`, run by `npm run test:db` on two connections to the test project:
1. A finish holds its run while the sweep runs at the message's visibility timeout.
2. A claim reads the same expired message while a finish holds its run.

pg_cron's `extraction-sweep` job is paused while the cases run and turned back on in a `finally`, so a live tick can't reap a fixture mid-case and write a permanent `abandoned` row. The run fails unless the job is active again and no tick started while it was paused. The pause refuses if the job is already paused, for example by a killed run.

Session F takes the finish's first locks (tenant, document, run) with the finish's own statements, in one transaction. It holds them until the other session has acted or is waiting on it, then calls `finish_extraction_run` in the same transaction. Each case passes only if:
- the finish commits with its result: run succeeded, field written, document extracted, one `charge` row
- neither session reports a deadlock
- the message is archived exactly once, with `read_ct` 1
- the other session returned within `deadlock_timeout` and left the run running
- the sweep never locked the message (its `xmax` stayed 0)
- the claim's read was rolled back (a non-zero `xmax`, with `read_ct` and `vt` unchanged)

Run against `20260925000002`'s functions, both cases failed with `40P01 deadlock detected`. There Postgres aborted the sweep or the claim, the side that had waited first, and the finish committed. With the waits the other way round, the finish is the side aborted.

**Outside this order.** Found while mapping it, not changed:
- **The caller's own account.** The enqueue's insert takes the key share of the caller's `auth.users` row (`started_by`) after the document, and deleting that account cascades to the documents it uploaded. An admin enqueueing their own upload while their account is being deleted can deadlock. One of the two actions fails, and nothing is charged, because no run exists yet.
- **Account deletion's cascade order.** Deleting an account cascades to documents (`uploaded_by`) and runs (`started_by`) in trigger-name order. On the test project that is documents first, as the order wants. The app project wasn't checked, since it is never queried here. If its order were runs first, deleting the account that started a run during that run's finish could deadlock, and the worker's retry would record the run as failed with its usage.
- **Owner removal against `delete_tenant`.** `memberships_keep_an_owner` locks the membership and then the tenant; `delete_tenant` locks the tenant and then the memberships, by cascade. An owner removed while the organization is deleted can deadlock. No spend is involved.

## 16. Review fixes (`20260925000004` and the worker, 2026-09-26)

Two adversarial reviews of this branch found ways past the design above. What changed, in the order of the fixes (each its own commit on `worker`):

1. **Every call is measured before it is sent.** The orchestrator counts each call's input with the provider's token counting endpoint and sends it only if it fits `inputTokensPerCall(pages)`, the per-call input the estimate assumes (section 2), and keeps the run within the estimate's 800 000 cap. A first call over it fails the run as `extraction.too_dense` at 0 USD; a fallback that can't be measured isn't used; a retry over it isn't sent. Counts add up to 3 × 15 s, so the route's `maxDuration` is 280 (section 6's bounds become 225 < 280 < 300 ≤ 600).
2. **A call with no answer costs its maximum.** It is recorded at its measured input plus the output cap (with the count's margin since `20260925000005`, section 17); tokens from two models are priced at the dearer; either way the ledger row is `estimate`.
3. **One snapshot per ceiling.** `check_extraction_limits` reads each ceiling's ledger and in-flight sums in one statement, so a finish between them is counted once (section 4 assumed this; two statements broke it). A third two-session case races a check against a finish.
4. **A finish that gets no answer is retried**, unchanged, with backoff, until the route's deadline; only a definite refusal goes to `failedCloseAttempts` (section 4, step 8).
5. **The claim locks in order and skips busy runs.** It lists visible messages without locks, takes a candidate's document and run with NOWAIT, then reads that message: the order of section 15, message last. A held run is skipped and the next tried, up to 5. Enqueue, open and close check the caller before any row lock.
6. **The claim expires a queued run past the stale limit** at 0 instead of starting it.
7. **The worker's download has its own 15 s timeout** (section 2's "what isn't bounded").
8. **Each wake in sweep step (b) is its own subtransaction**, so a failing wake can't roll back the tick's reaps.
9. **The wake URL is checked strictly** (`private.extraction_worker_url_problem`: https, a plain host, no credentials, port, query, fragment or whitespace, exactly `/api/extraction-worker`), and a malformed one raises a warning instead of being skipped silently (section 6's pattern let credentials and ports through).
10. **The SDK clients' base URLs are fixed in code** (`providers/clients.ts`).
11. **Members can't read `queue_msg_id`** (section 5's table said the new columns were harmless; the message id counts the project-wide queue).
12. **`sweep-pause.sql` refuses a project whose Vault holds `extraction_worker_url`.**
13. **Extract refuses a file the worker would only fail** (a failed download, the wrong type, no pages) with no run.
14. **The page polls through a Server Action**, stops only when two renders agree nothing is in flight, skips failed refreshes, never overlaps, and shows a run as stalled only from the database's terminal state (section 9's timer is gone).

SECURITY.md has the claims these make, each with the test that proves it.

## 17. Final fixes (`20260925000005` and the worker, 2026-09-29)

A review of section 16's fixes (V1 to V12) found what is fixed here, one commit per item on `worker`, in this order:

1. **The per-call bound is calibrated from real counts** (V1). Section 2's 4 500 + 3 000 a page came from sparse text PDFs; enforced, it refused most photos and scans on Sonnet 5, and many one-page retries. The figures are now Anthropic's free counts of the prompt, the fixtures, their retries, a phone photo and a 150 dpi scan, each maximum plus 25 %: 5 998 + 5 929 a page, the retry 1 773 more (`evals/token-counts.json`, `npm run eval -- --count`, `input-bound.test.ts`). The estimate is three first calls plus the retry allowance; one page is 0.136548 USD, and the per-run clamp binds from 44 pages.
2. **A count is taken as 5 % more** wherever it stands for a bill: against the call's and the run's bounds, and when a call with no answer is charged (`withCountMargin`, `config.ts`).
3. **A finish with no token is refused**, before any lock, as the close is: a null token and the nil uuid get the same `42501` as a wrong one.
4. **The claim times out in the database.** `claim_extraction_run` runs under its own `transaction_timeout` of 5 s: one held up longer is ended and rolled back whole, instead of committing after its worker has gone. The worker waits 8 s for the answer. A `statement_timeout` on the function wouldn't apply to the call in progress; this does, and stops when the function returns (measured). A two-session case holds the token table and requires the database to end the claim.
5. **The enqueue counts the run its reaper just ended** (V2). `check_extraction_limits` used to leave that run's ledger row out, because a refusal would roll the reap back; but the run was no longer in flight either, so it was counted nowhere, and a ceiling could be passed by two estimates. Now it counts every row. If that refuses the enqueue, the reap rolls back with it, the run stays in flight at its estimate, and the sweep ends it on its next tick. The function lost its second parameter.
6. **`complete_document_upload` checks its caller before it locks the row** (V3), as the enqueue, open and close have since section 16's fix 5; before, anyone with a document's id could hold its row and make the claim and the sweep skip its run. `extraction_queue.sql` (6c) calls every RPC that locks a document or a run as a refused caller and requires the rows' `xmax` unchanged, and fails on a function in `public` it doesn't cover.
7. **The sweep waits for a run past its deadline, in the lock order** (V4). Every sweep candidate is past a deadline, and NOWAIT let whoever held its document or run at each tick (a rename in bursts) keep it in flight indefinitely. The sweep now takes all its candidates' documents in id order, then their runs in id order, each wait at most its 5 s `lock_timeout`, then reaps. A waiter queues behind the holder, so a briefly held row is had; one held past 5 s is left for the next tick. Two two-session cases hold a stale run's document, briefly and past the timeout; the sweep's case against a finish now waits for the finish and keeps its result.
8. **The page gives Extract back once a run is overdue** (V5). With the page's clock gone (section 16, fix 14), a document stayed "Extracting" with Extract disabled for as long as the database kept its run in flight, so when the sweep wasn't ending runs the enqueue reaper, the backstop for that case, couldn't be reached from the page, and every tab polled. Now `overdueAt` (`src/lib/extraction/deadlines.ts`) gives each run in flight a hard bound from its own timestamps: past both the sweep's deadline and the reaper's, plus a tick. Before it Extract stays disabled; past it the document shows as stalled, polling stops, and Extract comes back, whose enqueue reaps the run.
9. **The in-flight bound is 16 min 10 s, stated in one place** (V6). The 11-minute bound sections 4 and 6 stated added the stale limit and a tick, but a run can still be claimed just short of the stale limit and is then hidden for 300 s from its claim. `IN_FLIGHT_BOUND_MS` in `src/lib/extraction/deadlines.ts` computes it from the config (10 min + 5 s claim + 300 s + 60 s tick + 5 s lock wait), `tests/unit/deadlines.test.ts` checks it against every run state and that SECURITY.md, CLAUDE.md, README.md and this document state it; the error catalog's "ended within 17 minutes" is derived from it.
10. **The provider timeout covers the whole call** (V7). The Anthropic SDK timed a request only until its headers arrived; `response.json()` then had no timer, so a stalled body could outlast the route. `providers/calls.ts` gives every count and call an abort signal fired at its timeout and rejects then as a transport timeout, for both SDKs; the bounds of section 6 (225 s of calls and counts) now hold for the body too.
11. **The SDK clients ignore `*_CUSTOM_HEADERS` and `*_LOG`** (V8). Both SDKs read them when a client is built: the headers go after their own, so they could replace the key, the version or the organization, and `debug` logging writes whole requests to the console. `providers/clients.ts` builds each client with them withheld from the SDK (and put back), logging off and a silent logger.

