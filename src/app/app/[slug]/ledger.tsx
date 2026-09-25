"use client";

import { createContext, useContext, useId, useState, useSyncExternalStore } from "react";
import { ChevronRightIcon } from "./icons";

// The register's moving parts, and only those: whether a line is open,
// whether its run history is, and the running clock. Everything they show
// is rendered on the server and passed in, so no field label, schema or
// catalog text is sent to the browser a second time.

const LineContext = createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(null);

// One document's line. The whole line opens and closes it: the button
// holds the state and the name, and its ::after covers the row, so the
// detail line is part of the target; the exit (Extract, Delete) sits above
// that cover. What the line opens onto stays in the page while closed
// (hidden), so a capture plan or a Tab-less script can reach its run
// history's control, which opens the line with it.
//
// head: the state mark and the file's name. detail: one sentence, what
// happens next. exit: the one action a closed line offers (DocumentActions,
// whose root sits in this grid). cue: a word beside the chevron, for a line
// whose exit is the opening itself ("Fields").
export function LedgerLine({
  defaultOpen,
  revealsFields,
  head,
  detail,
  exit,
  cue,
  children,
}: {
  defaultOpen: boolean;
  revealsFields: boolean;
  head: React.ReactNode;
  detail: React.ReactNode;
  exit?: React.ReactNode;
  cue?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();

  return (
    <LineContext value={{ open, setOpen }}>
      <div className="ledger-line relative py-4">
        <h3 className="ledger-head min-w-0">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            data-open={revealsFields ? "fields" : undefined}
            onClick={() => setOpen(!open)}
            className="ledger-toggle flex min-h-6 w-full min-w-0 cursor-pointer flex-col items-start gap-1 text-left after:absolute after:inset-0 after:content-[''] md:flex-row md:items-baseline md:gap-4"
          >
            {head}
          </button>
        </h3>
        <div className="ledger-detail mt-1 min-w-0 text-small md:pl-48">{detail}</div>
        {exit}
        <span aria-hidden="true" className="ledger-chevron pointer-events-none flex h-6 items-center justify-end gap-2">
          {cue && <span className="label hidden md:inline">{cue}</span>}
          <ChevronRightIcon className={open ? "rotate-90" : ""} />
        </span>
      </div>
      <div id={regionId} hidden={!open} className="ledger-arrive pb-8">
        {children}
      </div>
    </LineContext>
  );
}

// "Runs 3 · 2 failed · $0.0394 · 1 estimated", which opens the table under
// it. Pressed on a closed line (a script can), it opens the line too.
// action: the button that adds a run (Extract again), beside it.
export function RunsToggle({
  summary,
  action,
  children,
}: {
  summary: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const line = useContext(LineContext);
  const [open, setOpen] = useState(false);
  const tableId = useId();

  return (
    <div className="mt-4 border-t border-ink md:mt-6">
      <div className="ledger-runs-row flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={tableId}
          data-open="runs"
          onClick={() => {
            setOpen(!open);
            if (line && !line.open) line.setOpen(true);
          }}
          className="label flex min-h-6 cursor-pointer items-center gap-2 text-left"
        >
          <span>{summary}</span>
          <ChevronRightIcon className={open ? "rotate-90" : ""} />
        </button>
        {action}
      </div>
      {/* Under 80rem the table has no head, so its first rule would sit
          straight under the summary, which wraps to two lines at 375:
          the same 12px the summary has above it. */}
      <div id={tableId} hidden={!open} className="ledger-arrive max-xl:mt-3">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- clock

// Seconds since the epoch, once a second, in the browser only. The server
// snapshot is null, so the server renders no elapsed time and hydration
// matches; the browser adds it on its first render after.
function subscribe(tick: () => void) {
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
const serverSeconds = () => null;

// " · 0:40": time since `since`, as m:ss (h:mm:ss past an hour), tabular,
// updated once a second with no transition. A display clock: it reads the
// run's start time, which the page already has, and the browser's clock.
export function Elapsed({ since }: { since: string }) {
  const now = useSyncExternalStore(subscribe, nowSeconds, serverSeconds);
  const start = Math.floor(Date.parse(since) / 1000);
  if (now === null || Number.isNaN(start)) return null;
  const total = Math.max(0, now - start);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  const text = hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
  return (
    <>
      {" · "}
      <span>
        <span className="sr-only">running for </span>
        {text}
      </span>
    </>
  );
}
