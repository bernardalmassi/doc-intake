# Design notes

How the interface looks and why. The rules are in `DESIGN.md`, whose /app section says how /app reads since the September 2026 redesign. The tokens live in `src/app/globals.css`, the shared class strings in `src/app/ui.ts`, and `/dev/states` (development only; a 404 in production builds) renders every screen and state from static data.

## Tokens

### Color

The landing page's tokens, from `landing.module.css` on design-landing. Components use only these, as Tailwind utilities (`bg-paper`, `text-ink`, `border-ink`, `bg-signal`, `text-on-signal`). Each theme swaps the raw values on `<html data-theme>`, so no component needs `dark:`.

| Token | Dark | Light | Purpose |
| --- | --- | --- | --- |
| `paper` | `#141413` | `#f2f1ec` | The one background: pages, inputs, buttons at rest. |
| `ink` | `#f2f1ec` | `#141413` | All text, every rule and border, icon strokes, hover fills. |
| `signal` | `#e8560f` | `#e8560f` | Fills (Low tags, the needs-review glyph, the one primary action) and lines (the focus ring, the underline under a Low value's deciding characters). Never text. |
| `on-signal` | `#141413` | `#141413` | Text on signal, the dark one in both themes. |
| `stage`, `stage-edge` | paper, ink | ink, paper | Aliases, only behind the landing's scan (DESIGN.md's exception). |

**One ink.** `canvas`, `surface`, `line`, `line-strong`, `fg`, `muted`, `accent`, `accent-hover`, `accent-fg` and `danger` are gone. Secondary text is told by size and position, dividers and control borders are 1px ink, and an error is ink words against a 2px ink rule. Hovering a button fills it with ink and sets its label in paper, the primary included; there is no hover shade of signal. Disabled and pending are a dotted ink border.

**What doesn't exist.** `globals.css` resets Tailwind's palette (`--color-*: initial`), type scale, font stacks, radii, shadows, blurs and animations. A stray `neutral-800`, `text-xs`, `font-mono`, `rounded-lg`, `shadow-md`, `backdrop-blur-md` or `animate-spin` compiles to nothing. `transparent`, `current` and `inherit` are keywords rather than theme values, so they still work. Gradients (`bg-linear-*`, `from-*`) and opacity modifiers (`bg-signal/50`) still compile, because no theme reset can remove them. They are banned by convention, so check for them in review.

**Hand-written CSS** reads the raw variables (`var(--signal)`), not `var(--color-signal)`. Tailwind resolves the `--color-*` aliases once on `:root`, so they would ignore a `data-theme` set below `<html>`.

### Contrast

WCAG 2.x relative luminance, from the two theme blocks in `globals.css`. Text needs 4.5:1; focus rings and control borders need 3:1.

| Pair | Used for | Target | Dark | Light |
| --- | --- | --- | --- | --- |
| `ink` on `paper` | All text, rules, control borders | 4.5:1 | 16.30 | 16.30 |
| `paper` on `ink` | A hovered button's label, an armed Delete, selected text | 4.5:1 | 16.30 | 16.30 |
| `on-signal` on `signal` | Primary button label, Low tags | 4.5:1 | 5.06 | 5.06 |
| `signal` on `paper` | Focus ring, quote underlines (non-text) | 3:1 | 5.06 | 3.22 |

Signal on the light paper is 3.22:1, which is why it is never text.

## Type

Two faces, self-hosted through `next/font`: Archivo, with its width axis, for page titles, labels and the wordmark, as on the landing; Geist for everything read. `code`, `kbd`, `samp` and `pre` inherit Geist. There is no mono.

| Size | Utility | Set | Face | For |
| --- | --- | --- | --- | --- |
| label | `label` | 12/16, uppercase, 0.08em | Archivo, width 125, 500 | State words, tags, column heads, section and form labels, buttons |
| small | `text-small` | 15/22 | Geist | Meta, quotes, questions, hints, table cells, errors |
| body | `text-body` | 18/28 | Geist | Values, sentences, inputs; the body default |
| display | `display` | 32 to 48px, 1.05, -0.02em | Archivo, width 100, 500 | The page title |

The wordmark (`wordmark`) is Archivo at width 125 and the body size, so it adds no fifth size. Nothing is set below 12px.

**Numbers.** `tabular-nums` is set on `<body>`, as on the landing, so digits line up everywhere and values don't jitter as they change. Numbers in table columns are right-aligned.

## Theme

