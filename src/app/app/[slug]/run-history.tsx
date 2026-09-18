import { Fragment } from "react";
import { badgeClass, errorClass } from "@/app/ui";
import { formatCount, formatSeconds, formatUsd, formatUtc } from "./format";
import { AlertIcon } from "./icons";
import { describeRunError } from "./messages";
import type { RunRow } from "./types";

const PROVIDER_LABELS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI" };

const RUN_STATUS_LABELS: Record<string, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

// A run whose cost the database doesn't know: still running, or abandoned
// and failed by the stale-run check. A run that failed before any model
// call (a file whose contents didn't match its type) also has no cost, but
// nothing was spent, so it counts as nothing.
function costUnknown(run: RunRow): boolean {
  return run.cost_usd === null && (run.status === "running" || (run.error ?? "").startsWith("abandoned"));
}

function runTotals(runs: RunRow[]) {
  const total = runs.reduce((sum, run) => sum + (run.cost_usd === null ? 0 : Number(run.cost_usd)), 0);
  return { total, unknown: runs.filter(costUnknown).length };
}

// The closed disclosure's summary: "3 runs · $0.0231 total", and says so
// when a cost isn't known rather than counting it as zero.
export function runHistoryMeta(runs: RunRow[]): string {
  const { total, unknown } = runTotals(runs);
  const count = `${runs.length} ${runs.length === 1 ? "run" : "runs"}`;
  if (unknown === runs.length) return `${count} · cost not known yet`;
  return `${count} · ${formatUsd(total)} total${unknown > 0 ? ` · ${unknown} not known` : ""}`;
}

// Header and body cells. From md up this is a table with right-aligned
// numbers; below md each run reflows into a two-column block, and every cell
// shows its column name from data-label (the header row is visually
// hidden there but stays in the accessibility tree).
const th = "whitespace-nowrap py-2 pr-4 align-bottom font-medium text-muted last:pr-0";
const td =
  "py-2 pr-4 align-top last:pr-0 max-md:block max-md:p-0 max-md:before:block max-md:before:text-muted max-md:before:content-[attr(data-label)]";
const num = "tabular-nums md:text-right";

// Every run for one document, newest first: when it started (UTC, rendered
// on the server), how it ended and after how many model calls, which model
// answered, tokens in and out, cost and time taken, and the stored error
// of a failed run, first as a sentence and then as stored. The total is
// the sum of the recorded costs.
export function RunHistory({ runs, filename, staleRun }: { runs: RunRow[]; filename: string; staleRun: boolean }) {
  const { total, unknown } = runTotals(runs);

  return (
    <div className="mt-3">
      <table className="w-full text-left text-sm max-md:block">
        <caption className="sr-only">Extraction runs for {filename}, newest first</caption>
        <thead className="max-md:sr-only">
          <tr>
            <th scope="col" className={th}>
              Started (UTC)
            </th>
            <th scope="col" className={th}>
              Result
            </th>
            <th scope="col" className={th}>
              Model
            </th>
            <th scope="col" className={`${th} text-right`}>
              Tokens in
            </th>
            <th scope="col" className={`${th} text-right`}>
              Tokens out
            </th>
            <th scope="col" className={`${th} text-right`}>
              Cost
            </th>
            <th scope="col" className={`${th} text-right`}>
              Time taken
            </th>
          </tr>
        </thead>
        <tbody className="max-md:block">
          {runs.map((run, index) => {
            const stalled = index === 0 && staleRun && run.status === "running";
            return (
              <Fragment key={run.id}>
                <tr className="border-t border-line max-md:grid max-md:grid-cols-2 max-md:gap-x-4 max-md:gap-y-2 max-md:py-3">
                  <td data-label="Started (UTC)" className={`${td} whitespace-nowrap tabular-nums max-md:col-span-2`}>
                    <time dateTime={run.started_at}>{formatUtc(run.started_at, { zone: false })}</time>
                  </td>
                  <td data-label="Result" className={td}>
                    <span className={badgeClass}>
                      {stalled ? "Stalled" : (RUN_STATUS_LABELS[run.status] ?? run.status)}
                    </span>
                    <span className="mt-1 block text-muted tabular-nums">{describeAttempts(run, stalled)}</span>
                  </td>
                  <td data-label="Model" className={td}>
                    {run.provider ? (
                      <>
                        {PROVIDER_LABELS[run.provider] ?? run.provider}
                        <span className="block text-muted [overflow-wrap:anywhere]">{run.model}</span>
                      </>
                    ) : (
                      <Missing label={run.status === "running" ? "Not known yet" : "No model answered"} />
                    )}
                  </td>
                  <td data-label="Tokens in" className={`${td} ${num}`}>
                    {run.input_tokens !== null ? formatCount(run.input_tokens) : <Missing label="None recorded" />}
                  </td>
                  <td data-label="Tokens out" className={`${td} ${num}`}>
                    {run.output_tokens !== null ? formatCount(run.output_tokens) : <Missing label="None recorded" />}
                  </td>
                  <td data-label="Cost" className={`${td} ${num}`}>
                    {run.cost_usd !== null ? (
                      <span title={`${Number(run.cost_usd)} USD`}>{formatUsd(Number(run.cost_usd))}</span>
                    ) : (
                      <Missing label={costUnknown(run) ? "Not known" : "Nothing spent"} />
                    )}
                  </td>
                  <td data-label="Time taken" className={`${td} ${num}`}>
                    {run.latency_ms !== null ? formatSeconds(run.latency_ms) : <Missing label="Not recorded" />}
                  </td>
                </tr>
                {run.error && (
                  // Belongs to the run above it: no divider between them.
                  <tr className="max-md:block">
                    <td colSpan={7} className="pb-3 max-md:block">
                      <p className={`flex items-start gap-1.5 ${errorClass}`}>
                        <AlertIcon className="mt-0.5" />
                        <span className="min-w-0">{describeRunError(run.error)}</span>
                      </p>
                      <p className="mt-1 pl-5.5 text-muted [overflow-wrap:anywhere]">
                        <span className="font-medium">Stored error:</span> {run.error}
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        {runs.length > 1 && (
          <tfoot className="max-md:block">
            <tr className="border-t border-line-strong max-md:flex max-md:items-baseline max-md:justify-between max-md:gap-4 max-md:py-3">
              <th scope="row" colSpan={5} className="py-2 pr-4 font-medium max-md:p-0">
                Total for {runs.length} runs
                {unknown > 0 && (
                  <span className="block font-normal text-muted">
                    Leaves out {unknown} {unknown === 1 ? "run" : "runs"} whose cost isn&apos;t known.
                  </span>
                )}
              </th>
              <td className="py-2 pr-4 text-right font-medium tabular-nums max-md:p-0">{formatUsd(total)}</td>
              <td className="max-md:hidden" />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function describeAttempts(run: RunRow, stalled: boolean): string {
  if (stalled) return "Stopped responding";
  if (run.attempts === 0) return run.status === "running" ? "In progress" : "No model call";
  return `${run.attempts} model ${run.attempts === 1 ? "call" : "calls"}`;
}

// An empty cell: a dash to see, words to hear.
function Missing({ label }: { label: string }) {
  return (
    <>
      <span aria-hidden="true" className="text-muted">
        —
      </span>
      <span className="sr-only">{label}</span>
    </>
  );
}
