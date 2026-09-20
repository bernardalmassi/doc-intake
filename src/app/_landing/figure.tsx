"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FIELDS, PAGE, QUESTION, RUN, SCAN_FILE, SCAN_SIZES, type Fig1Field, type Point } from "./fig-1";
import scan from "./invoice-scan-page-1.jpg";
import styles from "./landing.module.css";
import { crisp, type Geometry, Leaders, usePainted } from "./scan";
import { type Frame, inWindow, viewFor, zoomOf } from "./walk";

// Fig. 1: three panels of different sizes on the page's grid. Page 1 of
// the scan, large, as paper on a dark stage; the eleven fields the run
// returned, a dense narrow column; the run's numbers, a small box.
//
// With this script it is a walkthrough, and the viewer drives it. The scan
// panel pins while the fields scroll past at their own height, and the
// field at the panel's top edge is the active one: the scan pans and
// scales to the words it quoted, then a line appears under them and a
// leader draws from there to the field. Before the first field it is the
// whole page. Scroll position is the only state: Next and Previous, the
// arrow keys in the list, a click and focus all jump the scroll to a
// field, so nothing can disagree with it, nothing plays on its own and
// nothing loops. The two Low fields are the tallest blocks, since they
// carry the long quotes and the question, so they hold the longest.
//
// Every state is this run's: the whole page, or one of its eleven fields
// (walk.ts). Without this script none of that exists: the page is whole,
// the list is as readable as ever, and no line or leader is drawn.
//
// Motion, one idea, in reading order: on arrival the labels, then the
// values (armed only when the figure starts below the screen); on a step
// the view (180ms), then the line and leader (160ms). Under 400ms,
// ease-out, once. With reduced motion a step is a jump.
//
// The fields are a list with one Tab stop, a roving tab index: the arrow
// keys move focus between fields, Home and End go to the ends, and focus
// alone makes a field the active one. Each item carries its position
// (aria-posinset, aria-setsize) and a written-out name.

// The view's move (landing.module.css). The line and the leader wait for
// it to end; if no end is reported, this long and a little more.
const PAN_MS = 180;

// As the app shows it: only the document type is capitalized.
function displayValue(field: Fig1Field): string {
  return field.name === "document_type" ? field.value.charAt(0).toUpperCase() + field.value.slice(1) : field.value;
}

// What a screen reader says for a field: written out, because the row's
// labels are uppercased by CSS and Chrome carries that into the name. The
// Low fields both get the question; on screen it is shown once.
function spokenName(field: Fig1Field): string {
  const low = field.band === "low";
  let name = `${field.label}, ${low ? "Low" : "High"} ${field.confidencePercent}%, ${displayValue(field)}`;
  if (field.sourceText) name += `, read from “${field.sourceText}”`;
  if (low) name += `. To confirm: ${QUESTION}`;
  return name;
}

const number = new Intl.NumberFormat("en-GB");

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// False in the server's HTML and while hydrating, true from the render
// right after, before the first paint: the walkthrough is this script's,
// so without it the figure stays as the server sent it.
const never = () => () => {};
const useScript = () =>
  useSyncExternalStore(
    never,
    () => true,
    () => false,
  );