**Where it lives.** One place: `<html data-theme="dark|light">`. The server always renders `dark`. The tokens swap on the attribute, and `color-scheme` is set per theme so native controls (the file picker, scrollbars, autofill) follow. Dark is the default whatever the OS prefers: nothing reads `prefers-color-scheme`. This was checked with the OS set to light.

**No flash.** `src/app/components/theme.ts` exports `themeScript`, a one-line inline `<script>` that the root layout puts in `<head>`. This follows Next 16's "Preventing flash before hydration" guide. It reads `localStorage.theme` inside a try/catch, accepts only `light` or `dark`, and sets the attribute. It goes through `InlineScript` (`src/app/components/inline-script.tsx`, from the same guide), which is runnable in the server's HTML and `text/plain` when React creates it in the browser, as it does when a server error makes it render the root layout on the client; React warns about, and never runs, a `<script>` it creates there. It is parser-blocking and sits after the stylesheet link and before `<body>`, so the attribute is set before any content exists to paint. `suppressHydrationWarning` on `<html>` covers that one attribute; it doesn't extend to children.

Checked in dev:

- With light stored, an instrumented reload showed every animation frame, from the first one at 219ms (first paint at 236ms), already light.
- The server HTML with every bundle stripped still paints light with the right icon, which is what a visitor sees before hydration.
- The choice survives reloads and client-side navigation.
- An unknown stored value falls back to dark.
- No console warnings.

Checked in a production build: the script sits before `<body>`, the choice survives a reload, and the console is empty.

**What was not used.** `next/script` with `beforeInteractive`: its guarantee is ordering relative to Next's own scripts, not running before first paint. A cookie read on the server: reading `cookies()` in the root layout would make every route dynamic. React's dev warning about `<script>` tags fires only when React creates one on the client. The root layout's script is hydrated, never created, and the root layout doesn't re-render on navigation, so the warning never fires. If the script ever moves into a Client Component, use the guide's `InlineScript` helper (`type="text/plain"` on the client).

**The toggle** (`src/app/components/theme-toggle.tsx`) keeps no copy of the theme:

- `useSyncExternalStore` reads the attribute through a `MutationObserver`. The server snapshot is `dark`, so hydration always matches, then React re-renders with the real value.
- Both icons are rendered and CSS shows one (`in-data-[theme=light]:`), so the icon is right before hydration too. The icon and the accessible name ("Switch to light theme") both say what clicking does.
- The toggle writes `localStorage` inside a try/catch; with storage blocked, the switch lasts for the page.
- A `useLayoutEffect` re-applies the stored choice before paint. Next's guide warns that React can reset `<html>` to its JSX attributes when it remounts the root in development. In React 19.2 that happens when a hidden Activity containing the root is revealed. A plain reload didn't trigger it here, so it's a cheap safety net.

## Primitives

`src/app/ui.ts`, all built on the tokens:

