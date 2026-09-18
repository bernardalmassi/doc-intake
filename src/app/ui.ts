// Shared Tailwind class strings, built only on the tokens in globals.css
// (canvas, surface, line, line-strong, fg, muted, accent, accent-hover,
// accent-fg, danger) and the four text sizes (sm, base, lg, 2xl). What each
// token is for, and why: DESIGN-NOTES.md. /design-preview renders all of
// these in both themes.

// ---------------------------------------------------------------- layout

// Same max width and gutters as the site header, so content lines up with
// the wordmark. 16px gutters on a phone.
export const containerClass = "mx-auto w-full max-w-5xl px-4 sm:px-6";

// A page's <main>. flex-1 because <body> is a full-height flex column.
export const pageClass = `${containerClass} flex-1 py-8 sm:py-10`;

// A bordered block on the raised surface. Add spacing at the call site.
export const panelClass = "rounded-lg border border-line bg-surface p-4 sm:p-5";

// ------------------------------------------------------------------ type

export const pageTitleClass = "text-2xl font-semibold";

export const sectionTitleClass = "text-lg font-semibold";

// Secondary text under a field, beside a control, or explaining a state.
export const hintClass = "text-sm text-muted";

export const labelClass = "block text-sm font-medium text-fg";

// Error text. Danger red, never the accent: an error must not read as
// "needs review".
export const errorClass = "text-sm text-danger";

// Underlined, so a link is told apart from the text around it by more
// than color.
export const linkClass =
  "text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg";

// Money, token counts, latency, sizes and times: add `tabular-nums` so
// digits line up in columns and don't jitter as values change.

// --------------------------------------------------------------- buttons

// Fixed height and centred content, so a label change or a status message
// next to the button never changes its height. Width follows the label: a
// button whose label swaps (Extract / Extracting…) needs a min-w-* at the
// call site if its row must not move. disabled: rules are emitted after
// hover: rules, so a disabled button never shows a hover state. Every
// variant has a 1px border (transparent where unseen) so the same label is
// the same size in any variant. Padding and border color are per variant
// so no two classes in one string set the same property.
const buttonBase =
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border text-sm font-medium select-none disabled:cursor-not-allowed";

// Primary: the only filled button, and the only one in the accent. For
// the action a view exists for (Sign in, Create organization, Upload), not
// for navigation or anything reversible on the side.
export const buttonClass = `${buttonBase} border-transparent px-3 bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-line disabled:text-muted`;

// Everything that isn't the primary action.
export const secondaryButtonClass = `${buttonBase} border-line-strong px-3 text-fg hover:border-fg disabled:border-line disabled:text-muted`;

// Destructive. Danger border and text; fills on hover so the click is
// deliberate.
export const dangerButtonClass = `${buttonBase} border-danger px-3 text-danger hover:bg-danger hover:text-canvas disabled:border-line disabled:bg-transparent disabled:text-muted`;

// Quiet: text only, a fill on hover. For low-stakes actions in dense
// places (header, table rows).
const ghost =
  "border-transparent text-muted hover:bg-line hover:text-fg disabled:bg-transparent disabled:text-muted";

export const ghostButtonClass = `${buttonBase} px-3 ${ghost}`;

// Square ghost button for a lone icon. Give it an aria-label.
export const iconButtonClass = `${buttonBase} w-9 ${ghost}`;

// ---------------------------------------------------------------- inputs

// The focus state is the accent border plus the global focus ring pulled
// in to sit on it, so the edge reads as one 2px accent line. Set
// aria-invalid="true" (and aria-describedby to the error) on a field the
// server rejected: its border turns danger, and stays danger while focused,
// with the accent ring outside it.
const fieldBase =
  "mt-1 block w-full max-w-sm rounded-md border border-line-strong bg-surface text-fg focus:border-accent focus-visible:outline-1 focus-visible:outline-offset-0 aria-invalid:border-danger disabled:cursor-not-allowed disabled:border-line disabled:text-muted";

export const inputClass = `${fieldBase} h-9 px-3 text-base`;

// <input type="file">: the picker button is styled as a secondary button.
export const fileInputClass = `${fieldBase} h-9 pr-3 pl-1 text-sm file:mr-3 file:h-7 file:cursor-pointer file:rounded file:border file:border-line-strong file:bg-canvas file:px-3 file:text-sm file:font-medium file:text-fg hover:file:border-fg`;

// ---------------------------------------------------------------- tables

export const tableClass = "w-full text-left text-sm";

// Header cell. Columns of numbers also get `text-right tabular-nums`.
export const thClass = "py-2 pr-4 font-medium text-muted";

// Body cell, with the row divider.
export const tdClass = "border-t border-line py-2 pr-4 align-top";

// ---------------------------------------------------------------- badges

const badgeBase =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2 text-sm";

// A status: pending, processing, extracted, failed, a run's status.
export const badgeClass = `${badgeBase} border-line-strong text-muted`;

// needs_review, and only that. The accent marks what a person must look at.
export const reviewBadgeClass = `${badgeBase} border-accent font-medium text-accent`;

// ---- public pages

// The primary button of a form that submits through a Server Action. While
// the form is pending, set aria-disabled="true" and ignore the submit,
// rather than setting disabled: in Chromium a focused button that becomes
// disabled drops keyboard focus to <body>, and it doesn't come back when
// the button is enabled again. Looks the same as a disabled buttonClass.
export const submitButtonClass = `${buttonClass} aria-disabled:cursor-not-allowed aria-disabled:bg-line aria-disabled:text-muted`;

// ---- organization page

// Delete, once armed: the first click on a Delete button arms it and the
// second deletes. Filled danger, so the armed state reads at a glance, in
// the same box as every other button.
export const armedDangerButtonClass = `${buttonBase} border-danger px-3 bg-danger text-canvas disabled:border-line disabled:bg-transparent disabled:text-muted`;
