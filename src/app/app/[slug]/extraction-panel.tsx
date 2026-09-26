import { BAND_LABELS, fieldLabel } from "./fields";
import { ChevronRightIcon } from "./icons";
import { quoteParts } from "./quote-marks";
import type { FieldRow } from "./types";

// A document's fields, in the register's two columns: the label, the band
// and its number in the state column, the value and its evidence under the
// name. What needs a person comes first: the Low fields, numbered, under
// "To check · 2", each with its value, the words it was read from (plain,
// with only the characters that decide the value underlined in signal, the
// landing's mark) and the question, all printed. When every field to check
// asks the same question (gateFields asks one question about both dates),
// it is printed once, after them, and each field says where it is.
// Everything else follows under "Read · 9", Medium first (with its
// question), then High, each group in schema order; when there is
// something to check, that group is folded to one line.
//
// Values are shown as extracted, so they can be compared with the quoted
// source; only the document type's value is capitalized. Nothing here
// confirms anything: there is no tick and no "confirmed", because nothing
// in the data can say a person checked it.

const columns = "md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-x-4";

export function ExtractionPanel({ fields }: { fields: FieldRow[] }) {
  const low = fields.filter((field) => field.band === "low");
  const rest = [
    ...fields.filter((field) => field.band === "medium"),
    ...fields.filter((field) => field.band !== "low" && field.band !== "medium"),
  ];

  const first = low[0]?.clarifying_question ?? null;
  const shared =
    low.length > 1 && first !== null && low.every((field) => field.clarifying_question === first) ? first : null;
  const sharedId = `shared-question-${low[0]?.document_id ?? "none"}`;

  return (
    <section aria-label="Extracted fields">
      {low.length > 0 && (
        <div>
          <div className={`${columns} items-baseline`}>
            <h4 className="label">To check · {low.length}</h4>
            <p className="mt-1 text-small md:mt-0">Compare each value with the words it was read from.</p>
          </div>
          <ol className="mt-3">
            {low.map((field, index) => (
              <LowField
                key={field.name}
                field={field}
                number={index + 1}
                of={low.length}
                sharedQuestionId={shared ? sharedId : null}
              />
            ))}
          </ol>
          {shared && (
            // After the fields it is about, so the values and their quotes
            // come first, and in the same two columns as a field.
            <p id={sharedId} className={`${columns} border-t border-ink py-4 text-small`}>
              <span className="flex flex-wrap gap-x-3 md:flex-col md:gap-y-2">
                <span className="label">To confirm</span>
                <span className="label">{low.length === 2 ? "1 and 2" : `All ${low.length}`}</span>
              </span>
              <span className="mt-2 block max-w-prose md:mt-0">{shared}</span>
            </p>
          )}
        </div>
      )}

      {rest.length > 0 &&
        (low.length > 0 ? (
          <details className="group mt-2 border-t border-ink">
            <summary
              className={`${columns} flex cursor-pointer list-none flex-wrap items-baseline gap-x-4 gap-y-1 py-3 [&::-webkit-details-marker]:hidden`}
            >
              <span className="label inline-flex min-h-6 items-center gap-2">
                Read · {rest.length}
                <ChevronRightIcon className="group-open:rotate-90" />
              </span>
              {/* Wrapped, never cut mid-word: every name is read. */}
              <span className="min-w-0 text-small max-md:w-full">
                {rest.map((field) => fieldLabel(field.name)).join(", ")}
              </span>
            </summary>
            <dl>
              {rest.map((field) => (
                <Field key={field.name} field={field} />
              ))}
            </dl>
          </details>
        ) : (
          <div>
            <h4 className="label">Read · {rest.length}</h4>
            <dl className="mt-3">
              {rest.map((field) => (
                <Field key={field.name} field={field} />
              ))}
            </dl>
          </div>
        ))}
    </section>
  );
}

function percentOf(field: FieldRow): number {
  return Math.round(Number(field.confidence) * 100);
}

function displayValue(field: FieldRow): string | null {
  if (field.value !== null && field.name === "document_type") {
    return field.value.charAt(0).toUpperCase() + field.value.slice(1);
  }
  return field.value;
}

