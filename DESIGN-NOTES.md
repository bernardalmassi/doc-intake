# Design notes

How the interface looks and why. The tokens live in `src/app/globals.css`, the shared class strings in `src/app/ui.ts`, and `/design-preview` (local only, see below) renders all of them in either theme.

## Tokens

### Color

Components use only these, as Tailwind utilities (`bg-canvas`, `text-muted`, `border-line-strong`, `bg-accent`, `text-danger`…). Each theme swaps the raw values on `<html data-theme>`, so no component needs `dark:`.

| Token | Dark | Light | Purpose | Reason |
| --- | --- | --- | --- | --- |
| `canvas` | `#0c0c0b` | `#fafaf8` | Page background | Near-black and off-white with a trace of warmth, so the orange belongs to the palette. Pure black under off-white text vibrates; pure white glares. |
| `surface` | `#171716` | `#ffffff` | Panels, inputs | One step off the canvas. Panels also get a `line` border, so the step never has to carry the edge alone. |
| `line` | `#282826` | `#e6e6e1` | Dividers, panel borders, hover fill of quiet controls | Decorative and deliberately faint. Never the only thing that identifies a control. |
| `line-strong` | `#6b6b66` | `#8c8c86` | Borders of inputs, secondary buttons, the file picker, badges | WCAG 1.4.11: a control's boundary needs 3:1 against its surroundings. `line` can't do that without making every divider heavy. |
| `fg` | `#ededea` | `#141413` | Text | The off-white and near-black that carry the UI. |
| `muted` | `#9e9e98` | `#5e5e59` | Hints, meta, table headers, placeholders, disabled labels | At least 6:1 on both backgrounds, so "secondary" never means "hard to read". |
| `accent` | `#ff8f40` | `#b54a00` | Primary action fill, focus ring, needs review | One orange, same hue (24.5°) in both themes: lighter in dark, burnt in light, so it clears 4.5:1 even as text. |
| `accent-hover` | `#ffa968` | `#9a3f00` | Primary action, hovered | A step further from the canvas in each theme, so hover reads as "more". A token rather than opacity or a filter. |
| `accent-fg` | `#0c0c0b` | `#fafaf8` | Text on the accent | The canvas color of each theme. No third neutral. |
| `danger` | `#ff6b6b` | `#b91c1c` | Error text, destructive button, rejected field border | The one exception to "one accent", below. |

