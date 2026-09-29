import type { DocumentState } from "./document-state";

// The seven states as a word and a mark, the same everywhere a state is
// shown: the register's state column, its key, run rows and upload steps.
// The word carries the state; the mark is one 12px square drawn in ink
// whose fill says how far along it is (empty, dashed, half, full), or a
// cross for a failure. An upload still arriving fills from the bottom
// (lower), so it can't be read as a running extraction's left half. Only
// needs review is signal: filled, or only outlined (signal-outline) where
// a count of zero says nothing needs a person. Decorative: the word beside
// it says the same thing, so it is aria-hidden.

export type Glyph = "empty" | "dashed" | "lower" | "half" | "full" | "signal" | "signal-outline" | "cross";

export const STATE_GLYPHS: Record<DocumentState, Glyph> = {
  uploading: "lower",
  ready: "empty",
  queued: "dashed",
  running: "half",
  done: "full",
  "needs-review": "signal",
  failed: "cross",
};

export const STATE_WORDS: Record<DocumentState, string> = {
  uploading: "Uploading",
  ready: "Ready",
  queued: "Queued",
  running: "Running",
  done: "Done",
  "needs-review": "Needs review",
  failed: "Failed",
};

// 12 × 12, a 1.5px stroke inset by half its width so the square's outer
// edge is exactly the box.
export function StateGlyph({ glyph, className }: { glyph: Glyph; className?: string }) {
  const signal = glyph === "signal" || glyph === "signal-outline";
  return (
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      className={`shrink-0 ${signal ? "text-signal" : "text-ink"} ${className ?? ""}`}
    >
      {glyph === "half" && <rect x="0" y="0" width="6" height="12" fill="currentColor" />}
      {glyph === "lower" && <rect x="0" y="6" width="12" height="6" fill="currentColor" />}
      <rect
        x="0.75"
        y="0.75"
        width="10.5"
        height="10.5"
        fill={glyph === "full" || glyph === "signal" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={glyph === "dashed" ? "2 2" : undefined}
      />
      {glyph === "cross" && <path d="M1 1 11 11M11 1 1 11" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

// The state column's entry: the mark, then the word in the label face.
// count is printed beside needs review's word: "Needs review · 2".
export function StateMark({ state, count, className }: { state: DocumentState; count?: number; className?: string }) {
  return (
    <span className={`label inline-flex items-center gap-2 whitespace-nowrap text-ink ${className ?? ""}`}>
      <StateGlyph glyph={STATE_GLYPHS[state]} />
      <span>
        {STATE_WORDS[state]}
        {count !== undefined && ` · ${count}`}
      </span>
    </span>
  );
}
