// Page builders for the two document shapes most fixtures share, an invoice
// and a business letter. Each fixture fills in its own content and may add
// extra items (hidden text, notes) on top.

import {
  GREY,
  type LineItem,
  MARGIN,
  RIGHT,
  flow,
  itemTable,
  labelled,
  letterhead,
  rule,
  stack,
  text,
  totalsBlock,
} from "../layout";
import type { PdfItem, PdfPage } from "../pdf";

export type InvoiceSpec = {
  seller: string;
  sellerLines: readonly string[];
  title: string;
  meta: readonly [string, string][];
  billToLabel?: string;
  billTo: readonly string[];
  items: readonly LineItem[];
  decimal?: "." | ",";
  totals: readonly [label: string, amount: string, bold?: boolean][];
  notes?: readonly string[];
  footer?: readonly string[];
  headers?: [string, string, string, string];
};

export function invoicePage(spec: InvoiceSpec, extra: readonly PdfItem[] = []): PdfPage {
  const items: PdfItem[] = [...letterhead(740, spec.seller, spec.sellerLines)];
  items.push(text(RIGHT, 740, spec.title, { size: 22, bold: true, align: "right" }));
  items.push(...labelled(360, 700, spec.meta, 9.5, 82));
  items.push(text(MARGIN, 640, spec.billToLabel ?? "Bill to", { size: 9, bold: true, color: GREY }));
  items.push(...stack(MARGIN, 626, spec.billTo, { size: 10 }));

  const table = itemTable(540, spec.items, { decimal: spec.decimal, headers: spec.headers });
  items.push(...table.items);
  const totals = totalsBlock(table.y - 6, spec.totals);
  items.push(...totals.items);

  let y = totals.y - 24;
  if (spec.notes && spec.notes.length > 0) {
    items.push(text(MARGIN, y, "Notes", { size: 9, bold: true, color: GREY }));
    const notes = flow(MARGIN, y - 14, spec.notes, RIGHT - MARGIN, { size: 9 });
    items.push(...notes.items);
    y = notes.y;
  }
  if (spec.footer) {
    items.push(rule(84));
    items.push(...stack(MARGIN, 70, spec.footer, { size: 8.5, color: GREY }));
  }
  return [...items, ...extra];
}

export type LetterSpec = {
  sender: string;
  senderLines: readonly string[];
  date: string;
  recipient: readonly string[];
  references?: readonly [string, string][];
  subject: string;
  salutation: string;
  body: readonly string[];
  closing: readonly string[];
  postscript?: string;
};

export function letterPage(spec: LetterSpec, extra: readonly PdfItem[] = []): PdfPage {
  const items: PdfItem[] = [...letterhead(740, spec.sender, spec.senderLines), rule(700)];
  items.push(text(MARGIN, 672, spec.date, { size: 10.5 }));
  items.push(...stack(MARGIN, 644, spec.recipient, { size: 10.5 }));
  let y = 644 - spec.recipient.length * 14 - 14;
  if (spec.references) {
    items.push(...labelled(MARGIN, y, spec.references, 10, 80));
    y -= spec.references.length * 14.5 + 10;
  }
  items.push(text(MARGIN, y, spec.subject, { size: 11, bold: true }));
  y -= 26;
  items.push(text(MARGIN, y, spec.salutation, { size: 10.5 }));
  const body = flow(MARGIN, y - 22, spec.body, RIGHT - MARGIN, { size: 10.5 });
  items.push(...body.items);
  items.push(...stack(MARGIN, body.y - 6, spec.closing, { size: 10.5 }));
  if (spec.postscript) {
    const psTop = body.y - 6 - spec.closing.length * 14.2 - 12;
    items.push(...flow(MARGIN, psTop, [spec.postscript], RIGHT - MARGIN, { size: 10.5 }).items);
  }
  return [...items, ...extra];
}