- **Layout:** `containerClass` (the landing's frame: 82rem at most, 16px gutters on a phone, 40px from 48rem), shared by the header and pages; `pageClass`, the container for `<main>`.
- **Type:** `pageTitleClass` (display), `sectionTitleClass` (label), `hintClass`, `errorClass`, `errorInkRuleClass` (the 2px ink rule every error stands against), `linkClass`. Links are underlined so they don't rely on color.
- **Buttons:** the landing's action. `buttonClass` (primary, the only signal fill), `secondaryButtonClass`, `dangerButtonClass`, `ghostButtonClass`, `iconButtonClass`. Every variant is 40px tall with a 1px border, in the label face; hover fills ink with a paper label; disabled is a dotted ink border. `disabled:` beats `hover:`.
- **Fields:** `inputClass`, 40px, a 1px ink box on paper, Geist at the body size. `formRowClass` and `formRowLabelClass` set a form as ruled register rows.
- **Added by the pages:** `submitButtonClass`, the primary button of a form that submits through a Server Action (pending is `aria-disabled` and dotted, so focus stays on it); `armedDangerButtonClass`, Delete once armed, filled ink.

Focus is one global `:focus-visible` rule: a 2px signal outline at a 2px offset.

The site header (`src/app/components/site-header.tsx`) holds the skip link, the wordmark, a slot, and the toggle, and exports `MAIN_ID` for every page's `<main>`. `textTargetClass` gives a standalone text link a 24px target without moving the layout. `AccountControls` is the slot for signed-in pages.

## Pages

What each page does beyond the primitives, and why. Written before the September 2026 redesign: the behaviour below still holds, but where it describes a look (badges, panels, orange text, a spinner), DESIGN.md's /app section and the code are current.

### Landing (/)

- The one line is also the meta description. "Create an account" is the primary action; "Sign in" is secondary.
- Three architecture sentences as a definition list (Isolation, Uploads, Extraction). A fourth sentence on tests was cut to keep to three; the link reads "Source and tests on GitHub" when there is one.
- "Every table of organization data", not "every table": the limits and prices tables carry no organization id.
- Non-breaking spaces keep numbers with units and products with versions; the heading uses text-wrap: balance.
- The source link renders only when `NEXT_PUBLIC_REPO_URL` is set to an http or https URL, and names GitHub only when it points there. A deployment of the private repository leaves it unset, so no visitor meets a 404.

### Sign in and sign up

- The pending submit button uses aria-disabled, not disabled: in Chromium a focused button that becomes disabled drops focus to <body>. A second click or Enter while pending is cancelled in onSubmit, and React 19 skips the action of a cancelled submit. `submitButtonClass` gives it the disabled look.
- The browser's validation bubbles are off (noValidate); the same checks show inline in the same style as server errors. required and type="email" stay for their semantics.
- Focus after an error goes to the field it's about; the error is part of that field's description. Whole-form errors go in an alert region by the button.
- "Wrong email or password" marks neither field, because Supabase doesn't say which was wrong.
- The Server Actions return an error code from `src/lib/errors.ts`, never Supabase's text. The form puts a code about the password or the email on that field and anything else by the button, and the words are always the catalog's (`userFacingError(code).message`).
- The action is wrapped on the client so a thrown action (connection lost) shows a message instead of Next's error page. A successful sign-in still redirects: Next rejects with a redirect error and navigates, and unstable_rethrow passes it on. The trade-off: the forms no longer submit with JavaScript off.
- The email field keeps its value after a failed attempt; the password is cleared.
- Sign up: the 15 character rule shows before submit as "7 of 15" with a circle, then a check once met. A polite live region announces only when the rule is met or lost, not on every keystroke.
- The 72 limit is counted in UTF-8 bytes, as Supabase's server does. No maxLength on the field, because it silently truncates a pasted password; "too long" shows as it happens instead.
- "Check your email" is a neutral panel, not an error, naming the address, with "Start again". The panel writes its own text; the action's message only says that a confirmation email went out.

### Organizations (/app)

- Empty-state title is "Create an organization", not "your first": someone removed from every organization isn't creating their first.
- Each organization row is one link: underlined name, /app/<address> in muted text, role as plain muted text (badges are for statuses), a chevron.
- Sorted in the view, case and accent insensitive, numeric ("Team 2" before "Team 10"). The page reads memberships with the organization embedded, so the role comes with each row.
- Creating another organization sits behind a native <details> styled as a secondary button, so the orange button appears only when opened. Works before hydration and stays open after an error.
- The web address is derived from the name (`src/lib/slug.ts`: accents folded, spaces and underscores to hyphens, everything else outside a-z, 0-9 and the hyphen dropped, hyphens collapsed and trimmed, cut to 48) until the user types in the address field. While it follows the name the field is not submitted: `createTenant` derives the same address with the same helper and, if it is taken, tries -2, -3 … up to 20 addresses, so a derived address never fails as taken until then. A typed address is tried once, as typed. A name that derives to fewer than 3 characters (punctuation only, another script) gets the field error rather than an invented address. Typed input is not auto-lowercased, to avoid cursor jumps; validation catches it.
- The pattern carries the length because minLength ignores a value set by script.
- Server errors are reworded at render time: "slug" never appears. A taken or invalid address and a missing name go on their field; anything unexpected is one plain sentence, never the raw message.
- Focus moves to the rejected field; after a form-level error it returns to the submit button.
- The submit button has a fixed minimum width so "Creating…" doesn't resize it. Inputs are controlled so values survive React's form reset after an error.
- The empty state doesn't mention adding admins: no screen for managing members exists yet.

### Organization page (/app/<address>)

- **Structure.** page.tsx only fetches. A pure `buildEntries` groups runs and fields under their documents, orders fields by the schema, flags stale runs and sorts; the page and the fixture share it. Every action goes through one operations context: the real page supplies the unchanged Server Actions and Supabase calls, the fixture supplies fakes.
- **Extraction results live inside each document**, not in a separate section below the list.
- **Role line** says what the role can do: "Your role: Admin. You can upload, extract and delete documents." Members read that admins run extraction and delete.
- **Empty organization** is a dashed panel with three numbered steps (upload, extract, check anything marked Needs review), showing the real badge.
- **404** is one page for a missing organization, one the user isn't a member of, and any unmatched address: "This page doesn't exist, or you don't have access to it." Nothing says which.
- **Dates** are formatted by hand ("18 Sep 2026, 04:12 UTC") on the server, because Intl's en-GB month abbreviation differs between ICU versions ("Sep" or "Sept").

### Upload

- A drop zone plus a secondary "Choose a file" button. "Drag a file here" is hidden on touch devices. Drops elsewhere on the page are ignored, so a missed drop doesn't navigate away.
- Upload only becomes the orange primary button once a file is chosen.
- While uploading, three honest steps ("Preparing", "Sending the file", "Checking it arrived"), each set as its call starts. No percentage: supabase-js reports no byte progress.
- Wrong type, over 10 MB, several files and empty files are rejected in the browser before any entry is created.
- A failure is the catalog's sentence for the step's error code: nothing Storage or the database wrote is shown, and there is no "Technical details" disclosure. "Try again" appears only when the code is retryable; otherwise the button is "Choose another file".
- After step 2 or 3 fails, the page refreshes so the unfinished entry appears next to the error. An unfinished upload reads "Upload incomplete" with an explanation; admins can delete it.

### Documents

- Needs review sorts first, then newest first. It gets an accent border and the review badge with an icon, so it isn't color alone.
- "Extraction stalled" marks a document still processing past the 10 minute stale limit. Extract is enabled for it, because the next Extract call is what releases a stale run.
- Extract is the primary button only until a document has results; then it is a secondary "Extract again".
- Delete arms on the first click ("Yes, delete", filled red, with the question and Cancel beside it) and deletes on the second. Clicks within 500 ms of arming are ignored, so a double-click can't delete. Escape, Cancel or tabbing away disarms it.
- Buttons whose label changes have measured minimum widths (`min-w-28` for Extract, `min-w-24` for Delete). Messages sit beside the buttons from `sm` up and below them on a phone, so no message moves a button.
- A Server Action that throws shows "The server couldn't be reached…" instead of the error page. The trade-off, as on the auth forms: Extract and Delete don't submit before the page's JavaScript has loaded.
- A running extraction says "Refresh the page in a minute". There is no automatic refresh yet.

### Extraction panel

- "Extracted fields" is a disclosure, open by default for documents that need review.
- Each field: label, value exactly as extracted (or "Not found"), the quoted source text, "To confirm:" and the clarifying question when there is one, and confidence as a whole percent with its band ("Medium · 74%"). Low fields are orange with an icon and "Check this"; medium is normal text; high is muted.
- The status line is computed from the fields: "10 of 10 fields found. 2 need checking: Due date and Total amount. 2 have questions to confirm." Fields to check are named when there are three or fewer.
- An Extract click reads "Extraction finished." or the catalog's sentence for the code the action returned.
- Field labels are read in a server-only module, so the extraction prompts never reach the browser bundle (checked in `.next/static`).

### Run history

- A disclosure, closed by default, whose summary is the count and total ("3 runs · $0.0231 total").
- Columns: started (UTC, said once in the header), result with the number of model calls, provider and model, tokens in, tokens out, cost, time taken. Numbers are right-aligned and tabular.
- Cost always has four decimals, with "<$0.0001" for anything smaller and the exact value on hover. Latency is seconds to one decimal under 100 s.
- A failed run's error is the catalog's sentence for its code, under its row. `page.tsx` converts the stored text to a code before any component sees the run, so the text an admin's run stored never reaches another member's browser.
- Running and abandoned runs show a dash and are left out of the total, which says so.
- Below 768px each run reflows into a labelled two-column block, so there is no horizontal scroll.

## Accessibility

Every page and fixture state was checked at 320, 375, 768 and 1280 pixels wide in dark, and at 320 and 1280 in light.

- **Width.** No page scrolls wider than the viewport. Long filenames, emails and organization names wrap. The run history reflows into labelled blocks below 80rem and keeps its table roles, so a screen reader still hears a table.
- **Targets.** Every control is at least 24 by 24 pixels (WCAG 2.5.8). Standalone text links and disclosure summaries get it from `textTargetClass`, which adds padding and cancels it with a negative margin, so the layout doesn't move. Links inside running text don't, so they can still wrap.
- **Keyboard.** A "Skip to content" link is the first stop on every page. It sits above the header until focused and jumps to `<main>`, which every page gives the shared id. `<main>` gets no `tabIndex`, which would draw a ring around the page and take focus on clicks. Tab order follows reading order. An armed Delete disarms on Escape, Cancel or leaving it.
- **Focus.** One global `:focus-visible` ring, signal at 2px with a 2px offset, outside every border. No `outline-none` anywhere without a visible replacement, and no ancestor clips a ring. When an action removes the focused element, focus moves somewhere that says what happened: the Documents heading after a delete, the field in error after a rejected submit, "Check your email" after sign-up, the retry button after a failed upload.
- **Announcements.** Each status message comes from a region that is already in the page before its text changes, and is announced once. Progress and results are polite; errors that block the user are alerts. Polite and alert regions are siblings, never nested. An error on the field the user pressed Enter in is echoed in the alert region, because focus can't move to the field it's already on. The delete announcer clears before writing, so a second "Deleted" is read again.
- **Theme toggle.** No live region: its accessible name changes, which NVDA reads on the focused control. VoiceOver users hear the new name on refocus. `aria-pressed` with a fixed label would contradict the name saying what clicking does.
- **Contrast.** Every text node is ink on paper (16.30:1), paper on ink (16.30:1) or on-signal on signal (5.06:1), in both themes, including armed, error, pending and disabled states. No opacity modifier, gradient, shadow or blur is used anywhere.
- **Semantics.** One h1 per page, no skipped levels, header, nav for the breadcrumb and main landmarks, a label on every input, names on icon-only buttons, decorative SVGs hidden. Every page has its own title through the root layout's template (`%s · doc-intake`); the organization page's title is the organization's name.
- **Motion.** One: an opened line's contents arrive in 160ms, ease-out, once per opening. Nothing moves under `prefers-reduced-motion: reduce`. There is no spinner; pending is said in words.
- **Known limits.** The header email truncates on a phone; screen readers get the full address. During an upload the Upload button is disabled, so focus sits on the page body for the few seconds it takes, then returns to "Choose a file" or "Try again". Nothing was checked with a real screen reader, or in Safari or Firefox: "announced once" comes from logging each region's changes and each focus move.

### Error page

A page that throws while rendering gets `src/app/error.tsx` instead of Next's generic screen: one sentence, Try again (Next's `retry`, which refetches the segment), a way back to the organizations, and the error's digest as a reference that matches the server log. In production a Server Component's message is replaced by that digest, so the page never shows raw error text. There is no `global-error`: the root layout is static and can't throw.

