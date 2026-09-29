// Fig. 1's walkthrough: where the scan has to sit in its window so the
// words a field was read from can be seen. Pure arithmetic on the run's own
// marks (fig-1.ts), so tests/unit/landing-walk.test.ts can check every
// state without a browser. Nothing here adds a state: there is the whole
// page, and one view per field of the run.

import { PAGE, type Fig1Field } from "./fig-1";
import type { Region } from "./scan";

// The window the scan is seen through, in CSS pixels.
export type Frame = { width: number; height: number };

// Where the page sits in the window: its width at scale 1 (the whole page,
// fitted), then a scale and an offset, applied from its top left corner.
export type View = { base: number; scale: number; x: number; y: number };

// A mark is a line under words: the words stand above it. 64px of the
// scan covers its tallest quoted line, the INVOICE heading.
const WORDS_ABOVE = 64;
const LINE_BELOW = 8;

// Room around the words, in the scan's pixels.
const MARGIN = 48;

// Never larger than 1.1 CSS pixels to one of the scan's: past that the
// scan is only blur. And if showing every quoted place would leave less
// than 0.45, the words couldn't be read, so the view goes to the first
// place alone, which is where the leader starts.
const MAX_ZOOM = 1.1;
const READABLE_ZOOM = 0.45;

function around(field: Fig1Field, marks: Fig1Field["marks"]): Region {
  const points = [
    ...marks.flatMap(([x, y, width]) => [
      [x, y - WORDS_ABOVE],
      [x + width, y + LINE_BELOW],
    ]),
    // The turns the leader takes on the page have to be in view too.
    ...(field.via ?? []),
  ];
  const xs = points.map(([x]) => x ?? 0);
  const ys = points.map(([, y]) => y ?? 0);
  const left = Math.max(0, Math.min(...xs) - MARGIN);
  const top = Math.max(0, Math.min(...ys) - MARGIN);
  return {
    x: left,
    y: top,
    width: Math.min(PAGE.width, Math.max(...xs) + MARGIN) - left,
    height: Math.min(PAGE.height, Math.max(...ys) + MARGIN) - top,
  };
}

// The whole page, fitted inside the window and centred.
export function wholePage(frame: Frame): View {
  const base = Math.min(frame.width, (frame.height * PAGE.width) / PAGE.height);
  return {
    base,
    scale: 1,
    x: (frame.width - base) / 2,
    y: (frame.height - (base * PAGE.height) / PAGE.width) / 2,
  };
}

// The view for one field: null (the whole page) for a field that quotes
// nothing, as Summary does.
export function viewFor(field: Fig1Field | null, frame: Frame): View {
  const whole = wholePage(frame);
  if (!field || field.marks.length === 0 || frame.width <= 0 || frame.height <= 0) return whole;

  const perPixel = whole.base / PAGE.width;
  const zoomTo = (region: Region) =>
    Math.min(frame.width / region.width, frame.height / region.height, MAX_ZOOM);

  let region = around(field, field.marks);
  if (zoomTo(region) < READABLE_ZOOM) region = around(field, field.marks.slice(0, 1));

  // Never smaller than the whole page: at that size everything is in view.
  const scale = Math.max(1, zoomTo(region) / perPixel);
  const zoom = perPixel * scale;

  // Centre the words, then stop at the page's edges: no more dark than the
  // whole-page view already has on that axis.
  const place = (centre: number, size: number, window: number) => {
    const wanted = window / 2 - centre * zoom;
    const extent = size * zoom;
    return extent <= window ? (window - extent) / 2 : Math.min(0, Math.max(window - extent, wanted));
  };

  return {
    base: whole.base,
    scale,
    x: place(region.x + region.width / 2, PAGE.width, frame.width),
    y: place(region.y + region.height / 2, PAGE.height, frame.height),
  };
}

// Where a point of the page lands in the window under a view.
export function inWindow([x, y]: readonly [number, number], view: View): [number, number] {
  const zoom = (view.base / PAGE.width) * view.scale;
  return [view.x + x * zoom, view.y + y * zoom];
}

// CSS pixels to one pixel of the scan.
export const zoomOf = (view: View) => (view.base / PAGE.width) * view.scale;

export { READABLE_ZOOM, WORDS_ABOVE };
