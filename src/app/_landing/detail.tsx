"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DETAIL, FIELDS, PAGE, QUESTION_LEAD, SCAN_SIZES } from "./fig-1";
import scan from "./invoice-scan-page-1.jpg";
import styles from "./landing.module.css";
import { crisp, type Geometry, Leaders, markStyle, usePainted } from "./scan";

// The hero's object: a detail of Fig. 1's scan, larger than life, with the
// one field it was chosen for. The same file as the figure, cropped by
// CSS, and the same run's values, so the first screen already shows a real
// scan and a real Low.
//
// It arrives in reading order: the label and the badge, then the value,
// then the leader. The first two are CSS and need no script; the leader
// needs measurements and the decoded scan, and never starts before the
// value has landed.

const FIELD = FIELDS.find((field) => field.name === DETAIL.field);

// When the value's arrival ends (landing.module.css: 100ms + 120ms).
const VALUES_DONE_MS = 220;

export function Detail() {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [ready, setReady] = useState(false);

  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cropRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);

  const [painted, onLoad] = usePainted(imageRef);

  const measure = useCallback(() => {
    const root = rootRef.current?.getBoundingClientRect();
    const stage = stageRef.current?.getBoundingClientRect();
    const crop = cropRef.current?.getBoundingClientRect();
    const mark = markRef.current?.getBoundingClientRect();
    const label = labelRef.current?.getBoundingClientRect();
    const badge = badgeRef.current?.getBoundingClientRect();
    if (!root || !stage || !crop || !mark || !label || !badge) return;
    const start = `M ${Math.round(mark.right - root.left)} ${crisp(mark.top - root.top)}`;
    let path: string;
    if (label.left >= stage.right) {
      // Side by side: across the gap, to the label.
      const lane = crisp((stage.right + label.left) / 2 - root.left);
      const y = crisp(label.top - root.top + label.height / 2);
      path = `${start} H ${lane} V ${y} H ${Math.round(label.left - root.left - 8)}`;
    } else {
      // Stacked: down the stage's right margin, then in to the badge.
      const lane = crisp((crop.right + stage.right) / 2 - root.left);
      const y = crisp(badge.top - root.top + badge.height / 2);
      path = `${start} H ${lane} V ${y} H ${Math.round(badge.right - root.left + 8)}`;
    }
    setGeometry({ width: root.width, height: root.height, paths: { [DETAIL.field]: path } });
  }, []);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [rootRef.current, stageRef.current, labelRef.current]) {
      if (element) observer.observe(element);
    }
    document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [measure]);

  // The leader is the sequence's last step: not before the scan can be
  // painted, and not before the value has arrived, counted from first
  // paint, which is when the CSS steps started.
  useEffect(() => {
    if (!painted) return;
    const firstPaint = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    const wait = Math.max(0, firstPaint + VALUES_DONE_MS - performance.now());
    const timer = setTimeout(() => setReady(true), wait);
    return () => clearTimeout(timer);
  }, [painted]);

  if (!FIELD) return null;

  return (
    <figure ref={rootRef} className={styles.detail}>
      <div ref={stageRef} className={`${styles.stage} ${styles.detailStage}`}>
        <div
          ref={cropRef}
          className={styles.crop}
          style={{ aspectRatio: `${DETAIL.width} / ${DETAIL.height}` }}
          data-painted={painted || undefined}
        >
          <Image
            ref={imageRef}
            src={scan}
            preload
            alt="Detail of a scanned invoice: Date 05/03/2026, Due 04/06/2026, Terms 30 days net with “days” struck through in pen, and a handwritten note under them, “ext. to 04/06 per DK”."
            sizes={SCAN_SIZES}
            style={{
              width: `${(PAGE.width / DETAIL.width) * 100}%`,
              left: `${(-DETAIL.x / DETAIL.width) * 100}%`,
              top: `${(-DETAIL.y / DETAIL.height) * 100}%`,
            }}
            onLoad={onLoad}
          />
          {FIELD.marks.map((mark, index) => (
            <span
              key={mark.join(",")}
              ref={index === 0 ? markRef : undefined}
              className={styles.mark}
              style={markStyle(mark, DETAIL)}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>

      <figcaption className={styles.readout}>
        <p className={`${styles.readoutHead} ${styles.seqLabel}`}>
          <span ref={labelRef} className={styles.label}>
            {FIELD.label}
          </span>
          <span ref={badgeRef} className={`${styles.label} ${styles.key}`}>
            Low {FIELD.confidencePercent}%
          </span>
        </p>
        <div className={styles.seqValue}>
          <p className={styles.value}>{FIELD.value}</p>
          <p className={`${styles.small} ${styles.readoutNote}`}>{QUESTION_LEAD}</p>
          <p className={`${styles.small} ${styles.readoutNote}`}>
            A detail of{" "}
            <a href="#fig-1" className={styles.link}>
              Fig. 1
            </a>
            .
          </p>
        </div>
      </figcaption>

      {geometry && ready && <Leaders geometry={geometry} names={[DETAIL.field]} />}
    </figure>
  );
}