export function Figure() {
  // The walkthrough exists.
  const walk = useScript();
  // The active field's index, or -1 for the whole page. Always derived
  // from the scroll position (readStep).
  const [step, setStep] = useState(-1);
  // The scan's window, measured.
  const [frame, setFrame] = useState<Frame | null>(null);
  // The state whose view has finished moving: its line and leader may show.
  const [settledKey, setSettledKey] = useState("");
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  // Said by a screen reader after Next or Previous, which don't move focus.
  const [announcement, setAnnouncement] = useState("");

  const gridRef = useRef<HTMLDivElement>(null);
  const figureRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const scanRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const anchorRefs = useRef<Record<string, HTMLElement | null>>({});
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  // The line a field's top crosses to become the active one, from the top
  // of the screen.
  const lineRef = useRef(0);

  // The scan has loaded and decoded: until then no line or leader is drawn.
  const [painted, onLoad] = usePainted(imageRef);

  const field = step >= 0 ? (FIELDS[step] ?? null) : null;
  const view = useMemo(() => (frame ? viewFor(field, frame) : null), [field, frame]);
  const key = `${step}:${frame?.width ?? 0}x${frame?.height ?? 0}`;
  const settled = settledKey === key;

  // Where the panel pins, and with it the line: beside the list, the top
  // edge of the scan's window; above it (stacked), just under the panel.
  // The list's heads pin to the same line (--line), and side by side the
  // list gets a tail, so the last field can reach the line before the
  // panel lets go.
  const layOut = useCallback(() => {
    const grid = gridRef.current;
    const figure = figureRef.current;
    const head = headRef.current;
    const list = listRef.current;
    const scanWindow = frameRef.current;
    if (!grid || !figure || !head || !list || !scanWindow) return;
    const pin = Number.parseFloat(getComputedStyle(figure).top) || 0;
    const figureBox = figure.getBoundingClientRect();
    const headHeight = head.getBoundingClientRect().height;
    const sideBySide = list.getBoundingClientRect().left >= figureBox.right;
    const line = pin + (sideBySide ? headHeight : figureBox.height + 8);
    lineRef.current = line;
    grid.style.setProperty("--line", `${line}px`);
    const last = itemRefs.current[FIELDS.length - 1]?.getBoundingClientRect().height ?? 0;
    list.style.paddingBottom = `${sideBySide ? Math.max(0, figureBox.height - headHeight - last) : 0}px`;
    setFrame((current) =>
      current?.width === scanWindow.clientWidth && current.height === scanWindow.clientHeight
        ? current
        : { width: scanWindow.clientWidth, height: scanWindow.clientHeight },
    );
  }, []);

  // The last field whose top has crossed the line.
  const readStep = useCallback(() => {
    let current = -1;
    for (const [index, item] of itemRefs.current.entries()) {
      if (!item || item.getBoundingClientRect().top > lineRef.current + 0.5) break;
      current = index;
    }
    setStep(current);
  }, []);

  // The leader, from the end of the field's first line on the page,
  // through any turns, across to the empty column, along it to the field,
  // and in. Measured from the scan as it is on screen, so only once the
  // view has stopped moving, and again whenever the list moves against it.
  const measure = useCallback(() => {
    const grid = gridRef.current?.getBoundingClientRect();
    const stage = stageRef.current?.getBoundingClientRect();
    const page = scanRef.current?.getBoundingClientRect();
    const list = listRef.current?.getBoundingClientRect();
    const anchor = field ? anchorRefs.current[field.name]?.getBoundingClientRect() : undefined;
    const [x, y, width] = field?.marks[0] ?? [];
    if (
      !settled ||
      !field ||
      !grid ||
      !stage ||
      !page ||
      !list ||
      !anchor ||
      x === undefined ||
      y === undefined ||
      width === undefined ||
      // Stacked (the fields under the scan): no room for a leader.
      list.left < stage.right
    ) {
      setGeometry(null);
      return;
    }
    const onScreen = ([px, py]: Point) => [
      page.left - grid.left + (px / PAGE.width) * page.width,
      page.top - grid.top + (py / PAGE.height) * page.height,
    ];
    const [start, ...turns] = [[x + width, y] as const, ...(field.via ?? [])].map(onScreen);
    // Down the middle of the empty column between the stage and the fields.
    const column = crisp((stage.right + list.left) / 2 - grid.left);
    const endY = crisp(anchor.top - grid.top + anchor.height / 2);
    const path =
      `M ${Math.round(start?.[0] ?? 0)} ${crisp(start?.[1] ?? 0)} ` +
      turns.map(([tx, ty]) => `L ${crisp(tx ?? 0)} ${crisp(ty ?? 0)} `).join("") +
      `H ${column} V ${endY} H ${Math.round(list.left - grid.left - 12)}`;
    setGeometry((current) =>
      current?.paths[field.name] === path && current.width === grid.width && current.height === grid.height
        ? current
        : { width: grid.width, height: grid.height, paths: { [field.name]: path } },
    );
  }, [field, settled]);

  // A ResizeObserver reports once when it starts observing, before the
  // next paint, so this is also the first reading.
  useLayoutEffect(() => {
    if (!walk) return;
    const observer = new ResizeObserver(() => {
      layOut();
      readStep();
    });
    for (const element of [gridRef.current, figureRef.current, frameRef.current, listRef.current]) {
      if (element) observer.observe(element);
    }
    // The display face arriving can rewrap the fields.
    document.fonts?.ready.then(layOut);
    return () => observer.disconnect();
  }, [walk, layOut, readStep]);

  // Scroll is the walkthrough's one input. One reading per frame.
  useEffect(() => {
    if (!walk) return;
    let queued = 0;
    const onScroll = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        readStep();
        measure();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(queued);
    };
  }, [walk, readStep, measure]);

  // A state is settled once its view has stopped moving: when the move
  // reports its end, which is when the scan can be measured where it will
  // stay. At once if the view doesn't move (Document type and Title quote
  // the same heading) or mustn't (reduced motion). The timer is for a move
  // that never reports, as when the tab is hidden.
  const transform = view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : "";
  const lastTransform = useRef("");
  useEffect(() => {
    const page = scanRef.current;
    if (!walk || !page || !transform) return;
    const still = lastTransform.current === transform || lastTransform.current === "" || reducedMotion();
    lastTransform.current = transform;
    const settle = () => setSettledKey(key);
    const onEnd = (event: TransitionEvent) => {
      if (event.target === page && event.propertyName === "transform") settle();
    };
    page.addEventListener("transitionend", onEnd);
    const timer = setTimeout(settle, still ? 0 : PAN_MS + 60);
    return () => {
      page.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
    };
  }, [walk, key, transform]);

  useLayoutEffect(measure, [measure]);

  // Arrival. Labels, then values: armed before the first paint after
  // hydration, and only if the figure starts below the screen. The
  // attributes are set on the element, not through state, so arming costs
  // no render; React leaves attributes it didn't write alone.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || grid.getBoundingClientRect().top < window.innerHeight) return;
    grid.dataset.armed = "";
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          grid.dataset.entered = "";
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  // Every way of choosing a field ends here: put its top on the line (or,
  // for the whole page, the first field's just short of it) and let the
  // scroll say what is active. A jump, not a glide: a glide would be a
  // second motion, longer than 400ms, that the viewer didn't make.
  function go(index: number) {
    const item = itemRefs.current[Math.max(index, 0)];
    if (!item) return;
    const offset = index < 0 ? -2 : 1;
    window.scrollTo({
      top: window.scrollY + item.getBoundingClientRect().top - lineRef.current + offset,
      behavior: "instant",
    });
    readStep();
  }

  // Next and Previous: the same, and said aloud, since focus stays on the
  // button.
  function press(index: number) {
    if (index < -1 || index >= FIELDS.length) return;
    go(index);
    const next = FIELDS[index];
    setAnnouncement(next ? `Field ${index + 1} of ${FIELDS.length}. ${spokenName(next)}` : "The whole page.");
  }

  // The arrow keys move focus, and focus makes the field the active one.
  function onListKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    const from = itemRefs.current.indexOf(event.target as HTMLLIElement);
    if (from === -1) return;
    const last = FIELDS.length - 1;
    const to =
      event.key === "ArrowDown"
        ? Math.min(from + 1, last)
        : event.key === "ArrowUp"
          ? Math.max(from - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    itemRefs.current[to]?.focus({ preventScroll: true });
  }

  const scanStyle = walk && view ? { width: view.base, transform } : undefined;
  // The page's 1px edge, beside the scan rather than on it, where it would
  // be scaled: the same box the transform gives the page, moved in step.
  const edgeStyle =
    walk && view
      ? {
          left: view.x,
          top: view.y,
          width: view.base * view.scale,
          height: (view.base * view.scale * PAGE.height) / PAGE.width,
        }
      : undefined;

  return (
    <div ref={gridRef} className={`${styles.grid} ${styles.figureGrid}`} data-walk={walk || undefined}>
      <figure ref={figureRef} className={styles.scanFigure}>
        <figcaption ref={headRef} className={styles.panelHead}>
          <div className={styles.panelTitle}>
            <h2 id="fig-1" className={styles.label}>
              Fig. 1
            </h2>
            <p className={styles.label}>Page 1 of {RUN.pages}</p>
          </div>
          {walk && (
            <div role="group" aria-label="Walk through the fields" className={styles.steps}>
              <p className={styles.label}>{step < 0 ? "Whole page" : `Field ${step + 1} of ${FIELDS.length}`}</p>
              <button
                type="button"
                className={`${styles.label} ${styles.action}`}
                aria-disabled={step < 0}
                onClick={() => press(step - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                className={`${styles.label} ${styles.action}`}
                aria-disabled={step >= FIELDS.length - 1}
                onClick={() => press(step + 1)}
              >
                Next
              </button>
            </div>
          )}
        </figcaption>

        <div ref={stageRef} className={styles.stage}>
          <div ref={frameRef} className={styles.scanFrame}>
            <div
              ref={scanRef}
              className={styles.scan}
              style={scanStyle}
              data-painted={painted || undefined}
              data-placed={scanStyle ? "" : undefined}
              data-live={settledKey !== "" || undefined}
            >
              <Image
                ref={imageRef}
                src={scan}
                alt="Page 1 of a scanned invoice from Northgate Fixings & Supply Co. to Bramhall Interiors Ltd: slightly skewed, with a coffee ring over the unit prices, “days” struck through in the terms, handwritten notes (“ext. to 04/06 per DK” under the dates, “1,546.26 o/s” under the total, “chased 12/5 - part pd 500”, “check line 3 qty w/ site”) and a RECEIVED 03 MAY 2026 stamp."
                sizes={SCAN_SIZES}
                onLoad={onLoad}
              />
            </div>
            {/* The lines, in the window and not on the scaled scan: there a
                position is rounded to a whole pixel before the scale, which
                at five times is two or three pixels on screen. */}
            {view &&
              settled &&
              painted &&
              field?.marks.map(([x, y, width]) => {
                const [left, top] = inWindow([x, y], view);
                return (
                  <span
                    key={`${x},${y},${width}`}
                    className={styles.mark}
                    style={{ left, top, width: width * zoomOf(view) }}
                    aria-hidden="true"
                  />
                );
              })}
            {edgeStyle && <div className={styles.edge} style={edgeStyle} data-live={settledKey !== "" || undefined} />}
          </div>
        </div>
      </figure>

      <ul ref={listRef} aria-label="The eleven fields" className={styles.fields} onKeyDown={onListKeyDown}>
        {FIELDS.map((item, index) => {
          const low = item.band === "low";
          return (
            <li
              key={item.name}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              tabIndex={index === Math.max(step, 0) ? 0 : -1}
              aria-label={spokenName(item)}
              aria-posinset={index + 1}
              aria-setsize={FIELDS.length}
              aria-current={index === step ? "true" : undefined}
              className={styles.field}
              onFocus={() => {
                if (walk && index !== step) go(index);
              }}
              onClick={() => {
                if (walk && index !== step) go(index);
              }}
            >
              <div className={`${styles.fieldHead} ${styles.seqLabel}`}>
                <span
                  ref={(element) => {
                    anchorRefs.current[item.name] = element;
                  }}
                  className={styles.label}
                >
                  {item.label}
                </span>
                <span className={`${styles.label} ${low ? styles.key : ""}`}>
                  {low ? "Low" : "High"} {item.confidencePercent}%
                </span>
              </div>
              <div className={styles.seqValue}>
                <p className={styles.value}>{displayValue(item)}</p>
                {item.sourceText && <p className={`${styles.small} ${styles.quote}`}>“{item.sourceText}”</p>}
                {item.name === "due_date" && (
                  <div className={styles.question}>
                    <p className={styles.label}>To confirm, both dates</p>
                    <p className={styles.small}>{QUESTION}</p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className={styles.caption}>
        <p className={`${styles.small} ${styles.captionText}`}>
          A live run on the deployed app, {RUN.date}. The scan is the uploaded file’s own image of page 1: A4 at{" "}
          {SCAN_FILE.dotsPerInch}&nbsp;dpi, JPEG. The document is fictional test data.
        </p>
        <div className={styles.runPanel}>
          <p className={styles.label}>Run</p>
          <dl className={`${styles.small} ${styles.run}`}>
            <dt>File</dt>
            <dd>
              {RUN.filename}, {RUN.pages} pages
            </dd>
            <dt>Result</dt>
            <dd>
              {RUN.fieldsFound} of {RUN.fieldsTotal} fields, 2 Low: sent to review
            </dd>
            <dt>Model</dt>
            <dd>
              {RUN.model}, {RUN.calls} call
            </dd>
            <dt>Tokens</dt>
            <dd>
              {number.format(RUN.inputTokens)} in, {number.format(RUN.outputTokens)} out
            </dd>
            <dt>Time</dt>
            <dd>{RUN.seconds} s</dd>
            <dt>Cost</dt>
            <dd>{RUN.costUsd} USD</dd>
          </dl>
        </div>
      </div>

      <p role="status" className={styles.srOnly}>
        {announcement}
      </p>

      {geometry && field && settled && painted && <Leaders geometry={geometry} names={[field.name]} />}
    </div>
  );
}
