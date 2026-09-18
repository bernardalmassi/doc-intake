// Small layout helpers for the fixture documents: stacked lines, wrapped
// paragraphs, rules and a business-document letterhead and line-item table.
// Only positions and text; evals/pdf.ts turns them into bytes.

import { type PdfItem, type PdfLine, type PdfText, type Rgb, PAGE_WIDTH, textWidth } from "./pdf";

export const MARGIN = 56;
export const RIGHT = PAGE_WIDTH - MARGIN;
export const GREY: Rgb = [0.35, 0.35, 0.35];
export const LIGHT: Rgb = [0.93, 0.93, 0.93];

type TextStyle = { size?: number; bold?: boolean; color?: Rgb; leading?: number; align?: "left" | "right" };

export function text(x: number, y: number, value: string, style: TextStyle = {}): PdfText {
  return { kind: "text", x, y, text: value, size: style.size, bold: style.bold, color: style.color, align: style.align };
}

// Lines stacked downward from y, leading defaulting to 1.35 x size.
export function stack(x: number, y: number, values: readonly string[], style: TextStyle = {}): PdfText[] {
  const leading = style.leading ?? (style.size ?? 10) * 1.35;
  return values.map((value, i) => text(x, y - i * leading, value, style));
}

export function wrap(value: string, maxWidth: number, size: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && textWidth(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function paragraph(x: number, y: number, value: string, width: number, style: TextStyle = {}): PdfText[] {
  return stack(x, y, wrap(value, width, style.size ?? 10), style);
}

// Paragraphs one after another from y; returns the items and the y below
// the last one.
export function flow(
  x: number,
  y: number,
  paragraphs: readonly string[],
  width: number,
  style: TextStyle = {},
): { items: PdfText[]; y: number } {
  const size = style.size ?? 10;
  const leading = style.leading ?? size * 1.35;
  const items: PdfText[] = [];
  let cursor = y;
  for (const value of paragraphs) {
    const lines = wrap(value, width, size);
    items.push(...stack(x, cursor, lines, { ...style, leading }));
    cursor -= lines.length * leading + leading * 0.6;
  }
  return { items, y: cursor };
}

export function rule(y: number, x1 = MARGIN, x2 = RIGHT, width = 0.5, color: Rgb = GREY): PdfLine {
  return { kind: "line", x1, y1: y, x2, y2: y, width, color };
}

// 1234.5 -> "1,234.50"; 1234.5 with "," -> "1.234,50"
export function money(amount: number, decimal: "." | "," = "."): string {
  const [int, frac] = Math.abs(amount).toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, decimal === "." ? "," : ".");
  return `${amount < 0 ? "-" : ""}${grouped}${decimal}${frac}`;
}

export type LineItem = { description: string; quantity: number; unitPrice: number };

// A line-item table with right-aligned quantity, unit price and amount
// columns. Returns the items and the y below the table.
export function itemTable(
  y: number,
  items: readonly LineItem[],
  options: { decimal?: "." | ","; headers?: [string, string, string, string] } = {},
): { items: PdfItem[]; y: number } {
  const decimal = options.decimal ?? ".";
  const [hDesc, hQty, hUnit, hAmount] = options.headers ?? ["Description", "Qty", "Unit price", "Amount"];
  const cols = { qty: 360, unit: 450, amount: RIGHT };
  const out: PdfItem[] = [
    { kind: "rect", x: MARGIN, y: y - 5, width: RIGHT - MARGIN, height: 17, color: LIGHT },
    text(MARGIN + 4, y, hDesc, { bold: true, size: 9 }),
    text(cols.qty, y, hQty, { bold: true, size: 9, align: "right" }),
    text(cols.unit, y, hUnit, { bold: true, size: 9, align: "right" }),
    text(cols.amount - 4, y, hAmount, { bold: true, size: 9, align: "right" }),
  ];
  let cursor = y - 20;
  for (const item of items) {
    out.push(
      text(MARGIN + 4, cursor, item.description, { size: 9.5 }),
      text(cols.qty, cursor, String(item.quantity), { size: 9.5, align: "right" }),
      text(cols.unit, cursor, money(item.unitPrice, decimal), { size: 9.5, align: "right" }),
      text(cols.amount - 4, cursor, money(item.quantity * item.unitPrice, decimal), { size: 9.5, align: "right" }),
    );
    cursor -= 16;
  }
  out.push(rule(cursor + 8));
  return { items: out, y: cursor - 8 };
}

// Label and amount pairs, right-aligned under a table.
export function totalsBlock(
  y: number,
  rows: readonly [label: string, amount: string, bold?: boolean][],
): { items: PdfItem[]; y: number } {
  const out: PdfItem[] = [];
  let cursor = y;
  for (const [label, amount, bold] of rows) {
    out.push(
      text(450, cursor, label, { size: 10, bold, align: "right" }),
      text(RIGHT - 4, cursor, amount, { size: 10, bold, align: "right" }),
    );
    cursor -= 16;
  }
  return { items: out, y: cursor };
}

// Organization name large at the top left, address lines under it.
export function letterhead(y: number, name: string, lines: readonly string[]): PdfItem[] {
  return [text(MARGIN, y, name, { size: 16, bold: true }), ...stack(MARGIN, y - 18, lines, { size: 9, color: GREY })];
}

// "Label: value" rows with the labels bold.
export function labelled(x: number, y: number, rows: readonly [string, string][], size = 9.5, gap = 90): PdfItem[] {
  return rows.flatMap(([label, value], i) => [
    text(x, y - i * size * 1.45, label, { size, bold: true }),
    text(x + gap, y - i * size * 1.45, value, { size }),
  ]);
}