There is deliberately no loading state for the organization page. A `loading.tsx` starts streaming before the page runs, and once streaming has started the status code is fixed at 200. A missing or non-member organization would then return 200 with the not-found content, and a signed-out visitor a streamed redirect instead of a real one.

## The design preview

`/dev/states` (committed, development only, a 404 in production builds) has replaced these pages: it renders every screen and state of /app and the auth pages from static data. What follows describes the older local pages.

The signed-in pages can't be seen without an account, so every state is rendered from fixture data on local pages under `src/app/design-preview/`. They are listed in `.git/info/exclude` and never committed, and no real page imports them. The proxy only refreshes sessions, so they load without signing in.

- `/design-preview`: every primitive, the four sizes and the swatches, in the current theme.
- `/design-preview/public`: the sign-in and sign-up forms in every state, driven by fake actions.
- `/design-preview/orgs`: the empty state, a long list with every role, and the create form's states.
- `/design-preview/tenant?view=owner|admin|member|empty-owner|empty-member|upload`: the organization page with every document status, fields, runs, and a live upload form whose fake calls fail on purpose for file names containing `fail-start`, `fail-name`, `fail-send`, `fail-size` or `fail-confirm`.
- `/design-preview/error`: a page that throws, to show the error page.

The real components render there because each page keeps fetching in `page.tsx` and presentation in components that take props, and the organization page's actions come through a context the fixture fills with fakes. Tailwind's scanner skips excluded paths, so `globals.css` registers the folder with `@source "./design-preview"`; in a clone without the folder that line compiles to nothing.

