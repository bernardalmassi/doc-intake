// Static rows for /dev/states, shaped exactly like what /app/[slug]/page.tsx
// reads and hands to its components. Nothing here reaches a database.
//
// The needs-review document is the landing page's Fig. 1: the same file,
// run, values, confidences and quotes (src/app/_landing/fig-1.ts on
// design-landing), so /app and the landing tell the same story. Everything
// else is invented for the fixture and says nothing about a real run.

import type { StatedEntry } from "@/app/app/[slug]/document-state";
import { buildEntries } from "@/app/app/[slug]/entries";
import type { DocumentRow, FieldRow, Organization as OrgRow, RunRow } from "@/app/app/[slug]/types";
import type { Organization } from "@/app/app/organizations";
import type { ErrorCode } from "@/lib/errors";

// Documents and finished runs are dated around 24 Sep 2026. Runs still
// running are dated from the time of the request (entriesFor), so their
// start time, their elapsed time and the stale check all read true
// against the browser's clock.

export const EMAIL = "accounts@bramhall.example";

export const organization: OrgRow = {
  id: "00000000-0000-4000-8000-00000000b001",
  name: "Bramhall Interiors",
  slug: "bramhall-interiors",
};

export const organizations: Organization[] = [
  { ...organization, role: "owner" },
  { id: "00000000-0000-4000-8000-00000000b002", name: "Calder Wharf site office", slug: "calder-wharf", role: "admin" },
  { id: "00000000-0000-4000-8000-00000000b003", name: "Sheffield fit-out archive", slug: "sheffield-archive", role: "member" },
];

// A name and an address at their longest, for wrapping on a phone.
export const longOrganization: Organization = {
  id: "00000000-0000-4000-8000-00000000b004",
  name: "Northgate & Calder Wharf joint venture: site offices, snagging and handover records 2026",
  slug: "northgate-calder-wharf-joint-venture-handover-26",
  role: "admin",
};

function at(iso: string): string {
  return new Date(iso).toISOString();
}

function doc(
  id: string,
  filename: string,
  status: string,
  size: number | null,
  mime: string | null,
  created: string,
): DocumentRow {
  return { id, filename, status, storage_path: `${organization.id}/${id}`, size_bytes: size, mime_type: mime, created_at: created };
}

type RunInput = Partial<RunRow> & Pick<RunRow, "id" | "document_id" | "status" | "started_at">;

// A run as the components get it, after page.tsx's toRunRow: the stored
// error only as its code.
function run(input: RunInput): RunRow {
  return {
    provider: null,
    model: null,
    attempts: 0,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    latency_ms: null,
    error_code: null,
    cost_estimated: false,
    ...input,
  };
}

// ------------------------------------------------------------ documents

// Fig. 1: two Low dates at 59%, nine High fields.
export const NEEDS_REVIEW_ID = "doc-northgate-4471b";
// All High but one Medium with its question, and a mixed run history.
export const DONE_ID = "doc-trade-counter-118204";
export const READY_ID = "doc-po-22-0417";
export const QUEUED_ID = "doc-delivery-88231";
export const RUNNING_ID = "doc-credit-4390";
export const FAILED_ID = "doc-lease-renewal";
export const STALE_ID = "doc-bank-mandate";
export const UNFINISHED_ID = "doc-site-photos";
export const MISMATCH_ID = "doc-scan-0007";

