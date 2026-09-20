// Fig. 1 on the landing page: one live run on the deployed app, as it was
// reported on 19 Sep 2026. The document was run twice, by two accounts,
// with the same result. Nothing here is invented: the run's numbers and
// every field's value, confidence and quote are that run's; the question
// is the one gateFields (src/lib/extraction/schema.ts) writes when the due
// date isn't the document date plus the payment terms, filled in with this
// run's numbers. tests/unit/landing-fig-1.test.ts puts the values through
// the real validation and gating and checks the bands shown here.

export const RUN = {
  date: "19 Sep 2026",
  filename: "test-invoice-messy-scan.pdf",
  pages: 2,
  model: "claude-sonnet-5",
  calls: 1,
  inputTokens: 7972,
  outputTokens: 822,
  seconds: 8.9,
  // What close_extraction_run records: 7 972 × 2 + 822 × 10 USD per
  // million tokens, at Sonnet 5's price in extraction_model_prices.
  costUsd: 0.0242,
  fieldsFound: 11,
  fieldsTotal: 11,
} as const;

// A point on page 1 in pixels, rendered at the scan's native width
// (1654 × 2339).
export type Point = readonly [number, number];

// A line under quoted words: [x, y, width], y being where the line sits,
// just under the baseline. Measured on a gridded render.
export type Mark = readonly [number, number, number];

export type Fig1Field = {
  name: string;
  label: string;
  // As stored. The figure capitalizes the document type, as the app does.
  value: string;
  band: "high" | "low";
  confidencePercent: number;
  sourceText: string | null;
  // Where the quoted words are on the page. The leader starts at the end
  // of the first.
  marks: readonly Mark[];
  // Turns the leader takes after the end of the first mark, when a straight
  // line from there to the page's right edge would cross other words. From
  // the last point it runs straight to the edge.
  via?: readonly Point[];
};

const INVOICE_HEADING: Mark = [1300, 223, 225];
const TERMS: Mark = [1202, 390, 321];

// Schema order, as the app shows them.
export const FIELDS: readonly Fig1Field[] = [
  {
    name: "document_type",
    label: "Document type",
    value: "invoice",
    band: "high",
    confidencePercent: 98,
    sourceText: "INVOICE",
    marks: [INVOICE_HEADING],
  },
  {
    name: "title",
    label: "Title",
    value: "INVOICE",
    band: "high",
    confidencePercent: 95,
    sourceText: "INVOICE",
    marks: [INVOICE_HEADING],
  },
  {
    name: "sender_name",
    label: "Sender",
    value: "Northgate Fixings & Supply Co.",
    band: "high",
    confidencePercent: 97,
    sourceText: "NORTHGATE FIXINGS & SUPPLY CO.",
    marks: [
      [178, 193, 544], // NORTHGATE FIXINGS
      [178, 250, 358], // & SUPPLY CO.
    ],
    // Straight across, the leader would run into the INVOICE heading: it
    // goes up to the clear top margin first.
    via: [
      [740, 193],
      [740, 125],
    ],
  },
  {
    name: "recipient_name",
    label: "Recipient",
    value: "Bramhall Interiors Ltd",
    band: "high",
    confidencePercent: 96,
    sourceText: "INVOICE TO Bramhall Interiors Ltd Accounts Dept, 2nd Floor 41 Carver Street Sheffield S1 4FS",
    // The last line first: the lane to its right is clear to the edge.
    marks: [
      [166, 639, 178], // Sheffield S1 4FS
      [170, 496, 132], // INVOICE TO
      [166, 543, 257], // Bramhall Interiors Ltd
      [166, 580, 270], // Accounts Dept, 2nd Floor
      [166, 608, 174], // 41 Carver Street
    ],
  },
  {
    name: "document_date",
    label: "Document date",
    value: "2026-03-05",
    band: "low",
    confidencePercent: 59,
    sourceText:
      "Date 05/03/2026; UK company (Sheffield/Barnsley addresses, VAT GB 419 7732 05), day-first convention supports 5 March 2026",
    marks: [
      [1222, 314, 306], // Date 05/03/2026
      [172, 357, 94], // Sheffield
      [435, 392, 80], // Barnsley
      [171, 416, 200], // VAT GB 419 7732 05
    ],
  },
  {
    name: "due_date",
    label: "Due date",
    value: "2026-06-04",
    band: "low",
    confidencePercent: 59,
    sourceText:
      "Due 04/06/2026; handwritten note 'ext. to 04/06 per DK'; terms 30 days net from 05/03/2026 would give 04/04/2026, not 04/06/2026, suggesting the due date was manually extended",
    marks: [
      [1219, 350, 309], // Due 04/06/2026
      [1022, 468, 320], // ext. to 04/06 per DK
      TERMS,
    ],
  },
  {
    name: "payment_terms_days",
    label: "Payment terms (days)",
    value: "30",
    band: "high",
    confidencePercent: 90,
    sourceText: "Terms 30 days net",
    marks: [TERMS],
  },
  {
    name: "reference_number",
    label: "Reference number",
    value: "4471-B",
    band: "high",
    confidencePercent: 90,
    sourceText: "Inv 4471-B",
    marks: [[1378, 274, 172]],
  },
  {
    name: "total_amount",
    label: "Total amount",
    value: "2046.26",
    band: "high",
    confidencePercent: 90,
    sourceText: "TOTAL DUE 2,046.26",
    marks: [[1127, 1386, 365]],
  },
  {
    name: "currency",
    label: "Currency",
    value: "GBP",
    band: "high",
    confidencePercent: 95,
    sourceText: "GBP",
    marks: [[1447, 1422, 45]],
  },
  {
    name: "summary",
    label: "Summary",
    value:
      "This is an invoice from Northgate Fixings & Supply Co. to Bramhall Interiors Ltd for fixings, consumables and services totaling GBP 2,046.26.",
    band: "high",
    confidencePercent: 90,
    sourceText: null,
    marks: [],
  },
];

