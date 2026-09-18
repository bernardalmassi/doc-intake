# Backend checklist

Goal: the harness survives an interviewer who attacks it. No schema
changes, so everything here is code, tests and docs.

Started 2026-09-18 03:06 CEST on branch `backend`. Session ends by 07:06.

## Per item

Type check (`npx tsc --noEmit`), lint, build, `npm test`, commit, push,
re-read this file, tick the item, start the next one. A blocker is written
under the item and the item is skipped.

## Rules

- No SQL, no migrations, no `supabase db push`, no change to any RPC.
- Nothing under `src/app/` is touched (main is redesigning the UI in
  parallel), including `src/app/globals.css`.
- No new runtime dependencies. A dev dependency only if an item genuinely
  can't be done without one, recorded below with the reason.
- Live model calls only to record fixtures, at most one run per fixture,
  nothing that can loop.

## Items

Items run in parallel on separate branches and are merged and ticked as they pass the gates, so they may be ticked out of order.

- [ ] 1. Prompt injection. An uploaded document is untrusted input that a model reads. Harden the extraction prompt so instructions inside a document are treated as content, never as instructions, and the output schema is the only contract. Fixture PDFs that try to override the system prompt, exfiltrate the prompt, and force a wrong total; assert the extractor ignores them. SECURITY.md gets an "Untrusted document content" section.
- [ ] 2. Offline eval set. Six to eight fixture documents with expected fields, and `npm run eval` scoring per-field accuracy and confidence calibration. Default mode replays recorded provider responses committed as fixtures (free, runs in CI). `--live` hits the real providers, capped at one run per fixture. Results in EVALS.md with the date and model.
- [x] 3. Provider layer tests with a fake provider, no network: timeout falls back to the other provider, 5xx falls back, malformed JSON retries once then fails cleanly, the fallback provider's own failure surfaces a clear error.
  Done 03:58. 86 database-free tests in `tests/unit/` (the pure tests moved out of `tests/extraction.test.ts` plus new ones); `npm test` 141 green. Real SDK clients over a fake `fetch` prove a real timeout and 5xx fall back and 4xx/429 don't. Found and fixed on the way: a failed validation retry could build an error longer than the 2000-character column, so the close failed and the document stuck in `processing`; a retry that switched provider priced the primary's tokens at the fallback's rate (the retry now never switches); refused and truncated answers were billed but not counted.
- [ ] 4. Structured logging with redaction. One logger, never logs keys, tokens, signed URLs or extracted values. A test that a log line containing a key is impossible.
- [ ] 5. GitHub Actions CI: type check, lint, build, and the tests that need no database, on every push. The Supabase suite is marked as requiring secrets, with how to run it locally.
- [ ] 6. README rewrite: what it is, the architecture in text, the security model in five lines linking to SECURITY.md, how to run it, the tests and the evals.
- [ ] 7. Error taxonomy: every failure path a user can hit mapped to one clear message, exported from one module so the UI can use it later.

## Dev dependencies added

None yet.

## Blockers

None yet.