const documents: Record<string, DocumentRow> = {
  [NEEDS_REVIEW_ID]: doc(NEEDS_REVIEW_ID, "test-invoice-messy-scan.pdf", "needs_review", 478_223, "application/pdf", at("2026-09-19T14:02:10Z")),
  [DONE_ID]: doc(DONE_ID, "trade-counter-receipt-tc-118204.pdf", "extracted", 212_480, "application/pdf", at("2026-09-23T16:04:00Z")),
  [READY_ID]: doc(READY_ID, "purchase-order-po-22-0417.pdf", "pending", 96_512, "application/pdf", at("2026-09-24T09:12:00Z")),
  [QUEUED_ID]: doc(QUEUED_ID, "delivery-note-88231.jpg", "pending", 1_204_736, "image/jpeg", at("2026-09-24T09:20:00Z")),
  [RUNNING_ID]: doc(RUNNING_ID, "credit-note-4390.pdf", "processing", 184_320, "application/pdf", at("2026-09-24T09:26:00Z")),
  [FAILED_ID]: doc(FAILED_ID, "carver-street-lease-renewal.pdf", "pending", 2_871_296, "application/pdf", at("2026-09-22T11:05:00Z")),
  [STALE_ID]: doc(STALE_ID, "bank-mandate-letter.png", "processing", 702_400, "image/png", at("2026-09-24T09:02:00Z")),
  [UNFINISHED_ID]: doc(
    UNFINISHED_ID,
    "site-photos-calder-wharf-phase-3-snagging-list-with-annotations.pdf",
    "uploading",
    null,
    null,
    at("2026-09-23T08:15:00Z"),
  ),
  [MISMATCH_ID]: doc(MISMATCH_ID, "scan_0007.pdf", "failed", 5_600_000, "application/pdf", at("2026-09-21T10:00:00Z")),
};

// ------------------------------------------------------------------ runs

const runs: RunRow[] = [
  // Fig. 1's run: 7 972 × 2 + 822 × 10 USD per million tokens.
  run({
    id: "run-4471b",
    document_id: NEEDS_REVIEW_ID,
    status: "succeeded",
    provider: "anthropic",
    model: "claude-sonnet-5",
    attempts: 1,
    input_tokens: 7_972,
    output_tokens: 822,
    cost_usd: "0.02416400",
    latency_ms: 8_900,
    started_at: at("2026-09-19T14:02:31Z"),
  }),

  // The done document: an estimated cost, a run both providers failed,
  // then the run whose fields are shown.
  run({
    id: "run-118204-3",
    document_id: DONE_ID,
    status: "succeeded",
    provider: "anthropic",
    model: "claude-sonnet-5",
    attempts: 1,
    input_tokens: 6_214,
    output_tokens: 731,
    cost_usd: "0.01973800",
    latency_ms: 7_412,
    started_at: at("2026-09-23T16:20:04Z"),
  }),
  run({
    id: "run-118204-2",
    document_id: DONE_ID,
    status: "failed",
    provider: "openai",
    model: "gpt-5-nano-2025-08-07",
    attempts: 2,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: "0.00000000",
    latency_ms: 120_318,
    error_code: "extraction.all_providers_failed",
    started_at: at("2026-09-23T16:12:40Z"),
  }),
  run({
    id: "run-118204-1",
    document_id: DONE_ID,
    status: "failed",
    provider: "anthropic",
    model: "claude-sonnet-5",
    attempts: 1,
    input_tokens: 6_190,
    output_tokens: 724,
    cost_usd: "0.01962000",
    latency_ms: 7_960,
    error_code: "extraction.result_not_saved",
    cost_estimated: true,
    started_at: at("2026-09-23T16:05:12Z"),
  }),


  // Failed with no usable answer, after an earlier run the reaper
  // abandoned and charged an estimate.
  run({
    id: "run-lease-2",
    document_id: FAILED_ID,
    status: "failed",
    provider: "anthropic",
    model: "claude-sonnet-5",
    attempts: 2,
    input_tokens: 21_806,
    output_tokens: 3_912,
    cost_usd: "0.08273200",
    latency_ms: 38_420,
    error_code: "extraction.invalid_answer",
    started_at: at("2026-09-22T11:41:09Z"),
  }),
  run({
    id: "run-lease-1",
    document_id: FAILED_ID,
    status: "failed",
    model: "claude-sonnet-5",
    cost_usd: "0.06608000",
    error_code: "extraction.abandoned",
    cost_estimated: true,
    started_at: at("2026-09-22T11:06:30Z"),
  }),


  // No model call: the file wasn't what it said it was.
  run({
    id: "run-0007",
    document_id: MISMATCH_ID,
    status: "failed",
    latency_ms: 412,
    error_code: "extraction.file_type_mismatch",
    started_at: at("2026-09-21T10:01:02Z"),
  }),
];

