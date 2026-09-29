import { Fragment } from "react";
import { formatCount, formatSeconds, formatUsd, formatUtc } from "./format";
import { runFailureSentence } from "./messages";
import { type Glyph, StateGlyph } from "./state-glyph";
import type { RunRow } from "./types";

const PROVIDER_LABELS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI" };

// A run's result as a word and the state glyph it amounts to: succeeded is
// full, running half, failed and stalled crossed.
const RUN_STATUS: Record<string, { word: string; glyph: Glyph }> = {
  running: { word: "Running", glyph: "half" },
  succeeded: { word: "Succeeded", glyph: "full" },
  failed: { word: "Failed", glyph: "cross" },
};
const STALLED = { word: "Stalled", glyph: "cross" as Glyph };
const ABANDONED = { word: "Abandoned", glyph: "cross" as Glyph };

// A run the stale-run check ended because it stopped responding. It may
// have called a model, but nothing it did was recorded: no model, calls or
// tokens. Since 20260918000003 it is charged an estimate from its pages
// (cost_estimated); one ended before that has no cost at all. Either way
// it reads as abandoned, never as a failure with no model call.
export function isAbandoned(run: RunRow): boolean {
  return run.status === "failed" && run.error_code === "extraction.abandoned";
}

// What the Cost cell can say about a run:
//   recorded   the database priced it
//   estimated  charged at the dearest price on file, because the database
//              couldn't price the model that answered, or because the run
//              was abandoned and the stale-run check charged an estimate
//              bounded by its file (migration 20260918000003; see RunRow)
//   unknown    a provider may have been paid but no cost was recorded: still
//              running, abandoned before the reaper charged an estimate,
//              or a run that made model calls and was closed without its
//              usage (the Extract action did that before it charged
//              estimates)
//   none       no model call was made (a file whose contents didn't match
//              its type), so nothing was spent
type CostState = "recorded" | "estimated" | "unknown" | "none";

function costState(run: RunRow): CostState {
  if (run.cost_usd !== null) return run.cost_estimated ? "estimated" : "recorded";
  if (run.status === "running" || run.error_code === "extraction.abandoned" || run.attempts > 0) return "unknown";
  return "none";
}

function runTotals(runs: RunRow[]) {
  const total = runs.reduce((sum, run) => sum + (run.cost_usd === null ? 0 : Number(run.cost_usd)), 0);
  const states = runs.map(costState);
  // What the rows add up to as printed, each rounded to four decimals.
  const printed = runs.reduce(
    (sum, run) => sum + (run.cost_usd === null ? 0 : Math.round(Number(run.cost_usd) * 10_000)),
    0,
  );
  return {
    total,
    // how far the total is from that, in dollars (0 when they agree)
    rounding: Math.abs(printed - Math.round(total * 10_000)) / 10_000,
    estimated: states.filter((state) => state === "estimated").length,
    unknown: states.filter((state) => state === "unknown").length,
  };
}

// The history's summary line, on the control that opens it and at the
// head of the history: "Runs 3 · 2 failed · $0.0394 · 1 estimated". Counts
// are printed at zero ("0 failed"), and a cost that is an estimate or isn't
// known is said, never counted as zero. Set in the label face, so it reads
// in capitals.
export function runHistoryMeta(runs: RunRow[]): string {
  const { total, estimated, unknown } = runTotals(runs);
  // An abandoned run is counted as that, as its row reads, not as failed.
  const abandoned = runs.filter(isAbandoned).length;
  const failed = runs.filter((run) => run.status === "failed").length - abandoned;
  const head = `Runs ${runs.length} · ${failed} failed${abandoned > 0 ? ` · ${abandoned} abandoned` : ""}`;
  // "yet" only while a run is still going; a finished run's cost that
  // wasn't recorded won't arrive later. The table's total says the same.
  if (unknown === runs.length)
    return `${head} · cost not known${runs.some((run) => run.status === "running") ? " yet" : ""}`;
  const notes = [
    estimated > 0 ? `${estimated} estimated` : null,
    unknown > 0 ? `${unknown} not known` : null,
  ].filter(Boolean);
  return `${head} · ${formatUsd(total)}${notes.map((note) => ` · ${note}`).join("")}`;
}