## Decisions under ambiguity

The rule was: take the simpler option, record it, keep going. Decisions about a single page are under Pages; these are the cross-cutting ones.

- **One ink for text and borders.** Every divider and control border is 1px ink (16.30:1), so no second border token is needed.
- **Text on signal is `#141413` in both themes** (5.06:1), not the theme's paper, which on signal would fail in light.
- **Signal is never text.** On the light paper it is 3.22:1, so anything that must stand out is a signal fill with dark text.
- **No danger colour.** An error is ink words against a 2px ink rule; signal stays for what needs a person.
- **Disabled and pending buttons are a dotted ink border** on paper, the landing's. A disabled danger button looks like a disabled secondary one.
- **An armed Delete fills ink**, so the second click is deliberate.
- **Selection is inverted** (`ink` background, `paper` text) instead of the browser's blue.
- **Placeholders are `ink`.** Tailwind's default, 50% of the text color, is translucent and fails contrast.
- **No glass is enforced for blur only.** `--blur-*` is reset. Gradients and opacity modifiers can't be reset, so they're a review rule.
- **`font-mono` and `font-serif` don't exist.** Code-like elements inherit Geist.
- **Colors are hex, not oklch**, so the CSS, the contrast script and this table all show the same values.
- **Label swaps and width.** Buttons have a fixed height; width follows the label. A button whose label swaps (Extract / Extracting…) needs a `min-w-*` at the call site. A global minimum width would pad short labels like "Sign out".
- **Primary buttons are earned.** Upload turns primary only once a file is chosen. Extract is primary only until a document has results, then it becomes a secondary "Extract again". A page never shows a row of orange buttons.
- **Wordmark is text only** ("doc-intake", Archivo wide at the body size, as on the landing), with no logo mark, and links to `/`.
- **Header height is h-14.** It shares `containerClass` with page content.
- **Signed-in slot.** `AccountControls` lives in `site-header.tsx`, so `/app` and `/app/[slug]` don't each keep a copy. "Signed in as" is hidden below `sm` and the email truncates.
- **not-found gets the header without account controls.** Reading the session there would make the 404 auth-aware.
- **Extraction bands.** Low is a signal-filled tag ("Low 59%"), because a low field is what puts a document in needs review. Medium and High are the same words in ink with no fill; Medium adds its question.
- **Column heads are labels:** Archivo, wide, uppercase, 12px.
- **A failed document or run is a crossed glyph and the word Failed**, in ink. The catalogue's sentence explains it.
- **Theme icon.** It shows the theme clicking switches to (sun in dark, moon in light), matching the accessible name.
- **No color transitions**, so a theme switch changes everything at once instead of some buttons fading.
- **No cross-tab sync.** Another open tab picks up the choice on its next load.
- **No `theme-color` meta.** It can follow the OS but not the stored choice.
- **Titles and description.** The root layout has a title template and uses the landing page's one line (`src/app/site.ts`) as the description. Pages set short titles.

