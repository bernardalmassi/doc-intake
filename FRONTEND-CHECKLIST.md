# Frontend checklist

Goal: a stranger opens this app and sees something an engineer shipped. Every
reachable state designed, no blank screens, no developer wording.

Started 2026-09-18 03:04 CEST. Session ends by 07:00.

## Per item

Type check (`npx tsc --noEmit`), lint, build, `npm test` (64 green), commit,
push, re-read this file, tick the item, start the next one. A blocker is
written under the item and the item is skipped.

## Rules

- No new dependencies. React and Tailwind only, no component library, no icon package.
- No Server Action changes its behaviour or return shape, only how it renders.
- Nothing under `supabase/`, `src/lib/extraction/` or `tests/` is touched. No SQL, no migrations, no db push.
- The 64 tests stay green before every commit.
- Ambiguity: take the simpler option, record it in DESIGN-NOTES.md, keep going.

## Items

- [x] 1. Design tokens and theme. Light and dark, toggle in the header, remembered, dark default, no flash on load. Near-black, off-white, one orange accent used only for primary actions, focus rings and needs_review. No purple, no indigo, no gradients, no glass. One type family, four sizes, tabular numbers for money, tokens and latency.
- [x] 2. Landing page at /. What the app does in one line, three sentences of architecture, a link to the GitHub repo, sign in and sign up.
- [x] 3. Sign in page. Real labels, inline errors from the Server Action, disabled state while submitting, link to sign up.
- [x] 4. Sign up page. Same, plus the 15 character password rule shown before submit and the server's reason shown when it rejects.
- [x] 5. /app organizations list and create organization. Empty state that explains what an organization is.
- [ ] 6. /app/[slug]. Header, upload, document list, 404 for unknown and non-member slugs.
- [ ] 7. Upload states: idle, chosen, uploading, rejected type, too large, failed.
- [ ] 8. Document states: pending, processing, extracted, needs_review, failed. needs_review sorts first and is visibly distinct. Buttons must not shift the row when a status message appears.
- [ ] 9. Extraction panel. Field, value, confidence, band, source text, clarifying question when present. Plain English status line.
- [ ] 10. Run history per document: provider, model, tokens, cost, latency, status, time.
- [ ] 11. Responsive to phone width, keyboard reachable, visible focus, aria-live on status changes, contrast AA.
- [ ] 12. DESIGN-NOTES.md: tokens, the reason for each, what would change next.

## Blockers

- Item 2: the GitHub repo is private, so the landing page link returns a 404 for anyone without access. Making it public is the owner's call; the link is in place either way.

## Cleanup before the last commit

- Remove the `@source "./design-preview"` line from globals.css once the local fixture page is deleted.
