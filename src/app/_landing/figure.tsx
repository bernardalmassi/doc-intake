"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FIELDS, PAGE, QUESTION, RUN, SCAN_SIZES, type Fig1Field, type Point } from "./fig-1";
import scan from "./invoice-scan-page-1.jpg";
import styles from "./landing.module.css";
import { crisp, type Geometry, Leaders, markStyle, type Region, usePainted } from "./scan";

// Fig. 1: three panels of different sizes on the page's grid. Page 1 of
// the scan, large, as paper on a dark stage; the eleven fields the run
// returned, a dense narrow column; the run's numbers, a small box. A line
// sits under the words each field quoted, and a leader runs from the end
// of that line to the field.
//
// The hero preloads the scan (the same URL), so it is here by the time
// anyone scrolls. The lines are in the server's HTML but stay hidden until
// the scan has loaded and decoded, and the leaders wait for the same, so
// nothing is ever drawn over an empty box. Leaders need measurements, so
// they are drawn only in the browser and only side by side (64rem up).
//
// Arrival, the page's one motion, in reading order: the fields' labels,
// then their values, as the figure comes on screen; then the two Low
// leaders, once the date lines are in the upper half of the screen, where
// both of their ends can be seen. The steps never overlap, and together
// they take under 400ms. It is armed only when the figure starts below
// the screen, and only by this script, so without it, or on a reload
// halfway down the page, nothing is ever hidden. Pointing at, clicking or
// focusing a field shows that one.
//
// The fields are a list with one Tab stop, a roving tab index: the arrow
// keys move focus between fields, Home and End go to the ends, and focus
// alone shows a field, so there is nothing to press. Each item carries its
// position (aria-posinset, aria-setsize) and a written-out name.

// "low": both Low fields, the figure's state on arrival. Otherwise the
// name of the one field shown.
type Shown = string;
const LOW = "low";

// The whole page: marks are placed by percentage of it.
const WHOLE_PAGE: Region = { x: 0, y: 0, ...PAGE };

// When the values' arrival ends (landing.module.css: 100ms + 120ms). The
// arrival leaders never start sooner after the labels did.
const VALUES_DONE_MS = 220;

const isShown = (shown: Shown, field: Fig1Field) => (shown === LOW ? field.band === "low" : shown === field.name);

// The first line of the first Low field: the figure has arrived once it is
// in the upper half of the screen, where the fields it leads to are on
// screen too.
const ARRIVAL_MARK = FIELDS.find((f) => f.band === "low")?.marks[0];

// The item that holds the list's Tab stop until a field is focused: the
// first Low field.
const FIRST_LOW = Math.max(
  0,
  FIELDS.findIndex((f) => f.band === "low"),
);

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