// gateFields' question, with this run's numbers: 30 days of terms, and
// 2026-03-05 to 2026-06-04 is 91 days. It is the same for both dates.
export const QUESTION =
  "The payment terms are 30 days, but the due date is 91 days after the document date. Check both dates against the document: a date written in numbers may have been read with the day and month swapped.";

// The question's first sentence, the hero's one line of explanation.
export const QUESTION_LEAD = QUESTION.slice(0, QUESTION.indexOf(".") + 1);

// Page 1 of the scan, whole, as invoice-scan-page-1.jpg. Marks are placed
// by percentage of it.
//
// The file is the uploaded PDF's own image of page 1, taken out of it byte
// for byte and never re-encoded: the PDF (written by Pillow's PDF driver)
// is two A4 pages, each one JPEG of 1654 x 2339, which is 200 dots to the
// inch, and nothing else, so there is no sharper source. It carries a JFIF
// header and no colour profile, Exif, comment or device name; an earlier
// copy was a re-rendering that embedded the profile of the monitor it was
// made on. tests/unit/landing-fig-1.test.ts checks the file is this one
// and carries nothing else. It is not what the model read: the app uploads
// the PDF, and the provider makes its own image of each page.
export const PAGE = { width: 1654, height: 2339 } as const;

export const SCAN_FILE = {
  sha256: "8c3398be19368319d67634a286f4f4b40657c555d02adc50f22ccbc1a6761762",
  bytes: 271278,
  dotsPerInch: 200,
} as const;

// The hero's detail of page 1, in the same pixels: the Date, Due and Terms
// lines and the handwritten "ext. to 04/06 per DK", from just under the
// invoice number to just under the rule. The same file, cropped by CSS, so
// it is as real as the figure. It shows the due date, whose marks are all
// inside it (checked in tests/unit/landing-fig-1.test.ts).
export const DETAIL = { x: 985, y: 278, width: 600, height: 210, field: "due_date" } as const;

// Both images ask for the scan at its native width, so they resolve to one
// URL and one download: the detail is shown larger than life, so it needs
// every pixel anyway.
export const SCAN_SIZES = `${PAGE.width}px`;