// Every way a run can end in failure, one document each, for the
// org-failures screens: what each line says and which exit it offers.
// Invented files; a run that failed before any model call has no model or
// tokens.
const FAILURES: [code: ErrorCode, filename: string, calledModel: boolean][] = [
  ["extraction.not_configured", "supplier-statement-aug.pdf", false],
  ["extraction.download_failed", "hire-agreement-scaffold.pdf", false],
  ["extraction.file_type_mismatch", "scan_0012.pdf", false],
  ["extraction.provider_timeout", "quote-joinery-q-5531.pdf", true],
  ["extraction.provider_unavailable", "remittance-advice-0918.png", true],
  ["extraction.all_providers_failed", "insurance-schedule-2026.pdf", true],
  ["extraction.provider_rejected", "signed-contract-locked.pdf", true],
  ["extraction.refused", "letter-from-solicitor.pdf", true],
  ["extraction.truncated", "tender-pack-volume-2.pdf", true],
  ["extraction.answer_incomplete", "utility-bill-electric-q3.pdf", true],
  ["extraction.invalid_answer", "receipt-fuel-0922.jpg", true],
  ["extraction.abandoned", "delivery-docket-7710.pdf", true],
  ["extraction.result_not_saved", "credit-application-form.pdf", true],
  ["extraction.record_failed", "timesheet-week-38.pdf", true],
  ["unknown", "purchase-order-po-22-0433.pdf", true],
];

export const FAILURE_IDS = FAILURES.map((_, index) => `doc-failure-${index + 1}`);

FAILURES.forEach(([code, filename, calledModel], index) => {
  const id = FAILURE_IDS[index];
  const minute = String(10 + index).padStart(2, "0");
  const mime = filename.endsWith(".png") ? "image/png" : filename.endsWith(".jpg") ? "image/jpeg" : "application/pdf";
  documents[id] = doc(id, filename, "pending", 180_000 + index * 37_000, mime, at(`2026-09-20T08:${minute}:00Z`));
  runs.push(
    run({
      id: `run-failure-${index + 1}`,
      document_id: id,
      status: "failed",
      ...(calledModel
        ? {
            provider: "anthropic",
            model: "claude-sonnet-5",
            attempts: 1,
            input_tokens: 6_210 + index * 311,
            output_tokens: code === "extraction.provider_timeout" ? 0 : 640 + index * 17,
            cost_usd: (0.0186 + index * 0.0011).toFixed(8),
            latency_ms: code === "extraction.provider_timeout" ? 60_000 : 9_400 + index * 530,
          }
        : { latency_ms: 380 + index * 20 }),
      error_code: code,
      started_at: at(`2026-09-20T08:${minute}:30Z`),
    }),
  );
});

// ---------------------------------------------------------------- fields

type FieldInput = [name: string, value: string | null, confidence: number, band: string, source: string | null, question?: string];

function fieldsFor(documentId: string, rows: FieldInput[]): FieldRow[] {
  return rows.map(([name, value, confidence, band, source, question]) => ({
    document_id: documentId,
    name,
    value,
    // numeric(4, 3) arrives as a string from PostgREST
    confidence: confidence.toFixed(3),
    band,
    source_text: source,
    clarifying_question: question ?? null,
  }));
}

// gateFields' question for Fig. 1's two dates (fig-1.ts, QUESTION).
const DATES_QUESTION =
  "The payment terms are 30 days, but the due date is 91 days after the document date. Check both dates against the document: a date written in numbers may have been read with the day and month swapped.";