// A field to check. Focusable, so the keyboard reaches it straight from its
// document's line, and the next Tab reaches the next one; its name says
// what it is and where it sits in the set.
// With a shared question, the row says so in a line and is described by
// it, so the question is still read out with the field.
function LowField({
  field,
  number,
  of,
  sharedQuestionId,
}: {
  field: FieldRow;
  number: number;
  of: number;
  sharedQuestionId: string | null;
}) {
  const label = fieldLabel(field.name);
  const percent = percentOf(field);
  const value = displayValue(field);

  return (
    <li
      data-field-band={field.band}
      tabIndex={0}
      aria-label={`${label}, low confidence ${percent}%, ${number} of ${of} to check`}
      aria-describedby={sharedQuestionId ?? undefined}
      className={`${columns} border-t border-ink py-4`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:flex-col md:items-start">
        <span className="label">{label}</span>
        {/* Low, and only Low, is filled: ink on signal, 5.06:1. */}
        <span className="label inline-flex h-6 items-center bg-signal px-2 whitespace-nowrap text-on-signal">
          {BAND_LABELS.low} {percent}%
        </span>
        <span className="label ml-auto md:ml-0">
          {number} of {of}
        </span>
      </div>
      <div className="mt-3 min-w-0 md:mt-0">
        <p className="[overflow-wrap:anywhere]">{value ?? "Not on the document"}</p>
        {field.source_text ? (
          <p className="mt-2 text-small [overflow-wrap:anywhere]">
            <span className="label mr-2">Read from</span>
            <q>
              {quoteParts(field.source_text, field.value).map((part, index) =>
                part.mark ? (
                  <span key={index} className="underline decoration-signal decoration-2 underline-offset-[0.3em]">
                    {part.text}
                  </span>
                ) : (
                  part.text
                ),
              )}
            </q>
          </p>
        ) : (
          <NoQuote field={field} className="mt-2" />
        )}
        {sharedQuestionId ? (
          <p className="mt-2 text-small">
            <span className="label mr-2">To confirm</span>
            {/* Says where the question is, so the reader of 1 of 2
                doesn't look for it under this field. */}
            One question for {of === 2 ? "1\u00a0and\u00a02" : `all\u00a0${of}`},{" "}
            {number === of ? "directly below." : `after ${of}\u00a0of\u00a0${of}.`}
          </p>
        ) : (
          field.clarifying_question && (
            <p className="mt-2 text-small">
              <span className="label mr-2">To confirm</span>
              {field.clarifying_question}
            </p>
          )
        )}
      </div>
    </li>
  );
}

// A field read with Medium or High confidence: a hairline row, the band as
// ink words beside the label, the value, the words it was read from and,
// for Medium, the question.
function Field({ field }: { field: FieldRow }) {
  const value = displayValue(field);
  return (
    <div data-field-band={field.band} className={`${columns} border-t border-ink py-3`}>
      <dt className="flex flex-wrap items-baseline justify-between gap-x-3 md:flex-col md:justify-start md:gap-y-1">
        <span className="label">{fieldLabel(field.name)}</span>
        <span className="label whitespace-nowrap">
          <span className="sr-only">Confidence: </span>
          {BAND_LABELS[field.band] ?? field.band} {percentOf(field)}%
        </span>
      </dt>
      <dd className="mt-1 min-w-0 md:mt-0">
        <p className="[overflow-wrap:anywhere]">{value ?? "Not on the document"}</p>
        {field.source_text ? (
          <p className="mt-1 text-small [overflow-wrap:anywhere]">
            <span className="sr-only">Read from: </span>“{field.source_text}”
          </p>
        ) : (
          <NoQuote field={field} className="mt-1" />
        )}
        {field.clarifying_question && (
          <p className="mt-2 text-small">
            <span className="label mr-2">To confirm</span>
            {field.clarifying_question}
          </p>
        )}
      </dd>
    </div>
  );
}

// A value with no words quoted says why, so its evidence slot is never
// simply empty. The summary is written from the whole document; any other
// value without a quote says none was given. A field not on the document
// needs nothing more: its value line already says so.
function NoQuote({ field, className }: { field: FieldRow; className: string }) {
  if (field.value === null) return null;
  return (
    <p className={`${className} text-small`}>
      {field.name === "summary" ? "Written from the whole document, not quoted." : "No words were quoted for this value."}
    </p>
  );
}