**The danger exception.** The palette is two neutrals and one orange, with a single exception: one red, `danger`, for error text (`errorClass`, a failed run's error), the destructive button and a rejected field's border. An error must not read as "needs review", and with only the orange available it would. Red sits at hue 0°, the accent at 24.5°, and they take different forms (red as text and outline, orange as fill, ring and badge). There is no green for success and no amber for warnings: success is plain text.

**What doesn't exist.** `globals.css` resets Tailwind's palette (`--color-*: initial`), type scale (`--text-*: initial`), font stacks (`--font-*: initial`) and blur scale (`--blur-*: initial`). A stray `neutral-800`, `text-xs`, `font-mono` or `backdrop-blur-md` compiles to nothing. `transparent`, `current` and `inherit` are keywords rather than theme values, so they still work; this was checked in compiled output. Gradients (`bg-linear-*`, `from-*`) and opacity modifiers (`bg-accent/50`) still compile, because no theme reset can remove them. They are banned by convention, so check for them in review. Disabled states use tokens (`line` fill, `muted` text), not opacity.

**Hand-written CSS** reads the raw variables (`var(--accent)`), not `var(--color-accent)`. Tailwind resolves the `--color-*` aliases once on `:root`, so they would ignore a `data-theme` set below `<html>`. The utilities themselves use the raw variables.

### Contrast

WCAG 2.x relative luminance. The values are read straight from the two theme blocks in `globals.css`. Text needs 4.5:1; focus rings and control borders are non-text and need 3:1.

| Pair | Used for | Target | Dark | Light |
| --- | --- | --- | --- | --- |
| `fg` on `canvas` | Body text | 4.5:1 | 16.68 | 17.64 |
| `fg` on `surface` | Text in panels and inputs | 4.5:1 | 15.29 | 18.43 |
| `muted` on `canvas` | Hints, meta, table headers | 4.5:1 | 7.27 | 6.24 |
| `muted` on `surface` | Hints inside panels, placeholders | 4.5:1 | 6.66 | 6.52 |
| `accent-fg` on `accent` | Primary button label | 4.5:1 | 8.62 | 5.09 |
| `accent-fg` on `accent-hover` | Primary button label, hovered | 4.5:1 | 10.37 | 6.51 |
| `accent` on `canvas` | Focus ring, input focus border (non-text) | 3:1 | 8.62 | 5.09 |
| `accent` on `surface` | Focus ring on a panel (non-text) | 3:1 | 7.91 | 5.32 |
| `accent` on `canvas` | Accent as text: needs review | 4.5:1 | 8.62 | 5.09 |
| `accent` on `surface` | Accent as text inside a panel | 4.5:1 | 7.91 | 5.32 |
| `danger` on `canvas` | Error text, destructive button label | 4.5:1 | 7.05 | 6.19 |
| `danger` on `surface` | Error text inside a panel | 4.5:1 | 6.46 | 6.47 |
| `canvas` on `danger` | Destructive button label, hovered | 4.5:1 | 7.05 | 6.19 |
| `line-strong` on `canvas` | Input and button borders (non-text) | 3:1 | 3.65 | 3.24 |
| `line-strong` on `surface` | Input border on its own fill (non-text) | 3:1 | 3.35 | 3.38 |
| `fg` on `line` | Quiet button label, hovered | 4.5:1 | 12.59 | 14.72 |
| `muted` on `line` | Disabled button label (exempt, kept readable) | 4.5:1 | 5.48 | 5.21 |
| `canvas` on `fg` | Selected text | 4.5:1 | 16.68 | 17.64 |

Every pairing passes in both themes. The tightest is the light theme's control border at 3.24:1.

## Type

One family: Geist Sans, self-hosted through `next/font`. Geist Mono is gone, and `code`, `kbd`, `samp` and `pre` inherit the sans. Numbers use the same family.

| Class | Size | Line height | Tracking | For |
| --- | --- | --- | --- | --- |
| `text-2xl` | 30px | 36px | -0.02em | Page titles |
| `text-lg` | 20px | 28px | -0.01em | Section headings |
| `text-base` | 15px | 24px | | Body (set on `<body>`) |
| `text-sm` | 13px | 20px | | Labels, meta, table cells, buttons, badges |

**Why four.** Each size has one job, so hierarchy comes from weight (400 body, 500 labels, buttons and table headers, 600 headings) and from `fg` against `muted`, not from yet another size. A fifth size would need a reason good enough to write down here. Body text is 15px, not 16, because this is a dense tool of tables and forms. The floor is 13px, not 12, because meta text is also muted, and muted 12px gets hard to read.

**Numbers.** Money, token counts, latency, file sizes and timestamps use `tabular-nums`, right-aligned in table columns, so digits line up and values don't jitter as they change. Geist has tabular figures; `/design-preview` shows the same column both ways.

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

- **Layout:** `containerClass` (max-w-5xl, 16px gutters on a phone, 24px from `sm`), shared by the header and pages; `pageClass`, the container for `<main>`; `panelClass`.
- **Type:** `pageTitleClass`, `sectionTitleClass`, `hintClass`, `labelClass`, `errorClass`, `linkClass`. Links are underlined so they don't rely on color.
- **Buttons:** `buttonClass` (primary, the only accent fill), `secondaryButtonClass`, `dangerButtonClass`, `ghostButtonClass`, `iconButtonClass`. Every variant is 36px tall with a 1px border (transparent where unseen), so the same label gives the same box in any variant or state. `disabled:` beats `hover:`.
- **Fields:** `inputClass` and `fileInputClass`, 36px to line up with buttons. The accent border on focus plus the global ring pulled in makes one 2px accent edge. `aria-invalid="true"` turns the border danger, and it stays danger while focused.
- **Tables:** `tableClass`, `thClass`, `tdClass`.
- **Badges:** `badgeClass` for any status; `reviewBadgeClass` for needs review only.
- **Added by the pages:** `submitButtonClass`, the primary button of a form that submits through a Server Action (pending is `aria-disabled`, so focus stays on it); `armedDangerButtonClass`, Delete once armed, filled red.

Focus is one global `:focus-visible` rule: a 2px accent outline at a 2px offset.

The site header (`src/app/components/site-header.tsx`) holds the skip link, the wordmark, a slot, and the toggle, and exports `MAIN_ID` for every page's `<main>`. `textTargetClass` gives a standalone text link a 24px target without moving the layout. `AccountControls` is the slot for signed-in pages.

## Pages

What each page does beyond the primitives, and why.

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
- The web address is derived from the name (accents folded, hyphens collapsed and trimmed) until the user types in the address field. Typed input is not auto-lowercased, to avoid cursor jumps; validation catches it.
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

- **Width.** No page scrolls wider than the viewport. Long filenames, emails and organization names wrap. The run history reflows into labelled blocks below 768px and keeps its table roles, so a screen reader still hears a table.
- **Targets.** Every control is at least 24 by 24 pixels (WCAG 2.5.8). Standalone text links and disclosure summaries get it from `textTargetClass`, which adds padding and cancels it with a negative margin, so the layout doesn't move. Links inside running text don't, so they can still wrap.
- **Keyboard.** A "Skip to content" link is the first stop on every page. It sits above the header until focused and jumps to `<main>`, which every page gives the shared id. `<main>` gets no `tabIndex`, which would draw a ring around the page and take focus on clicks. Tab order follows reading order. An armed Delete disarms on Escape, Cancel or leaving it.
- **Focus.** One global `:focus-visible` ring, the accent at 2px with a 2px offset; inputs pull it onto their border. No `outline-none` anywhere without a visible replacement, and no ancestor clips a ring. When an action removes the focused element, focus moves somewhere that says what happened: the Documents heading after a delete, the field in error after a rejected submit, "Check your email" after sign-up, the retry button after a failed upload.
- **Announcements.** Each status message comes from a region that is already in the page before its text changes, and is announced once. Progress and results are polite; errors that block the user are alerts. Polite and alert regions are siblings, never nested. An error on the field the user pressed Enter in is echoed in the alert region, because focus can't move to the field it's already on. The delete announcer clears before writing, so a second "Deleted" is read again.
- **Theme toggle.** No live region: its accessible name changes, which NVDA reads on the focused control. VoiceOver users hear the new name on refocus. `aria-pressed` with a fixed label would contradict the name saying what clicking does.
- **Contrast.** Every text node measured at least 4.5:1, including armed, error and disabled states, and control borders at least 3.24:1. No opacity modifier, gradient, shadow or blur is used anywhere.
- **Semantics.** One h1 per page, no skipped levels, header, nav for the breadcrumb and main landmarks, a label on every input, names on icon-only buttons, decorative SVGs hidden. Every page has its own title through the root layout's template (`%s · doc-intake`); the organization page's title is the organization's name.
- **Motion.** The only animation is the pending spinner, and it turns only under `prefers-reduced-motion: no-preference`.
- **Known limits.** The header email truncates on a phone; screen readers get the full address. During an upload the Upload button is disabled, so focus sits on the page body for the few seconds it takes, then returns to "Choose a file" or "Try again". Nothing was checked with a real screen reader, or in Safari or Firefox: "announced once" comes from logging each region's changes and each focus move.

### Error page

A page that throws while rendering gets `src/app/error.tsx` instead of Next's generic screen: one sentence, Try again (Next's `retry`, which refetches the segment), a way back to the organizations, and the error's digest as a reference that matches the server log. In production a Server Component's message is replaced by that digest, so the page never shows raw error text. There is no `global-error`: the root layout is static and can't throw.

