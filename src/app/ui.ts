// Shared Tailwind class strings, built only on the tokens in globals.css
// (paper, ink, signal, on-signal) and the four sizes (label, small, body,
// display). DESIGN.md has the rules; the landing page on design-landing is
// the bar these follow.

// ---------------------------------------------------------------- layout

// The landing's frame: 82rem wide at most, 16px gutters on a phone and
// 40px from 48rem, so the wordmark and every page's left edge sit where the
// landing's do (x = 104 at 1440). Same for the site header and the page.
export const containerClass = "mx-auto w-full max-w-[82rem] px-4 md:px-10";

// A page's <main>. flex-1 because <body> is a full-height flex column.
export const pageClass = `${containerClass} flex-1 py-8 sm:py-10`;

// ------------------------------------------------------------------ type

export const pageTitleClass = "display";

// Section labels, as on the landing: Archivo, wide, uppercase, 12px.
export const sectionTitleClass = "label";

// Secondary text under a field, beside a control, or explaining a state.
// One ink: secondary is told by size, never by a grey.
export const hintClass = "text-small text-ink";

// Error text: ink words. What marks it as an error is the rule beside it
// (errorInkRuleClass), never a red or a signal, and never a state glyph:
// those mean a document's state.
export const errorClass = "text-small text-ink";

// Every error or refusal, on a field, a form or the organization page (a
// refused Extract, a failed download or upload): the words against a 2px
// ink rule on their left.
export const errorInkRuleClass = "border-l-2 border-ink pl-3";

// Underlined, so a link is told apart from the text around it by more
// than color. 1px at rest, 2px on hover, as on the landing.
export const linkClass = "text-ink underline decoration-1 underline-offset-[0.25em] hover:decoration-2";

// For a text link or text button that stands on its own (a breadcrumb,
// Cancel, the link under a form) and a disclosure's summary line: at least
// 24px tall, WCAG 2.5.8's minimum target, without making its line any
// taller. 2px of padding above and below, taken back by negative margins.
// A link also needs inline-block, which gives it the full line height; a
// link inside running text doesn't get this, so it can still wrap.
export const textTargetClass = "py-0.5 -my-0.5";

// Numbers are tabular everywhere (globals.css sets it on <body>).

// --------------------------------------------------------------- buttons

// The landing's .action: 40px tall, 20px of side padding, a 1px ink
// border, the label face. Hover fills it with ink and sets the text in
// paper (16.30:1 either theme); that is the re-derived hover for the
// primary too. Disabled and aria-disabled are the landing's dotted border
// on paper. disabled: rules are emitted after hover: rules, so a disabled
// button never shows a hover state. Width follows the label: a button
// whose label swaps (Extract / Extracting…) needs a min-w-* at the call
// site if its row must not move.
const buttonBase =
  "label inline-flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap border px-5 select-none hover:border-ink hover:bg-ink hover:text-paper disabled:cursor-not-allowed disabled:border-dotted disabled:border-ink disabled:bg-paper disabled:text-ink";

// Primary: the only filled button, and the only one in signal, with
// on-signal text (5.06:1). For the one action a view exists for (Sign in,
// Create organization, Upload).
export const buttonClass = `${buttonBase} border-signal bg-signal text-on-signal`;

// Everything that isn't the primary action.
export const secondaryButtonClass = `${buttonBase} border-ink bg-paper text-ink`;

// Destructive: the secondary look; the words say what it does, and arming
// it (armedDangerButtonClass) fills it.
export const dangerButtonClass = `${buttonBase} border-ink bg-paper text-ink`;

// Quiet: text only, the ink fill on hover. For low-stakes actions in
// dense places.
export const ghostButtonClass = `${buttonBase} border-transparent bg-paper text-ink`;

// Square button for a lone icon, the landing's theme toggle: a border on
// hover. Give it an aria-label.
export const iconButtonClass =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center border border-transparent text-ink hover:border-ink";

// ---------------------------------------------------------------- inputs

// A 1px ink box on paper, Geist at the body size. Focus is the global
// signal ring, 2px out. An invalid field keeps its box; its error below
// carries the mark.
const fieldBase =
  "mt-1 block w-full max-w-sm border border-ink bg-paper text-ink disabled:cursor-not-allowed disabled:border-dotted";

export const inputClass = `${fieldBase} h-10 px-3 text-body`;

// ---- public pages

// The sign-in and sign-up forms as a ruled register, the organization
// page's line: a 1px ink rule over each row, the label in an 11rem column
// (the register's state column) and the field or words in the next. The
// last row of the page closes it with a rule under it too. On a phone the
// label sits over the field. The label's top padding sets its line level
// with the text in a 40px field (the field's own 4px margin plus 12px).
export const formRowClass =
  "grid grid-cols-1 gap-y-2 border-t border-ink py-4 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-x-4";

export const formRowLabelClass = "label block text-ink md:pt-4";

// The register's width: the label column, the gap and a 24rem field.
export const formWidthClass = "max-w-[36rem]";

// The primary button of a form that submits through a Server Action. While
// the form is pending, set aria-disabled="true" and ignore the submit,
// rather than setting disabled: in Chromium a focused button that becomes
// disabled drops keyboard focus to <body>, and it doesn't come back when
// the button is enabled again. Looks the same as a disabled buttonClass.
export const submitButtonClass = `${buttonClass} aria-disabled:cursor-not-allowed aria-disabled:border-dotted aria-disabled:border-ink aria-disabled:bg-paper aria-disabled:text-ink`;

// ---- organization page

// Delete, once armed: the first click on a Delete button arms it and the
// second deletes. Filled ink, so the armed state reads at a glance, in the
// same box as every other button.
export const armedDangerButtonClass = `${buttonBase} border-ink bg-ink text-paper`;
