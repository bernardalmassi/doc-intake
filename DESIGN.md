# Design rules

## Reference

Braun product manuals and Teenage Engineering. Technical, instructional, unembarrassed about being a machine. Labels not slogans. Tone: precise, plain, unhurried. Audience: an engineer deciding in forty seconds whether the person who built this knows what they are doing.

## Process

Before any UI code, write a design brief (palette as named tokens with hex, typefaces and why, the layout idea in two sentences, the one motion idea, how the reference shows up) and wait for approval. Build from the approved brief and say so if you drift. Run the self-review below before showing me anything.

## Banned unless I ask by name

- Near-black blue-grey backgrounds.
- Gradient blobs, glows, orbs.
- Gradient text.
- Purple as an accent.
- Glass.
- Icons in rounded badges, and icons in feature lists at all unless the icon carries meaning a word cannot.
- Three-column feature grids.
- Bento grids without real data.
- Fake charts, toggles, dashboards, cursors.
- Tilted or 3D screenshots.
- Shadows blurred over 24px. Inside /app, shadows of any size.
- Glowing borders.
- Testimonials, logo bars, star ratings, "trusted by" counts.
- Stock photos of people.
- Emoji in UI text.
- Pills above the headline.
- The words supercharge, seamless, effortless, unlock, elevate, empower, revolutionise, next-generation, AI-powered, all-in-one.
- Inter, Roboto, Open Sans or the system font as the display face, fine for body.
- Looping or pulsing animation.
- Marquees.
- More than one radius.

## Required

- One background, one ink, one accent, tokens named for their job.
- A display face with a point of view plus a body face for reading at 17 to 19px. The landing and /app use the same two, Archivo for display and labels and Geist for reading; /app keeps to the four sizes under /app below.
- Tabular numbers wherever a number appears.
- Whitespace is a feature, one thing per screen deserves attention.
- Asymmetry somewhere, on purpose.
- The headline says what this does and what it does when it is unsure.
- Motion: one idea, ease-out under 400ms, only on arrival or input.
- Product imagery is a real capture or a real recorded result.

## Documented exceptions

