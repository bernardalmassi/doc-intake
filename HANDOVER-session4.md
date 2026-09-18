# Handover: session 4 (2026-09-18 to 2026-09-19)

Everything below is pushed to `main` and applied to both Supabase projects. The working tree is clean apart from `.codex/`, which is local Codex CLI config and deliberately not committed.

## Pushed today

| Commit | What |
|---|---|
| `6a20660` | `tests/unit/model-prices.test.ts`: CI reads the price rows out of the migrations and fails if a default model has no price or the `config.ts` mirror drifts. No database needed. |
| `920b371` | A close refused twice is charged the same tokens at the dearest price on file, marked "cost estimated", never closed without its usage (found by the Codex adversarial review). |
| `dc7b5d6` | Run history shows estimated and unknown costs instead of a free-looking dash or $0. |
| `5d04d85` | The Supabase suites and `test:db` run only against the test project, and refuse the app's (`scripts/supabase-test-target.mjs`). Test users are plus-addresses on `SUPABASE_TEST_EMAIL`. |
| `726467e` | Numeric dates: the prompt decides day or month first from evidence, a new `payment_terms_days` field, and `gateFields` sends dates that contradict the terms to review. New fixture `invoice-gbp-numeric-dates`. |
| `4253a82` | Migration `20260918000003`: an abandoned run is charged an estimate from its page count. `open_extraction_run(uuid, integer)` is new; `open_extraction_run(uuid)` stays as a wrapper. SECURITY.md gains "Deploying schema changes". |
| `12177f6` | Migration `20260918000004`: Claude Sonnet 5 is the default (`claude-sonnet-5`, $2 / $10). Haiku 4.5 is selectable with `EXTRACTION_ANTHROPIC_MODEL`. Thinking is sent disabled. The prompt's leaked evidence example was replaced and everything re-recorded. |
| `8658369` | Documents over 100 pages, or PDFs whose pages can't be counted, are refused at upload (browser) and again before a run opens (Extract action). EVALS.md: the leaked-example section, and the variance statement. |
| `19d1b8c` | Migration `20260919000001`: `max_input_tokens_per_call` 200 000 → 304 500, so the estimate covers 100 pages; a 100-page abandoned run is charged 1.66144 USD. |

Key numbers, as of `19d1b8c`:
- **Abandoned runs:** a one-page abandoned run is charged 0.10644 USD. The hourly limit's worth (five) is 0.53 USD, under the 1 USD tenant ceiling.
- **Real runs:** a Sonnet 5 run averages 0.0202 USD, about 49 runs per tenant per month.
- **Eval:** Sonnet 5 97/99, gpt-5-nano 88/99.
- **Why Sonnet 5 is the default:** wrong answers in the high band went from 3 (Haiku) to 1 (Sonnet), not accuracy. EVALS.md, "Sonnet 5 against Haiku 4.5".

## The two Supabase projects

| | App project | Test project |
|---|---|---|
| Name / ref | `doc-intake` / `rimxdhisbmhjhjdvultm` | `doc-intake-test` / `jqhqvtkhijrrvhfwseaq` |
| Used by | `npm run dev`, the deployed app | `npm test`, `npm run test:db` |
| Configured in | `.env.local` | `.env.test` (URL, publishable key, `SUPABASE_TEST_EMAIL`) |
| Push migrations | `npx supabase db push` (the CLI is linked here) | `npx supabase db push --project-ref jqhqvtkhijrrvhfwseaq` |
| Query | `npx supabase db query --linked ...` | `npx supabase db query --linked --project-ref jqhqvtkhijrrvhfwseaq ...` (`db query` takes `--project-ref` only with `--linked`; it doesn't relink) |
| Auth | as the app needs it | email confirmation **off**; hosted Supabase refuses `example.com`, hence the plus-addresses |

Both are at migration `20260919000001`. The suites refuse to start when the test URL or key is the app's.
- **If a suite run is killed mid-way** (an interrupted command), its `afterAll` cleanup doesn't run, and its forged spend can fill the test project's 3 USD global ceiling. That happened once tonight.
- **The fix is the suite's own cleanup,** run as the leftover users through the public API: remove files, `delete_tenant`, `delete_own_account`. Storage refuses SQL deletes from `storage.objects`.
- **To see what's left:** `select slug from public.tenants` on the test project lists any leftover tenants by run tag.

## The deploy ordering rule

SECURITY.md, "Deploying schema changes":
1. **Migrations go out before the app code that needs them:** the test project first, then the full gate there, then the app project, then the app.
2. **A signature change ships additively.** Keep the old form working as a wrapper, and drop it in a later migration once the deployed app no longer calls it. Give a new parameter no default when an overload of the same name exists, or PostgREST refuses the call as ambiguous (`PGRST203`).

Every migration today followed it: the SQL was shown, validated in a rolled-back transaction on the test project, pushed to test, gated, then pushed to the app.

## Open items

- **Drop the `open_extraction_run(uuid)` wrapper** in a new migration once the deployed app sends `p_page_count`. Only then: until the app is deployed, the old signature is what a stale deployment calls. Remove the wrapper step from `supabase/tests/extraction_stale_runs.sql` in the same change.
- **No automated check that the prompt contains no fixture text.** The leaked example (EVALS.md, "The leaked prompt example") was found only because Sonnet 5's faithful quote tripped the echo guard. A unit test should search `SYSTEM_PROMPT` and `userPrompt()` for each fixture's distinctive lines.
- Also still open, recorded in SECURITY.md: the page counter is a heuristic a crafted PDF could beat; forged runs within the clamp; in-flight runs aren't counted by the ceilings; stale runs are reaped only by the next open for the same document. gpt-5-nano's run-to-run spread (94 / 93 / 88) means the committed OpenAI baseline is one sample.

## Next session, in this order

1. **Vercel deployment.**
   - Set the app's env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, optionally `EXTRACTION_PROVIDER` / `EXTRACTION_ANTHROPIC_MODEL`, `NEXT_PUBLIC_REPO_URL`) for the app project, never the test project.
   - Check the function time limit: a run can take up to three minutes (three calls of 60 s). A shorter limit kills the action, and the reaper then charges the estimate (SECURITY.md, "Provider timeouts").
   - After the deploy is confirmed calling `open_extraction_run(uuid, integer)`, drop the wrapper (above).
2. **The pgmq worker.** Move extraction off the request path. A worker with its own credentials opens and closes runs. `close_extraction_run` stops being callable by users, which closes the forged-run, trusted-band and trusted-page-count gaps. The reaper moves off the request path (SECURITY.md, "Deliberately not yet implemented"). Every schema change there follows the deploy rule above.