const fields: FieldRow[] = [
  ...fieldsFor(NEEDS_REVIEW_ID, [
    ["document_type", "invoice", 0.98, "high", "INVOICE"],
    ["title", "INVOICE", 0.95, "high", "INVOICE"],
    ["sender_name", "Northgate Fixings & Supply Co.", 0.97, "high", "NORTHGATE FIXINGS & SUPPLY CO."],
    [
      "recipient_name",
      "Bramhall Interiors Ltd",
      0.96,
      "high",
      "INVOICE TO Bramhall Interiors Ltd Accounts Dept, 2nd Floor 41 Carver Street Sheffield S1 4FS",
    ],
    [
      "document_date",
      "2026-03-05",
      0.59,
      "low",
      "Date 05/03/2026; UK company (Sheffield/Barnsley addresses, VAT GB 419 7732 05), day-first convention supports 5 March 2026",
      DATES_QUESTION,
    ],
    [
      "due_date",
      "2026-06-04",
      0.59,
      "low",
      "Due 04/06/2026; handwritten note 'ext. to 04/06 per DK'; terms 30 days net from 05/03/2026 would give 04/04/2026, not 04/06/2026, suggesting the due date was manually extended",
      DATES_QUESTION,
    ],
    ["payment_terms_days", "30", 0.9, "high", "Terms 30 days net"],
    ["reference_number", "4471-B", 0.9, "high", "Inv 4471-B"],
    ["total_amount", "2046.26", 0.9, "high", "TOTAL DUE 2,046.26"],
    ["currency", "GBP", 0.95, "high", "GBP"],
    [
      "summary",
      "This is an invoice from Northgate Fixings & Supply Co. to Bramhall Interiors Ltd for fixings, consumables and services totaling GBP 2,046.26.",
      0.9,
      "high",
      null,
    ],
  ]),
  ...fieldsFor(DONE_ID, [
    ["document_type", "receipt", 0.97, "high", "RECEIPT"],
    ["title", "Trade counter receipt", 0.91, "high", "TRADE COUNTER RECEIPT"],
    ["sender_name", "Northgate Trade Counter", 0.94, "high", "t/a Northgate Trade Counter"],
    ["recipient_name", "Bramhall Interiors Ltd", 0.92, "high", "Account: Bramhall Interiors Ltd"],
    ["document_date", "2026-09-11", 0.93, "high", "11 SEP 2026 10:42"],
    ["due_date", null, 0.95, "high", null],
    ["payment_terms_days", null, 0.9, "high", null],
    [
      "reference_number",
      "TC-118204",
      0.71,
      "medium",
      "Receipt No. TC-118204 Till 3",
      "The receipt number and the till number are printed on one line. Is TC-118204 the receipt's reference?",
    ],
    ["total_amount", "86.40", 0.96, "high", "TOTAL £86.40"],
    ["currency", "GBP", 0.95, "high", "£"],
    [
      "summary",
      "A trade counter receipt from Northgate Trade Counter to Bramhall Interiors Ltd for fixings, totalling GBP 86.40.",
      0.9,
      "high",
      null,
    ],
  ]),
];

// ------------------------------------------------------------- entries

// Runs in progress at the time of the request: one 40 seconds in, one
// still "running" 25 minutes on, past the 10-minute stale limit.
function runningRuns(now: number): RunRow[] {
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  return [
    run({ id: "run-4390", document_id: RUNNING_ID, status: "running", started_at: ago(40) }),
    run({ id: "run-mandate", document_id: STALE_ID, status: "running", started_at: ago(25 * 60) }),
  ];
}

// Grouped and sorted by the page's own buildEntries, then given an
// explicit state where the data can't say it yet (queued).
export function entriesFor(ids: string[], states: Partial<Record<string, StatedEntry["state"]>> = SIX_STATE_OVERRIDES): StatedEntry[] {
  const now = Date.now();
  const chosen = ids.map((id) => documents[id]);
  const set = new Set(ids);
  const all = [...runs, ...runningRuns(now)];
  return buildEntries(
    chosen,
    all.filter((r) => r.document_id !== null && set.has(r.document_id)),
    fields.filter((f) => set.has(f.document_id)),
    now,
  ).map((entry) => {
    const state = states[entry.document.id];
    return state ? { ...entry, state } : entry;
  });
}

// One document per state: ready, queued, running, done, needs review,
// failed. Queued has no source value yet, so its document is given the
// state explicitly.
export const SIX_STATE_IDS = [NEEDS_REVIEW_ID, DONE_ID, READY_ID, QUEUED_ID, RUNNING_ID, FAILED_ID];
export const SIX_STATE_OVERRIDES: Partial<Record<string, StatedEntry["state"]>> = { [QUEUED_ID]: "queued" };

// Every document status today's page can show.
export const ALL_IDS = [...SIX_STATE_IDS.filter((id) => id !== QUEUED_ID), STALE_ID, UNFINISHED_ID, MISMATCH_ID];
