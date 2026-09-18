import { hintClass } from "@/app/ui";
import { BAND_LABELS, fieldLabel } from "./fields";
import { formatCount, formatUtc } from "./format";
import { AlertIcon, QuestionIcon } from "./icons";
import type { FieldRow, RunRow } from "./types";

// The fields of one document, in schema order. Each shows its value (or
// "Not found"), how sure the model was as a number and in words, the text
// it read the value from, and the question for a reviewer when there is
// one. Low-confidence fields are the ones to check: they say so in the
// accent, with an icon and words, because they are what sends a document
// to review. Values are shown as extracted, so they can be compared with
// the quoted source; only the document type's value is capitalized.
export function ExtractionPanel({ fields }: { fields: FieldRow[] }) {
  return (
    <div className="mt-3">
      <p className={`max-w-prose ${hintClass}`}>
        Confidence is how sure the model was of each value. Check anything marked low against the document.
      </p>
      <dl className="mt-2 divide-y divide-line">
        {fields.map((field) => (
          <Field key={field.name} field={field} />
        ))}
      </dl>
    </div>
  );
}

function Field({ field }: { field: FieldRow }) {
  const low = field.band === "low";
  const percent = Math.round(Number(field.confidence) * 100);
  const value =
    field.value !== null && field.name === "document_type"
      ? field.value.charAt(0).toUpperCase() + field.value.slice(1)
      : field.value;

  return (
    // Phone: label and confidence on one line, the value below. From sm:
    // label, value and confidence in three columns.
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
      <dt className="text-sm font-medium">{fieldLabel(field.name)}</dt>

      <dd className="col-span-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
        {value !== null ? (
          <p className="[overflow-wrap:anywhere]">{value}</p>
        ) : (
          <p className="text-muted">Not found</p>
        )}
        {field.source_text && (
          <blockquote className="mt-1 border-l-2 border-line pl-3 text-sm text-muted [overflow-wrap:anywhere]">
            <span className="sr-only">Read from: </span>“{field.source_text}”
          </blockquote>
        )}
        {field.clarifying_question && (
          <p className="mt-2 flex items-start gap-1.5 text-sm">
            <QuestionIcon className="mt-0.5 text-muted" />
            <span className="min-w-0">
              <span className="font-medium">To confirm:</span> {field.clarifying_question}
            </span>
          </p>
        )}
      </dd>

      <dd
        className={`col-start-2 row-start-1 text-right text-sm tabular-nums sm:col-start-3 ${
          low ? "font-medium text-accent" : field.band === "medium" ? "text-fg" : "text-muted"
        }`}
      >
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          {low && <AlertIcon />}
          <span className="sr-only">Confidence: </span>
          {BAND_LABELS[field.band] ?? field.band} · {percent}%
        </span>
        {low && (
          <>
            <span className="sm:hidden"> · </span>
            <span className="whitespace-nowrap sm:block">Check this</span>
          </>
        )}
      </dd>
    </div>
  );
}

// The latest run in one line. Replaced by the full run history next.
export function LatestRun({ run }: { run: RunRow }) {
  return (
    <p className={`mt-4 border-t border-line pt-3 ${hintClass} tabular-nums`}>
      Last run {run.status}
      {run.provider && ` with ${run.provider} (${run.model})`}
      {run.input_tokens !== null &&
        `, ${formatCount(run.input_tokens)} in / ${formatCount(run.output_tokens ?? 0)} out tokens`}
      {run.cost_usd !== null && `, $${Number(run.cost_usd).toFixed(4)}`}
      {run.latency_ms !== null && `, ${(run.latency_ms / 1000).toFixed(1)} s`}
      {" · "}
      {formatUtc(run.started_at)}
    </p>
  );
}
