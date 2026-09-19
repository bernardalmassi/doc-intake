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
- Shadows blurred over 24px.
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
- Landing page only, a display face with a point of view plus a body face for reading at 17 to 19px, while inside /app the existing single family and four sizes stay as they are.
- Tabular numbers wherever a number appears.
- Whitespace is a feature, one thing per screen deserves attention.
- Asymmetry somewhere, on purpose.
- The headline says what this does and what it does when it is unsure.
- Motion: one idea, ease-out under 400ms, only on arrival or input.
- Product imagery is a real capture or a real recorded result.

## Self-review

Go through the page and list every element that is on the banned list, could be deleted with no loss of information, would sit unchanged on a generic SaaS template, makes a claim not on the true list, or uses a colour, radius or shadow not in the brief. Fix all of it, then show me the page and the list of what you changed.

The true list is what can be verified in this repo, plus the live run shown in Fig. 1 (the deployed app, 19 Sep 2026). Nothing else goes on the page.
