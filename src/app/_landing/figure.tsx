"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FIELDS, PAGE, QUESTION, RUN, type Fig1Field, type Mark, type Point } from "./fig-1";
import scan from "./invoice-scan-page-1.jpg";
import styles from "./landing.module.css";

// Fig. 1: page 1 of the scan beside the eleven fields the run returned. A
// line sits under the words each field quoted, and a leader runs from the
// end of that line to the field.
//
// The two Low fields are shown when their words first come on screen;
// pointing at or focusing a field shows that one. The lines on the scan
// are in the server's HTML, so the figure makes sense before hydration;
// the leaders need measurements, so they are drawn only in the browser and
// only side by side (64rem up).

// "low": both Low fields, the figure's state on arrival. Otherwise the
// name of the one field shown.
type Shown = string;
const LOW = "low";

type Geometry = { width: number; height: number; paths: Record<string, string> };

const isShown = (shown: Shown, field: Fig1Field) => (shown === LOW ? field.band === "low" : shown === field.name);

// The first line of the first Low field: the figure has arrived once it is
// in the upper half of the screen, where the fields it leads to are on
// screen too.
const ARRIVAL_MARK = FIELDS.find((f) => f.band === "low")?.marks[0];

function markStyle([x, y, width]: Mark): React.CSSProperties {
  return {
    left: `${(x / PAGE.width) * 100}%`,
    top: `${(y / PAGE.height) * 100}%`,
    width: `${(width / PAGE.width) * 100}%`,
  };
}

// As the app shows it: only the document type is capitalized.
function displayValue(field: Fig1Field): string {
  return field.name === "document_type" ? field.value.charAt(0).toUpperCase() + field.value.slice(1) : field.value;
}

// On the half pixel, so a 1px line covers one row of pixels, not two.
const crisp = (n: number) => Math.round(n) + 0.5;

const number = new Intl.NumberFormat("en-GB");

export function Figure() {
  const [shown, setShown] = useState<Shown>(LOW);
  const [arrived, setArrived] = useState(false);
  // Changes with every new selection, so the leaders remount and draw again.
  const [draws, setDraws] = useState(0);
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  const figureRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const scanRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const arrivalRef = useRef<HTMLSpanElement>(null);
  const anchorRefs = useRef<Record<string, HTMLElement | null>>({});

  const measure = useCallback(() => {
    const figure = figureRef.current?.getBoundingClientRect();
    const image = scanRef.current?.getBoundingClientRect();
    const list = listRef.current?.getBoundingClientRect();
    if (!figure || !image || !list) return;
    // Stacked (the fields under the scan): no room for a leader.
    if (list.left < image.right) {
      setGeometry(null);
      return;
    }
    const onPage = ([x, y]: Point) => [
      image.left - figure.left + (x / PAGE.width) * image.width,
      image.top - figure.top + (y / PAGE.height) * image.height,
    ];
    const gutter = crisp((image.right + list.left) / 2 - figure.left);
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
    for (const element of [figureRef.current, scanRef.current, listRef.current]) {
      if (element) observer.observe(element);
    }
    // The display face arriving can rewrap the fields.
    document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    const element = arrivalRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setArrived(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -45% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Input draws a leader even if the figure never "arrived": a visitor who
  // jumps past the dates and points at the total still gets one.
  function show(name: string) {
    if (shown === name) return;
    setShown(name);
    setDraws((n) => n + 1);
    setArrived(true);
  }

  return (
    <div ref={figureRef} className={`${styles.grid} ${styles.figure}`}>
      <div ref={frameRef} className={styles.scanFrame}>
        <div ref={scanRef} className={styles.scan}>
          <Image
            src={scan}
            alt="Page 1 of a scanned invoice from Northgate Fixings & Supply Co. to Bramhall Interiors Ltd: slightly skewed, with a coffee ring over the unit prices, “days” struck through in the terms, handwritten notes (“ext. to 04/06 per DK” under the dates, “1,546.26 o/s” under the total, “chased 12/5 - part pd 500”, “check line 3 qty w/ site”) and a RECEIVED 03 MAY 2026 stamp."
            sizes="(min-width: 82rem) 50rem, (min-width: 64rem) 62vw, (min-width: 48rem) 100vw, 40rem"
          />
          {FIELDS.filter((field) => isShown(shown, field)).flatMap((field) =>
            field.marks.map((mark) => (
              <span
                key={`${field.name}-${mark.join(",")}`}
                ref={mark === ARRIVAL_MARK ? arrivalRef : undefined}
                className={styles.mark}
                style={markStyle(mark)}
                aria-hidden="true"
              />
            )),
          )}
        </div>
      </div>

      <div className={styles.caption}>
        <div>
          <h2 id="fig-1" className={styles.label}>
            Fig. 1
          </h2>
          <p className={`${styles.small} ${styles.captionText}`}>
            A live run on the deployed app, {RUN.date}. Page 1 of the two-page scan is shown. The document is fictional
            test data.
          </p>
        </div>
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

      <ul ref={listRef} className={styles.fields} aria-label="The eleven fields">
        {FIELDS.map((field) => {
          const low = field.band === "low";
          return (
            <li
              key={field.name}
              className={styles.field}
              onMouseEnter={field.marks.length > 0 ? () => show(field.name) : undefined}
            >
              <div className={styles.fieldHead}>
                {field.marks.length > 0 ? (
                  <button
                    type="button"
                    ref={(element) => {
                      anchorRefs.current[field.name] = element;
                    }}
                    className={`${styles.label} ${styles.fieldName}`}
                    aria-pressed={isShown(shown, field)}
                    onFocus={() => show(field.name)}
                    onClick={() => show(field.name)}
                  >
                    {field.label}
                  </button>
                ) : (
                  <span className={styles.label}>{field.label}</span>
                )}
                <span className={`${styles.label} ${low ? styles.key : ""}`}>
                  <span className="sr-only">Confidence: </span>
                  {low ? "Low" : "High"} {field.confidencePercent}%
                </span>
              </div>
              <p className={styles.value}>{displayValue(field)}</p>
              {field.sourceText && (
                <p className={`${styles.small} ${styles.quote}`}>
                  <span className="sr-only">Read from: </span>“{field.sourceText}”
                </p>
              )}
              {field.name === "due_date" && (
                <div className={styles.question}>
                  <p className={styles.label}>To confirm, both dates</p>
                  <p className={styles.small}>{QUESTION}</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {geometry && arrived && (
        <svg
          className={styles.leaders}
          width={geometry.width}
          height={geometry.height}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          aria-hidden="true"
        >
          {FIELDS.filter((field) => isShown(shown, field) && geometry.paths[field.name]).map((field) => (
            <path
              key={`${field.name}-${draws}`}
              d={geometry.paths[field.name]}
              pathLength={1}
              className={`${styles.leader} ${draws === 0 ? styles.arrival : ""}`}
            />
          ))}
        </svg>
      )}
    </div>
  );
}
