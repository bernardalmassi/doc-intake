// Fig. 1's walkthrough pans and scales the scan to the words each field
// quoted. Whether those words end up inside the window is arithmetic, so
// it is checked here for every field of the run, in a window the size of a
// laptop's, a tablet's and a phone's.

import { describe, expect, it } from "vitest";
import { FIELDS, PAGE } from "@/app/_landing/fig-1";
import { inWindow, READABLE_ZOOM, viewFor, wholePage, WORDS_ABOVE, zoomOf } from "@/app/_landing/walk";

const FRAMES = [
  { name: "1440 × 900", width: 747, height: 740 },
  { name: "1024 × 768", width: 520, height: 608 },
  { name: "375 × 812", width: 311, height: 276 },
];

describe("Fig. 1's walkthrough", () => {
  for (const frame of FRAMES) {
    describe(`in a ${frame.name} window`, () => {
      it("fits the whole page inside the window, centred", () => {
        const view = wholePage(frame);
        const [left, top] = inWindow([0, 0], view);
        const [right, bottom] = inWindow([PAGE.width, PAGE.height], view);
        expect(left >= -0.01 && top >= -0.01 && right <= frame.width + 0.01 && bottom <= frame.height + 0.01).toBe(true);
        expect(left).toBeCloseTo(frame.width - right);
        expect(top).toBeCloseTo(frame.height - bottom);
      });

      for (const field of FIELDS) {
        it(`${field.name}: the words are in view, at a size that can be read`, () => {
          const view = viewFor(field, frame);
          if (field.marks.length === 0) {
            expect(view).toEqual(wholePage(frame));
            return;
          }
          expect(view.scale).toBeGreaterThanOrEqual(1);
          expect(zoomOf(view)).toBeLessThanOrEqual(1.1 + 1e-9);

          // The first mark is where the leader starts: always in view,
          // words and line, and never smaller than can be read.
          const [x, y, width] = field.marks[0] ?? [0, 0, 0];
          const [left, top] = inWindow([x, y - WORDS_ABOVE], view);
          const [right, bottom] = inWindow([x + width, y + 2], view);
          expect(left >= 0 && top >= 0 && right <= frame.width && bottom <= frame.height, "first mark").toBe(true);
          expect(zoomOf(view)).toBeGreaterThanOrEqual(READABLE_ZOOM - 1e-9);

          // The turns its leader takes on the page are in view too.
          for (const point of field.via ?? []) {
            const [px, py] = inWindow(point, view);
            expect(px >= 0 && py >= 0 && px <= frame.width && py <= frame.height, "via").toBe(true);
          }
        });
      }

      it("never shows dark inside the window on an axis the page could fill", () => {
        for (const field of FIELDS) {
          const view = viewFor(field, frame);
          const [left, top] = inWindow([0, 0], view);
          const [right, bottom] = inWindow([PAGE.width, PAGE.height], view);
          if (right - left >= frame.width) expect(left <= 0.01 && right >= frame.width - 0.01, field.name).toBe(true);
          if (bottom - top >= frame.height) expect(top <= 0.01 && bottom >= frame.height - 0.01, field.name).toBe(true);
        }
      });
    });
  }
});