// The register's columns, continued: the first is the state column (the
// result, as a glyph and a word), then the numbers, right-aligned in
// tabular figures, one unit and one number of decimals per column. Below
// xl (80rem), where the register is too narrow for seven columns, each run
// reflows into a block of label/value pairs in two columns;
// every cell shows its column name from data-label (the header row is
// visually hidden there but stays in the accessibility tree). The explicit
// table roles keep it a table for screen readers when CSS changes its
// display.
const th = "label whitespace-nowrap pt-4 pb-2 pr-4 align-bottom font-medium text-ink last:pr-0";
const td =
  "py-3 pr-4 align-top last:pr-0 max-xl:block max-xl:p-0 max-xl:before:label max-xl:before:block max-xl:before:content-[attr(data-label)]";
const num = "xl:text-right";

// Every run for one document, newest first: how it ended and after how
// many model calls, when it started (UTC, rendered on the server), which
// model answered, tokens in and out, cost and time taken, and why a failed
// run failed, as the catalog's sentence for its code (the stored text
// never gets this far). The total is the sum of the recorded costs, and
// agrees with the summary line.
export function RunHistory({ runs, filename, staleRun }: { runs: RunRow[]; filename: string; staleRun: boolean }) {
  const { total, rounding, estimated, unknown } = runTotals(runs);
  // No cost known for any run: the total says so in words, as the summary
  // line does, rather than printing $0.0000 beside "cost not known yet".
  const totalText =
    runs.length > 0 && unknown === runs.length
      ? runs.some((run) => run.status === "running")
        ? "Not known yet"
        : "Not known"
      : formatUsd(total);

  return (
    <table role="table" className="w-full text-left text-small max-xl:block">
      <caption className="sr-only">Extraction runs for {filename}, newest first</caption>
      <thead role="rowgroup" className="max-xl:sr-only">
        {/* Two rows, so the token columns share one head and their own
            heads stay short: In, Out. */}
        <tr role="row">
          <td role="cell" colSpan={3} />
          <th scope="colgroup" role="columnheader" colSpan={2} className={`${th} pb-0 text-right`}>
            Tokens
          </th>
          <td role="cell" colSpan={2} />
        </tr>
        <tr role="row">
          <th scope="col" role="columnheader" className={`${th} pt-1 xl:w-48`}>
            Result
          </th>
          <th scope="col" role="columnheader" className={`${th} pt-1`}>
            Started (UTC)
          </th>
          <th scope="col" role="columnheader" className={`${th} pt-1`}>
            Model
          </th>
          <th scope="col" role="columnheader" className={`${th} pt-1 text-right`}>
            <span className="sr-only">Tokens </span>In
          </th>
          <th scope="col" role="columnheader" className={`${th} pt-1 text-right`}>
            <span className="sr-only">Tokens </span>Out
          </th>
          <th scope="col" role="columnheader" className={`${th} pt-1 text-right`}>
            Cost
          </th>
          <th scope="col" role="columnheader" className={`${th} pt-1 text-right`}>
            Time
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup" className="max-xl:block">
        {runs.map((run, index) => {
          const stalled = index === 0 && staleRun && run.status === "running";
          const status = stalled
            ? STALLED
            : isAbandoned(run)
              ? ABANDONED
              : (RUN_STATUS[run.status] ?? { word: run.status, glyph: "empty" as Glyph });
          return (
            <Fragment key={run.id}>
              <tr
                role="row"
                className="border-t border-ink max-xl:grid max-xl:grid-cols-2 max-xl:gap-x-4 max-xl:gap-y-3 max-xl:py-3"
              >
                <td role="cell" data-label="Result" className={td}>
                  <span className="label inline-flex items-center gap-2 whitespace-nowrap">
                    <StateGlyph glyph={status.glyph} />
                    {status.word}
                  </span>
                  <span className="block">{describeAttempts(run, stalled)}</span>
                </td>
                <td role="cell" data-label="Started (UTC)" className={`${td} whitespace-nowrap`}>
                  <time dateTime={run.started_at}>{formatUtc(run.started_at, { zone: false })}</time>
                </td>
                <td role="cell" data-label="Model" className={`${td} max-xl:col-span-2`}>
                  {run.provider || run.model ? (
                    <>
                      {run.provider && <span className="block">{PROVIDER_LABELS[run.provider] ?? run.provider}</span>}
                      {run.model && <span className="block [overflow-wrap:break-word] xl:whitespace-nowrap">{run.model}</span>}
                    </>
                  ) : (
                    <span>
                      {run.status === "running" ? "Not known yet" : isAbandoned(run) ? "Not recorded" : "No model answered"}
                    </span>
                  )}
                </td>
                <td role="cell" data-label="Tokens in" className={`${td} ${num}`}>
                  <Tokens run={run} count={run.input_tokens} />
                </td>
                <td role="cell" data-label="Tokens out" className={`${td} ${num}`}>
                  <Tokens run={run} count={run.output_tokens} />
                </td>
                <td role="cell" data-label="Cost" className={`${td} ${num}`}>
                  <Cost run={run} />
                </td>
                <td role="cell" data-label="Time" className={`${td} ${num} whitespace-nowrap`}>
                  {run.latency_ms !== null
                    ? formatSeconds(run.latency_ms)
                    : run.status === "running" && !stalled
                      ? "Not known yet"
                      : "Not recorded"}
                </td>
              </tr>
              {(run.error_code || run.status === "failed") && (
                // Belongs to the run above it: no rule between them. A
                // failed run always says why, or that the page can't.
                <tr role="row" className="max-xl:block">
                  <td role="cell" colSpan={7} className="pb-3 max-xl:block xl:pl-48">
                    <p className="max-w-prose">{runFailureSentence(run.error_code)}</p>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
      <tfoot role="rowgroup" className="max-xl:block">
        <tr
          role="row"
          className="border-t border-ink max-xl:flex max-xl:flex-wrap max-xl:items-baseline max-xl:justify-between max-xl:gap-x-4 max-xl:py-3"
        >
          <th scope="row" role="rowheader" colSpan={5} className="py-3 pr-4 text-left align-top font-normal max-xl:p-0">
            <span className="label">
              Total, {runs.length} {runs.length === 1 ? "run" : "runs"}
              <span className="xl:hidden"> · {totalText}</span>
            </span>
            {estimated > 0 && (
              <span className="mt-1 block max-w-prose">
                Est. marks an estimate: a run whose cost couldn&apos;t be recorded is charged at the dearest
                price on file, and one that stopped responding is charged for its pages at the default model&apos;s
                price.
              </span>
            )}
            {rounding > 0 && (
              <span className="mt-1 block max-w-prose">
                Added up from the unrounded costs, so it differs by {formatUsd(rounding)} from the rows as printed.
              </span>
            )}
            {unknown > 0 && unknown < runs.length && (
              <span className="mt-1 block max-w-prose">
                Leaves out {unknown} {unknown === 1 ? "run" : "runs"} whose cost isn&apos;t known.
              </span>
            )}
          </th>
          <td role="cell" className="py-3 pr-4 text-right align-top max-xl:hidden">
            {totalText}
          </td>
          <td role="cell" className="max-xl:hidden" />
        </tr>
      </tfoot>
    </table>
  );
}

function describeAttempts(run: RunRow, stalled: boolean): string {
  if (isAbandoned(run)) return run.cost_estimated ? "Charged its estimate" : "Stopped responding";
  if (stalled) return "Stopped responding";
  if (run.attempts === 0) return run.status === "running" ? "In progress" : "No model call";
  return `${run.attempts} ${run.attempts === 1 ? "call" : "calls"}`;
}

// A paid run never reads as free: an estimate (a run whose model had no
// price, or an abandoned run) says EST. under the figure, so the digits
// keep their column, and a cost that wasn't recorded says it isn't known.
function Cost({ run }: { run: RunRow }) {
  const state = costState(run);
  if (state === "recorded") return <>{formatUsd(Number(run.cost_usd))}</>;
  if (state === "estimated") {
    return (
      <>
        {formatUsd(Number(run.cost_usd))}
        <span className="label block">
          <span className="sr-only">(</span>Est.<span className="sr-only">imated)</span>
        </span>
      </>
    );
  }
  // "yet" while it runs, as every other cell of a running run says.
  if (state === "unknown") return <>{run.status === "running" ? "Not known yet" : "Not known"}</>;
  return <>Nothing spent</>;
}

// Token counts. A run that made model calls but was closed without a model
// (the Extract action did that before it charged estimates) stored 0 for
// tokens that were never recorded, and an abandoned run recorded none, so
// both read as not known, not as 0.
function Tokens({ run, count }: { run: RunRow; count: number | null }) {
  if (run.error_code === "extraction.abandoned" || (run.model === null && run.attempts > 0 && run.status !== "running")) {
    return <>Not known</>;
  }
  if (count !== null) return <>{formatCount(count)}</>;
  return <>{run.status === "running" ? "Not known yet" : "None"}</>;
}