export function Figure() {
  const [shown, setShown] = useState<Shown>(LOW);
  const [arrived, setArrived] = useState(false);
  // Changes with every new selection, so the leaders remount and draw again.
  const [draws, setDraws] = useState(0);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  // The item with tabIndex 0: the list's one Tab stop.
  const [active, setActive] = useState(FIRST_LOW);

  const figureRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const scanRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const arrivalRef = useRef<HTMLSpanElement>(null);
  const anchorRefs = useRef<Record<string, HTMLElement | null>>({});
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  // When the labels started arriving; null until they have, or if the
  // figure was never armed.
  const enteredAt = useRef<number | null>(null);

  // The scan has loaded and decoded: until then no line or leader is drawn.
  const [painted, onLoad] = usePainted(imageRef);

  const measure = useCallback(() => {
    const figure = figureRef.current?.getBoundingClientRect();
    const stage = stageRef.current?.getBoundingClientRect();
    const image = scanRef.current?.getBoundingClientRect();
    const list = listRef.current?.getBoundingClientRect();
    if (!figure || !stage || !image || !list) return;
    // Stacked (the fields under the scan): no room for a leader.
    if (list.left < stage.right) {
      setGeometry(null);
      return;
    }
    const onPage = ([x, y]: Point) => [
      image.left - figure.left + (x / PAGE.width) * image.width,
      image.top - figure.top + (y / PAGE.height) * image.height,
    ];
    // Down the middle of the empty column between the stage and the fields.
    const gutter = crisp((stage.right + list.left) / 2 - figure.left);
    const end = Math.round(list.left - figure.left - 8);
    const paths: Record<string, string> = {};
    for (const field of FIELDS) {
      const anchor = anchorRefs.current[field.name]?.getBoundingClientRect();
      const [x, y, width] = field.marks[0] ?? [];
      if (!anchor || x === undefined || y === undefined || width === undefined) continue;
      // From the end of the first mark, along its line, through any turns,
      // then across to the gutter, down or up to the field, and in.
      const [start, ...turns] = [[x + width, y] as const, ...(field.via ?? [])].map(onPage);
      const endY = crisp(anchor.top - figure.top + anchor.height / 2);
      paths[field.name] =
        `M ${Math.round(start[0])} ${crisp(start[1])} ` +
        turns.map(([tx, ty]) => `L ${crisp(tx)} ${crisp(ty)} `).join("") +
        `H ${gutter} V ${endY} H ${end}`;
    }
    setGeometry({ width: figure.width, height: figure.height, paths });
  }, []);

  // On a phone the scan scrolls sideways: open it at the dates, which are
  // on the right.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame && frame.scrollWidth > frame.clientWidth) frame.scrollLeft = frame.scrollWidth;
  }, []);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [figureRef.current, stageRef.current, scanRef.current, listRef.current]) {
      if (element) observer.observe(element);
    }
    // The display face arriving can rewrap the fields.
    document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [measure]);

  // Labels, then values: armed before the first paint after hydration, and
  // only if the figure starts below the screen. The attributes are set on
  // the element, not through state, so arming costs no render; React leaves
  // attributes it didn't write alone.
  useLayoutEffect(() => {
    const figure = figureRef.current;
    if (!figure || figure.getBoundingClientRect().top < window.innerHeight) return;
    figure.dataset.armed = "";
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          figure.dataset.entered = "";
          enteredAt.current = performance.now();
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(figure);
    return () => observer.disconnect();
  }, []);

  // Then the leaders. After a jump straight to the dates both observers
  // fire together, so the leaders wait out the labels and values.
  useEffect(() => {
    const element = arrivalRef.current;
    const figure = figureRef.current;
    if (!element || !figure) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        const since = performance.now() - (enteredAt.current ?? performance.now());
        const wait = "armed" in figure.dataset ? Math.max(0, VALUES_DONE_MS - since) : 0;
        timer = setTimeout(() => setArrived(true), wait);
      },
      { rootMargin: "0px 0px -45% 0px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, []);

  // Input draws a leader even if the figure never "arrived": a visitor who
  // jumps past the dates and points at the total still gets one.
  function show(name: string) {
    if (shown === name) return;
    setShown(name);
    setDraws((n) => n + 1);
    setArrived(true);
  }

  // Focus or a click: the field takes the Tab stop and is shown.
  function take(index: number) {
    const field = FIELDS[index];
    if (!field) return;
    setActive(index);
    show(field.name);
  }

  // The arrow keys move focus, and focus moves the Tab stop (take, above).
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
    itemRefs.current[to]?.focus();
  }

  return (
    <div ref={figureRef} className={`${styles.grid} ${styles.figureGrid}`}>
      <figure className={styles.scanFigure}>
        <div className={styles.panelHead}>
          <h2 id="fig-1" className={styles.label}>
            Fig. 1
          </h2>
          <p className={styles.label}>Page 1 of {RUN.pages}</p>
        </div>

        <div ref={stageRef} className={styles.stage}>
          <div ref={frameRef} className={styles.scanFrame}>
            <div ref={scanRef} className={styles.scan} data-painted={painted || undefined}>
              <Image
                ref={imageRef}
                src={scan}
                alt="Page 1 of a scanned invoice from Northgate Fixings & Supply Co. to Bramhall Interiors Ltd: slightly skewed, with a coffee ring over the unit prices, “days” struck through in the terms, handwritten notes (“ext. to 04/06 per DK” under the dates, “1,546.26 o/s” under the total, “chased 12/5 - part pd 500”, “check line 3 qty w/ site”) and a RECEIVED 03 MAY 2026 stamp."
                sizes={SCAN_SIZES}
                onLoad={onLoad}
              />
              {FIELDS.filter((field) => isShown(shown, field)).flatMap((field) =>
                field.marks.map((mark) => (
                  <span
                    key={`${field.name}-${mark.join(",")}`}
                    ref={mark === ARRIVAL_MARK ? arrivalRef : undefined}
                    className={styles.mark}
                    style={markStyle(mark, WHOLE_PAGE)}
                    aria-hidden="true"
                  />
                )),
              )}
            </div>
          </div>
        </div>

        <figcaption className={styles.caption}>
          <p className={`${styles.small} ${styles.captionText}`}>
            A live run on the deployed app, {RUN.date}. The document is fictional test data.
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
        </figcaption>
      </figure>

      <ul ref={listRef} aria-label="The eleven fields" className={styles.fields} onKeyDown={onListKeyDown}>
        {FIELDS.map((field, index) => {
          const low = field.band === "low";
          return (
            <li
              key={field.name}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              tabIndex={index === active ? 0 : -1}
              aria-label={spokenName(field)}
              aria-posinset={index + 1}
              aria-setsize={FIELDS.length}
              className={styles.field}
              onFocus={() => take(index)}
              onClick={() => take(index)}
              onMouseEnter={field.marks.length > 0 ? () => show(field.name) : undefined}
            >
              <div className={`${styles.fieldHead} ${styles.seqLabel}`}>
                <span
                  ref={(element) => {
                    anchorRefs.current[field.name] = element;
                  }}
                  className={styles.label}
                >
                  {field.label}
                </span>
                <span className={`${styles.label} ${low ? styles.key : ""}`}>
                  {low ? "Low" : "High"} {field.confidencePercent}%
                </span>
              </div>
              <div className={styles.seqValue}>
                <p className={styles.value}>{displayValue(field)}</p>
                {field.sourceText && <p className={`${styles.small} ${styles.quote}`}>“{field.sourceText}”</p>}
                {field.name === "due_date" && (
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

      {geometry && arrived && painted && (
        <Leaders
          geometry={geometry}
          names={FIELDS.filter((field) => isShown(shown, field)).map((field) => field.name)}
          drawn={draws}
        />
      )}
    </div>
  );
}