## What I would change next

In rough order of value to someone using it:

1. **Live status while extraction runs.** A running document says "Refresh the page in a minute". Once extraction moves to the queue worker, the organization page should subscribe to its documents and runs (Supabase Realtime, or polling while anything is processing) and update in place.
2. **A way out of needs review.** A reviewer can see what to check but can only re-extract. Accepting or correcting a field, and marking a document reviewed, needs a write path in the database first; the panel is laid out so each field row can take an Accept and an Edit control.
3. **The document beside its fields.** Showing the page image next to the fields, with the quoted source text highlighted, would make checking a low-confidence value one glance instead of a download. Images can use a signed URL; PDFs would need a renderer, which means a dependency.
4. **Members.** The database supports owner, admin and member roles, but there is no screen to invite people or change roles. The organization page should get a Members tab.
5. **This month's spend.** The limits and every run's cost are readable, so the organization page could show spend against the 1 USD ceiling before an admin hits it, instead of explaining it after.
6. **A loading state that keeps real status codes.** The organization page shows the previous page until its data arrives. A skeleton is easy, but `loading.tsx` would turn its 404 into a 200 (see Error page). The fix is to decide access before streaming, for example a membership check in the proxy, then show the skeleton.
7. **Tests for the interface.** The fixture pages are already a catalogue of states. Committing them behind a development-only guard and adding an accessibility checker and screenshot comparisons in CI would keep the states from regressing; both need new dev dependencies.
8. **Small things.** A show-password toggle, given the 15 character minimum. Times in the reader's own time zone, rendered after hydration. `MAX_PASSWORD_BYTES` next to `MIN_PASSWORD_LENGTH` in `src/lib/password.ts`.

