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

**No flash.** `src/app/components/theme.ts` exports `themeScript`, a one-line inline `<script>` that the root layout puts in `<head>`. This follows Next 16's "Preventing flash before hydration" guide. It reads `localStorage.theme` inside a try/catch, accepts only `light` or `dark`, and sets the attribute. It is parser-blocking and sits after the stylesheet link and before `<body>`, so the attribute is set before any content exists to paint. `suppressHydrationWarning` on `<html>` covers that one attribute; it doesn't extend to children.

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

Focus is one global `:focus-visible` rule: a 2px accent outline at a 2px offset.

The site header (`src/app/components/site-header.tsx`) holds the wordmark, a slot, and the toggle. `AccountControls` is the slot for signed-in pages.

## The design preview

`src/app/design-preview/page.tsx` is a local fixture page with no auth and no data. It is listed in `.git/info/exclude` and never committed. Tailwind's scanner skips excluded paths, so `globals.css` registers the folder with `@source "./design-preview"`; in a clone without the folder that line compiles to nothing. Later items add their states to it.

## Decisions under ambiguity

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
- **Primary buttons stay where they were.** Upload and the per-row Extract kept `buttonClass` in the migration. Items 6 and 8 decide whether a per-row Extract stays primary.
- **Wordmark is text only** ("doc-intake", semibold), with no logo mark, because the accent is reserved.
- **Header height is h-14.** It shares `containerClass` with page content.
- **Signed-in slot.** `AccountControls` lives in `site-header.tsx`, so `/app` and `/app/[slug]` don't each keep a copy. "Signed in as" is hidden below `sm` and the email truncates.
- **not-found gets the header without account controls.** Reading the session there would make the 404 auth-aware. Its link text is item 6's to change.
- **The landing page keeps its "doc-intake" heading** under the wordmark until item 2 rewrites the page.
- **Extraction bands.** High and medium are plain `fg`. Low is `accent`, because a low field is what puts a document in needs review. The clarifying question moved from amber to `muted`. Item 9 redesigns this.
- **Table headers are `font-medium`** (they were normal weight) in `thClass`.
- **A failed document or run gets a neutral badge.** Failure is a state; `danger` is for the error text that explains it.
- **Theme icon.** It shows the theme clicking switches to (sun in dark, moon in light), matching the accessible name.
- **No color transitions**, so a theme switch changes everything at once instead of some buttons fading.
- **No cross-tab sync.** Another open tab picks up the choice on its next load.
- **No `theme-color` meta.** It can follow the OS but not the stored choice.
- **Title and description metadata are unchanged.** That's item 2.