There is deliberately no loading state for the organization page. A `loading.tsx` starts streaming before the page runs, and once streaming has started the status code is fixed at 200. A missing or non-member organization would then return 200 with the not-found content, and a signed-out visitor a streamed redirect instead of a real one.

## The design preview

The signed-in pages can't be seen without an account, so every state is rendered from fixture data on local pages under `src/app/design-preview/`. They are listed in `.git/info/exclude` and never committed, and no real page imports them. The proxy only refreshes sessions, so they load without signing in.

- `/design-preview`: every primitive, the four sizes and the swatches, in the current theme.
- `/design-preview/public`: the sign-in and sign-up forms in every state, driven by fake actions.
- `/design-preview/orgs`: the empty state, a long list with every role, and the create form's states.
- `/design-preview/tenant?view=owner|admin|member|empty-owner|empty-member|upload`: the organization page with every document status, fields, runs, and a live upload form whose fake calls fail on purpose for file names containing `fail-start`, `fail-name`, `fail-send`, `fail-size` or `fail-confirm`.
- `/design-preview/error`: a page that throws, to show the error page.

The real components render there because each page keeps fetching in `page.tsx` and presentation in components that take props, and the organization page's actions come through a context the fixture fills with fakes. Tailwind's scanner skips excluded paths, so `globals.css` registers the folder with `@source "./design-preview"`; in a clone without the folder that line compiles to nothing.