- **The scan's stage, landing page, light theme.** The rule is one background. A scan is the exception: in both themes it sits on the dark neutral, `#141413`, with a 1px edge in the light neutral, `#f2f1ec`. In dark that is the page's own background, so the exception only shows in light, where the stage is a second ground. It adds no colour: the stage is the light theme's ink, and its edge is the light theme's paper (`--stage` and `--stage-edge` in `globals.css` are aliases). The reason is the capture, which the rules say must be real and so can't be retouched to suit the page. Its paper is `#e5ded9`, 1.18:1 against the light ground, so on it the sheet has almost no edge and stops reading as an object; against the stage it is 13.85:1. Its corners show the scanner's bed, `#3d3b44`, 9.73:1 against the light ground, where they read as three dark wedges stuck to the page; against the stage they are 1.67:1 and recede. Measured on `invoice-scan-page-1.jpg`, 20 Sep 2026, and again that day on the file that replaced it (the PDF's own page image). Scope: the stage around a scan, in the hero's detail and in Fig. 1, and nothing else. No text sits on the stage, and no other element may take a second background on the strength of this.

## /app

The signed-in pages and the auth pages. Same product and same instrument as the landing: every rule above holds, and these add to it. Take principles from other products, never their layouts, copy or assets.

### Surface

- Tokens: `--paper` (the one background), `--ink` (all text, every rule and border), `--signal` (the accent), `--on-signal` (`#141413`, text on signal). No grey, no red, no raised surface, no translucent colour.
- Secondary text is told by size, weight and position, never by a lighter ink.
- Signal is never text on paper: 3.22:1 on the light ground. Where something must stand out, fill it: signal ground, `#141413` text, 5.06:1 in both themes.
- Signal goes on the Low tags, the needs-review glyph, the one primary action in a view, the focus ring, and the underline under the characters that decide a Low value. Nowhere else.
- Hover fills a button with ink and sets its label in paper, the primary included. No hover shade of signal. Disabled and pending are a dotted ink border on paper.
- Radius 0. No shadows. No boxes except buttons and inputs: structure is 1px ink rules. A line that takes a dropped file says so by thickening its two rules to 2px, never by a frame drawn inside it, which would touch its words.
- Every page is a register on the landing's frame: 82rem at most, 16px gutters on a phone, 40px from 48rem. Labels in an 11rem column on the left, content beside them, the right edge left open. On a phone the label sits over its content.

### Type

Two faces, four sizes, nothing under 12px, tabular figures on the whole body.

| Size | Set | Face | For |
| --- | --- | --- | --- |
| label | 12/16, uppercase, 0.08em | Archivo, width 125, 500 | State words, tags, column heads, section and form labels, buttons |
| small | 15/22 | Geist | Meta, quotes, questions, hints, table cells, errors |
| body | 18/28 | Geist | Values, sentences, inputs |
| display | 32 to 48px, 1.05, -0.02em | Archivo, width 100, 500 | The page title, once |

- The wordmark is Archivo at width 125 and the body size, lowercase, and links to `/`.
- A fifth size needs a reason written here first.

### Document states

- Seven states: uploading, ready, queued, running, done, needs review, failed. Each is a word, a glyph and one line saying what happens next. Word first, shape second, colour last.
- The glyph is one 12px square in ink: lower half filled for uploading, empty for ready, dashed for queued, left half filled for running, filled for done, filled signal for needs review, crossed for failed. With the word covered, uploading, queued, running and done still read apart in greyscale.
- The state is a prop, mapped once from the data. A view never works it out again from `status`.
- Uploading and running show their start time and the elapsed m:ss. No spinner, no dots, no bar, no percentage: there is no progress data. Queued says it is waiting, in words. An upload is uploading until its row is 10 minutes old; after that it never finished, and it is failed.
- One exit per state, named by its verb: Extract; nothing while uploading, queued or running; open the fields; go to the fields to check; one retry. A failure's exit follows its reason: Extract again where a retry can work, Delete where there is nothing to extract, Download where the reader is told to review it themselves.
- Failed says why, in the error catalogue's sentence. Never a code, raw text, or "Something went wrong" alone.
- Needs review carries its count beside the word ("Needs review · 2"), and the count matches the fields.

### Fields to check

- The one thing on the organization page that deserves attention is what needs a person. A document that needs review arrives open on its Low fields, under "To check · 2", numbered 1 of 2 and 2 of 2. Everything else folds under "Read · 9", Medium before High, in schema order.
- The first Low field starts on the first screen at 1440, within a screen and a half at 375, and within ten Tabs. Each Low row is focusable and named ("Due date, low confidence 59%, 2 of 2 to check").
- A Low row prints, never on hover: the label, the tag, the value, the words it was read from, and the question. The tag reads "Low 59%" in the label face on a signal fill. Only Low is filled; Medium and High are the same words in ink, with no fill and no border.
- Print the words as written beside the value as read, and underline in signal only the characters that decide the value: the date's digits, not the whole quote. That is what settles day against month.
- A question several fields share is printed once, after them, and each field says where it is.
- One confidence per field: a whole percent beside its band word. No decimals, no second score, no bar without its number.
- A machine's value is a proposal. No tick, and no "confirmed", "verified" or "approved": nothing in the data says a person checked it.
- Absence is an answer in words: "Not on the document". A value with no quote says why.
- Pair a value with its place on the page by number, leader or position, never by a colour per field.

### Runs

- One ruled row per run: result word, start (UTC), provider and model, model calls, tokens in, tokens out, cost in USD to four decimals, time taken in seconds to one decimal. Numbers right-aligned, one unit and one precision per column.
- A failed run's catalogue sentence sits on its own line under the row. An estimated cost says "Est." under its digits, so the digits keep their column.
- A missing number is a word ("Not known", "None", "Nothing spent"), never a bare dash, and never a zero: a total with no known cost says "Not known", not $0.0000. "Yet" only while a run is still going.
- Count everything, zeros included: "Runs 1 · 0 failed · $0.0242". An empty history is one line: "No runs yet."
- A number shown in two places is the same number in both.
- A refusal from a spend ceiling or the rate limit is said in words beside Extract.
- Where the columns don't fit, each run becomes a block of labelled pairs in the same order. Nothing scrolls sideways.

### Words

- Say what the role allows, never its name: "You can" and what follows. "Owner" on an organization of one reads wrong, and a role's name says nothing about the page.
- An error is the catalogue's sentence in ink against a 2px ink rule on its left. It stays where it appeared. No tinted box, no triangle, no toast.
- Waiting is said, not drawn: "Opening…", "Signing in…", "Uploading · 2 of 3". No skeleton, no shimmer, no spinner. A pending button repeats its own label with the verb in -ing: Create organization, Creating organization…. Waiting words never move what is already on the page.
- Empty names what is missing: "No organizations yet.", "No documents yet.", "No runs yet.", then what would be there.
- A button whose label repeats down the page carries its file's name for a screen reader.
- No "Oops", no jokes, no exclamation marks. Never smart, intelligent, powerful, ultimate, made simple, magic, blazing, cutting-edge, game-changing, AI agent.

### Motion and focus

- One motion: when a line opens, its contents arrive, fading in and settling 4px, 160ms, ease-out, once per opening. Nothing moves under reduced motion. No transition on `all`, no hover lift, no colour transition.
- One focus ring: 2px signal, 2px out, on every control. Tab order is reading order, with no positive tabindex. Every target is at least 24px.

### Never ship

Beyond the banned list, these mark an interface as generated rather than designed:

- A colour per field, type, state or link.
- Confidence as a colour or an icon alone, confidence with no band, several scores side by side, two-decimal percentages.
- Status as a coloured dot or a tinted pill in tiny text.
- A spinner or animated dots meaning "working", or a stage or progress bar with no data behind it.
- Window-chrome dots, floating chip cards, fake cursors, drag-and-drop animations.
- Isometric or 3D documents, neon, circuits, binary digits, orbs, halftone or dot-grid grounds.
- "AI" in the accent or as a badge, and a highlighted word in a heading.
- Announcement bars, a dialog on load, chat bubbles, "Ask AI", anything laid over the document.
- A "?" after every label, more than two controls on a row, thumbs up or down.
- BETA, NEW or Preview tags, pastel alert cards, warning triangles, toasts, confetti.
- Raw JSON as the way to read results.
- Skeletons standing in for content.
- A number that disagrees with itself somewhere else on the page.

## Self-review

Go through the page and list every element that is on the banned list, could be deleted with no loss of information, would sit unchanged on a generic SaaS template, makes a claim not on the true list, or uses a colour, radius or shadow not in the brief. Fix all of it, then show me the page and the list of what you changed.

In /app, measure rather than assert, in both themes at 375 and 1440: text at 4.5:1 or more, focus visible on every control, nothing moving under reduced motion, no horizontal scroll, and the six states told apart in greyscale.

The true list is what can be verified in this repo, plus the live run shown in Fig. 1 (the deployed app, 19 Sep 2026). Nothing else goes on the page.
