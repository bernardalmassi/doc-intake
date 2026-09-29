"use client";

import { useCallback, useEffect, useState } from "react";
import type { Mark } from "./fig-1";
import styles from "./landing.module.css";

// What the hero's detail and Fig. 1 share: the scan is only ever drawn on
// once it can be painted, a mark is placed by percentage of the pixels it
// was measured in, and a leader is a 1px path that draws once.

// True once the scan has loaded and decoded. The image can finish loading
// before hydration, before onLoad is attached, so this also checks on
// mount. Returns the state and the image's onLoad handler.
export function usePainted(imageRef: React.RefObject<HTMLImageElement | null>) {
  const [painted, setPainted] = useState(false);

  const whenDecoded = useCallback((image: HTMLImageElement | null) => {
    if (!image?.complete || image.naturalWidth === 0) return;
    image.decode().then(
      () => setPainted(true),
      () => {},
    );
  }, []);

  useEffect(() => whenDecoded(imageRef.current), [imageRef, whenDecoded]);

  return [painted, (event: React.SyntheticEvent<HTMLImageElement>) => whenDecoded(event.currentTarget)] as const;
}

// A rectangle of page 1, in the scan's pixels: the whole page for Fig. 1,
// the detail for the hero.
export type Region = { x: number; y: number; width: number; height: number };

export function markStyle([x, y, width]: Mark, region: Region): React.CSSProperties {
  return {
    left: `${((x - region.x) / region.width) * 100}%`,
    top: `${((y - region.y) / region.height) * 100}%`,
    width: `${(width / region.width) * 100}%`,
  };
}

// On the half pixel, so a 1px line covers one row of pixels, not two.
export const crisp = (n: number) => Math.round(n) + 0.5;

export type Geometry = { width: number; height: number; paths: Record<string, string> };

// The leaders, over whatever they were measured against. Each draws once,
// when it is mounted: the last step of a sequence, 160ms, so the whole
// sequence ends inside 400ms.
export function Leaders({ geometry, names }: { geometry: Geometry; names: readonly string[] }) {
  return (
    <svg
      className={styles.leaders}
      width={geometry.width}
      height={geometry.height}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      aria-hidden="true"
    >
      {names
        .filter((name) => geometry.paths[name])
        .map((name) => (
          <path key={name} d={geometry.paths[name]} pathLength={1} className={styles.leader} />
        ))}
    </svg>
  );
}