## Decisions under ambiguity

The rule was: take the simpler option, record it, keep going. Decisions about a single page are under Pages; these are the cross-cutting ones.

- **Two border tokens.** `line` and `line-strong`, not one: a single border color either fails 3:1 on inputs or makes every divider heavy.
- **accent-fg is the canvas color** of each theme, not pure white or black.
- **The accent passes 4.5:1 as text**, not just 3:1, so needs review can be orange text as well as a fill or ring.
- **Accent and danger stay apart** by hue (24.5° against 0°) and by form (fill, ring and badge against text and outline).
- **Disabled buttons use tokens:** a `line` fill or border with `muted` text. A disabled danger button looks like a disabled secondary one.
- **The destructive button fills red on hover**, so the click is deliberate.
- **Selection is inverted** (`fg` background, `canvas` text) instead of the browser's blue.
- **Placeholders are `muted`.** Tailwind's default, 50% of the text color, fails contrast.
- **No glass is enforced for blur only.** `--blur-*` is reset. Gradients and opacity modifiers can't be reset, so they're a review rule.
- **`font-mono` and `font-serif` don't exist.** Code-like elements inherit the sans.
- **Colors are hex, not oklch**, so the CSS, the contrast script and this table all show the same values.
- **Label swaps and width.** Buttons have a fixed height; width follows the label. A button whose label swaps (Extract / Extracting…) needs a `min-w-*` at the call site. A global minimum width would pad short labels like "Sign out".
- **Primary buttons are earned.** Upload turns primary only once a file is chosen. Extract is primary only until a document has results, then it becomes a secondary "Extract again". A page never shows a row of orange buttons.
- **Wordmark is text only** ("doc-intake", semibold), with no logo mark, because the accent is reserved.
- **Header height is h-14.** It shares `containerClass` with page content.
- **Signed-in slot.** `AccountControls` lives in `site-header.tsx`, so `/app` and `/app/[slug]` don't each keep a copy. "Signed in as" is hidden below `sm` and the email truncates.
- **not-found gets the header without account controls.** Reading the session there would make the 404 auth-aware.
- **Extraction bands.** Low is `accent` with an icon and "Check this", because a low field is what puts a document in needs review. Medium is plain `fg` with its clarifying question under the value. High is `muted`: it needs nothing from the reader.
- **Table headers are `font-medium`** (they were normal weight) in `thClass`.
- **A failed document or run gets a neutral badge.** Failure is a state; `danger` is for the error text that explains it.
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

