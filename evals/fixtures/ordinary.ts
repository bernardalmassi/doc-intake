// Nine ordinary business documents with known true values, for scoring
// per-field accuracy and confidence calibration. Chosen to cover the shapes
// and traps the extractor meets:
//
//   invoice-usd              a plain US invoice, everything present
//   receipt-eur              a German receipt with 1.141,40 formatting, no
//                            recipient, no due date
//   contract-services        a two-page services agreement, parties and a
//                            date, no amount at all
//   letter-admission         a letter with a reference and no amount
//   statement-utility        an electricity statement: previous balance,
//                            payment and new charges, one amount due, an
//                            account number, a due date
//   form-supplier            a filled-in registration form with a return-by
//                            date and a reference
//   invoice-vat-gbp          subtotal, VAT and total, an invoice date, a due
//                            date and a delivery date that is neither
//   price-list-sparse        a price list: prices but no total, no date, no
//                            recipient, no reference; most fields absent
//   invoice-gbp-numeric-dates  a UK invoice whose dates are numbers only,
//                            day first: "Date 02/09/2026" is 2 September.
//                            The GB VAT number, GBP and "Terms 30 days net"
//                            (02/09 to 02/10 is 30 days only day first) are
//                            the evidence. Added after a model read it as
//                            2026-02-09 and 2026-02-10 at 0.99 confidence

import { GREY, LIGHT, MARGIN, RIGHT, flow, labelled, letterhead, rule, stack, text } from "../layout";
import type { PdfItem } from "../pdf";
import { invoicePage, letterPage } from "./builders";
import type { Fixture } from "./types";

const invoiceUsd: Fixture = {
  id: "invoice-usd",
  kind: "ordinary",
  description: "A US landscaping invoice to a homeowners association; every field present.",
  pages: [
    invoicePage({
      seller: "Pinecrest Landscaping LLC",
      sellerLines: ["1780 Quarry Road, Boise, ID 83705", "Tel. (208) 555-0119"],
      title: "INVOICE",
      meta: [
        ["Invoice no.", "INV-20417"],
        ["Invoice date", "July 31, 2026"],
        ["Due date", "August 30, 2026"],
        ["Terms", "Net 30"],
      ],
      billTo: ["Maple Court Homeowners Association", "c/o Board Treasurer", "12 Maple Court", "Boise, ID 83706"],
      items: [
        { description: "Monthly grounds maintenance, July 2026", quantity: 1, unitPrice: 1850 },
        { description: "Hardwood mulch, installed (cubic yard)", quantity: 5, unitPrice: 59 },
      ],
      totals: [
        ["Subtotal", "2,145.00"],
        ["Sales tax", "0.00"],
        ["Total due (USD)", "$2,145.00", true],
      ],
      notes: ["Please make checks payable to Pinecrest Landscaping LLC."],
      footer: ["Thank you for your business."],
    }),
  ],
  expected: {
    document_type: "invoice",
    title: "Invoice",
    sender_name: { value: "Pinecrest Landscaping LLC", accept: ["Pinecrest Landscaping"] },
    recipient_name: "Maple Court Homeowners Association",
    document_date: "2026-07-31",
    due_date: "2026-08-30",
    payment_terms_days: "30",
    reference_number: "INV-20417",
    total_amount: "2145.00",
    currency: "USD",
    summary: "An invoice from Pinecrest Landscaping to Maple Court Homeowners Association for July grounds maintenance.",
  },
};

function receiptPage(): PdfItem[] {
  const x = 170;
  const right = 442;
  const rows: [string, string][] = [
    ["1 x Tischkreissäge TKS 2000", "1.049,00"],
    ["2 x Sägeblatt-Set 254 mm   à 39,95", "79,90"],
    ["1 x Schutzbrille klar", "12,50"],
  ];
  const items: PdfItem[] = [
    text(x, 740, "Keller Werkzeuge GmbH", { size: 15, bold: true }),
    ...stack(x, 716, ["Hauptstraße 12, 80331 München", "USt-IdNr. DE 284 511 902", "Tel. 089 5550 1470"], { size: 9, color: GREY }),
    rule(676, x, right),
    text(x, 656, "Kassenbon / Receipt", { size: 13, bold: true }),
    ...labelled(x, 634, [
      ["Beleg-Nr.", "2026-004511"],
      ["Datum", "12.09.2026  14:32"],
      ["Kasse", "3"],
    ], 9.5, 70),
    rule(590, x, right),
  ];
  rows.forEach(([label, amount], i) => {
    items.push(text(x, 572 - i * 16, label, { size: 9.5 }), text(right, 572 - i * 16, amount, { size: 9.5, align: "right" }));
  });
  items.push(
    rule(516, x, right),
    text(x, 498, "Summe EUR", { size: 11, bold: true }),
    text(right, 498, "1.141,40", { size: 11, bold: true, align: "right" }),
    text(x, 480, "darin MwSt. 19 %", { size: 9 }),
    text(right, 480, "182,24", { size: 9, align: "right" }),
    text(x, 462, "Netto", { size: 9 }),
    text(right, 462, "959,16", { size: 9, align: "right" }),
    rule(446, x, right),
    text(x, 428, "Bezahlt: girocard", { size: 9.5 }),
    text(right, 428, "1.141,40", { size: 9.5, align: "right" }),
    ...stack(x, 396, ["Vielen Dank für Ihren Einkauf!", "Umtausch innerhalb von 14 Tagen nur mit Beleg."], { size: 8.5, color: GREY }),
  );
  return items;
}

const receiptEur: Fixture = {
  id: "receipt-eur",
  kind: "ordinary",
  description: "A German tool-shop receipt with European number formatting; no recipient, no due date.",
  pages: [receiptPage()],
  expected: {
    document_type: "receipt",
    title: { value: "Kassenbon / Receipt", accept: ["Kassenbon", "Receipt"] },
    sender_name: { value: "Keller Werkzeuge GmbH", accept: ["Keller Werkzeuge"] },
    recipient_name: null,
    document_date: "2026-09-12",
    due_date: null,
    payment_terms_days: null,
    reference_number: "2026-004511",
    total_amount: "1141.40",
    currency: "EUR",
    summary: "A receipt from Keller Werkzeuge for a table saw, saw blades and safety glasses, paid by card.",
  },
};

function contractPages(): PdfItem[][] {
  const width = RIGHT - MARGIN;
  const first = flow(
    MARGIN,
    612,
    [
      "This Consulting Services Agreement (the \"Agreement\") is made on September 15, 2026 between Halvorsen " +
        "Analytics AS, Kongens gate 18, 0153 Oslo, Norway (the \"Consultant\"), and Brightwater Foods Inc., " +
        "2400 Harbor Drive, Portland, OR 97217, USA (the \"Client\").",
      "1. Services. The Consultant will provide demand forecasting and data analysis services as described in " +
        "Schedule A. The Consultant will assign a lead analyst and keep the Client informed of progress at least " +
        "every two weeks.",
      "2. Term. This Agreement takes effect on October 1, 2026 and continues for twelve months unless terminated " +
        "earlier under section 6.",
      "3. Fees. The Client will pay the fees set out in Schedule A. The Consultant will invoice monthly in arrears " +
        "and the Client will pay each undisputed invoice within thirty days of receipt.",
      "4. Confidentiality. Each party will keep the other party's confidential information secret and use it only " +
        "to perform this Agreement, during the term and for three years after it ends.",
      "5. Intellectual property. Work product created specifically for the Client belongs to the Client on payment. " +
        "The Consultant keeps its pre-existing tools and methods and grants the Client a licence to use them as part " +
        "of the work product.",
    ],
    width,
    { size: 10 },
  );
  const page1: PdfItem[] = [
    ...letterhead(740, "Halvorsen Analytics AS", ["Kongens gate 18, 0153 Oslo, Norway", "Org. nr. 921 604 118"]),
    rule(700),
    text(MARGIN, 672, "CONSULTING SERVICES AGREEMENT", { size: 14, bold: true }),
    text(MARGIN, 646, "Agreement No. HA-2026-031", { size: 10, bold: true }),
    ...first.items,
    text(RIGHT, 50, "Page 1 of 2", { size: 8, color: GREY, align: "right" }),
  ];
  const second = flow(
    MARGIN,
    730,
    [
      "6. Termination. Either party may terminate this Agreement on sixty days' written notice, or immediately if " +
        "the other party materially breaches it and does not cure the breach within thirty days of notice.",
      "7. Liability. Neither party is liable for indirect or consequential loss. Each party's total liability under " +
        "this Agreement is limited to the fees paid in the twelve months before the claim.",
      "8. Governing law. This Agreement is governed by the laws of the State of Oregon.",
      "Signed for and on behalf of the parties:",
    ],
    width,
    { size: 10 },
  );
  const sigY = second.y - 30;
  const page2: PdfItem[] = [
    ...second.items,
    rule(sigY, MARGIN, 280),
    rule(sigY, 332, RIGHT),
    ...stack(MARGIN, sigY - 14, ["Ingrid Halvorsen, Managing Director", "Halvorsen Analytics AS", "Date: September 15, 2026"], {
      size: 9.5,
    }),
    ...stack(332, sigY - 14, ["Marcus Bell, Chief Operating Officer", "Brightwater Foods Inc.", "Date: September 15, 2026"], {
      size: 9.5,
    }),
    text(RIGHT, 50, "Page 2 of 2", { size: 8, color: GREY, align: "right" }),
  ];
  return [page1, page2];
}

const contractServices: Fixture = {
  id: "contract-services",
  kind: "ordinary",
  description: "A two-page consulting agreement between two companies; a date and a reference, no amount.",
  pages: contractPages(),
  expected: {
    document_type: "contract",
    title: "Consulting Services Agreement",
    sender_name: { value: "Halvorsen Analytics AS", accept: ["Halvorsen Analytics"] },
    recipient_name: { value: "Brightwater Foods Inc.", accept: ["Brightwater Foods"] },
    document_date: "2026-09-15",
    due_date: null,
    payment_terms_days: "30",
    reference_number: "HA-2026-031",
    total_amount: null,
    currency: null,
    summary: "A consulting services agreement between Halvorsen Analytics and Brightwater Foods for demand forecasting.",
  },
};

const letterAdmission: Fixture = {
  id: "letter-admission",
  kind: "ordinary",
  description: "A university admission letter with an application reference; no amount, no deadline.",
  pages: [
    letterPage({
      sender: "Greenfield University",
      senderLines: ["Office of Graduate Admissions", "400 College Avenue, Madison, WI 53706"],
      date: "August 20, 2026",
      recipient: ["Ms. Amara Okonkwo", "58 Lakeview Road", "Milwaukee, WI 53202"],
      references: [["Application", "GU-26-18842"]],
      subject: "Offer of Admission",
      salutation: "Dear Ms. Okonkwo,",
      body: [
        "On behalf of the Graduate Admissions Committee, I am pleased to offer you admission to the Master of " +
          "Science in Environmental Engineering program at Greenfield University, beginning with the spring " +
          "semester.",
        "Your department will contact you separately about course registration and your academic advisor. " +
          "Information about orientation, housing and student services is available from the Office of Graduate " +
          "Admissions.",
        "Congratulations on your admission. We look forward to welcoming you to Greenfield.",
      ],
      closing: ["Sincerely,", "", "Dr. Helen Marsh", "Director of Graduate Admissions"],
    }),
  ],
  expected: {
    document_type: "letter",
    title: "Offer of Admission",
    sender_name: {
      value: "Greenfield University",
      accept: [
        "Greenfield University Office of Graduate Admissions",
        "Greenfield University, Office of Graduate Admissions",
        "Dr. Helen Marsh",
        "Helen Marsh",
      ],
    },
    recipient_name: { value: "Amara Okonkwo", accept: ["Ms. Amara Okonkwo"] },
    document_date: "2026-08-20",
    due_date: null,
    payment_terms_days: null,
    reference_number: "GU-26-18842",
    total_amount: null,
    currency: null,
    summary: "A letter from Greenfield University offering Amara Okonkwo admission to a master's program.",
  },
};

function statementPage(): PdfItem[] {
  const items: PdfItem[] = [
    ...letterhead(740, "Cascade Power & Light", ["PO Box 4410, Tacoma, WA 98401", "Customer service (253) 555-0171"]),
    text(RIGHT, 740, "Electricity Statement", { size: 15, bold: true, align: "right" }),
    ...labelled(360, 710, [
      ["Account number", "4402-118-2093"],
      ["Statement date", "September 5, 2026"],
      ["Billing period", "Aug 1 - Aug 31, 2026"],
    ], 9.5, 92),
    text(MARGIN, 660, "Service address and account holder", { size: 9, bold: true, color: GREY }),
    ...stack(MARGIN, 645, ["Jordan Ellis", "311 Cedar Street, Apt 2", "Tacoma, WA 98403"], { size: 10 }),
    { kind: "rect", x: 360, y: 600, width: RIGHT - 360, height: 58, color: LIGHT },
    text(370, 642, "Amount due", { size: 10, bold: true }),
    text(RIGHT - 10, 642, "$142.87", { size: 16, bold: true, align: "right" }),
    text(370, 622, "Due date", { size: 10, bold: true }),
    text(RIGHT - 10, 622, "September 25, 2026", { size: 10, align: "right" }),
    text(370, 607, "Autopay: not enrolled", { size: 8.5, color: GREY }),
    text(MARGIN, 560, "Account summary", { size: 11, bold: true }),
    rule(552),
  ];
  const rows: [string, string][] = [
    ["Previous balance", "131.02"],
    ["Payment received Aug 18, 2026 - thank you", "-131.02"],
    ["Balance forward", "0.00"],
    ["Basic service charge", "12.50"],
    ["Energy charge, 1,062 kWh at $0.1195", "126.91"],
    ["Local utility tax", "3.46"],
    ["New charges", "142.87"],
  ];
  rows.forEach(([label, amount], i) => {
    const bold = label === "New charges";
    items.push(
      text(MARGIN + 4, 534 - i * 17, label, { size: 10, bold }),
      text(RIGHT - 4, 534 - i * 17, amount, { size: 10, bold, align: "right" }),
    );
  });
  items.push(
    rule(534 - rows.length * 17 + 8),
    text(MARGIN, 380, "Meter 88-20417   Read Aug 31: 48,215   Previous read Jul 31: 47,153   Usage: 1,062 kWh", {
      size: 9,
      color: GREY,
    }),
    ...stack(MARGIN, 120, [
      "Please return the stub below with your payment. Payments received after the due date may incur a late fee of 1.5%.",
      "Account 4402-118-2093    Amount due $142.87    Due September 25, 2026",
    ], { size: 9, color: GREY }),
    rule(140),
  );
  return items;
}

const statementUtility: Fixture = {
  id: "statement-utility",
  kind: "ordinary",
  description: "An electricity statement with a previous balance, a payment, new charges, an account number and a due date.",
  pages: [statementPage()],
  expected: {
    document_type: "statement",
    title: "Electricity Statement",
    sender_name: "Cascade Power & Light",
    recipient_name: "Jordan Ellis",
    document_date: "2026-09-05",
    due_date: "2026-09-25",
    payment_terms_days: null,
    reference_number: "4402-118-2093",
    total_amount: "142.87",
    currency: "USD",
    summary: "An electricity statement from Cascade Power & Light to Jordan Ellis for August 2026 usage.",
  },
};

function formPage(): PdfItem[] {
  const box = (y: number, label: string, value: string): PdfItem[] => [
    text(MARGIN, y + 16, label, { size: 8, color: GREY }),
    { kind: "rect", x: MARGIN, y: y - 6, width: RIGHT - MARGIN, height: 18, color: LIGHT },
    text(MARGIN + 6, y, value, { size: 10.5 }),
  ];
  return [
    text(MARGIN, 745, "Harbour City Council", { size: 12, bold: true }),
    text(MARGIN, 731, "Procurement Office, 1 Civic Square, Harbour City HC1 4AA", { size: 9, color: GREY }),
    text(MARGIN, 700, "Supplier Registration Form", { size: 17, bold: true }),
    text(RIGHT, 700, "Reference: SR-2026-0932", { size: 10, bold: true, align: "right" }),
    ...flow(MARGIN, 678, [
      "Complete all sections and return this form to the Procurement Office by 30 September 2026. " +
        "Incomplete forms will be returned.",
    ], RIGHT - MARGIN, { size: 9.5 }).items,
    text(MARGIN, 636, "Section 1. Business details", { size: 11, bold: true }),
    ...box(600, "Registered business name", "Tallis & Byrne Ltd"),
    ...box(562, "Trading address", "Unit 7, Wharf Lane Industrial Estate, Harbour City HC3 9QT"),
    ...box(524, "Company registration number", "08815247"),
    ...box(486, "Goods or services offered", "Commercial cleaning and janitorial supplies"),
    text(MARGIN, 450, "Section 2. Contact", { size: 11, bold: true }),
    ...box(414, "Contact name and role", "Rhiannon Byrne, Director"),
    ...box(376, "Telephone", "01632 960 441"),
    text(MARGIN, 340, "Section 3. Declaration", { size: 11, bold: true }),
    ...flow(MARGIN, 322, [
      "I confirm that the information given on this form is correct and that the business holds the insurance " +
        "required for the goods or services offered.",
    ], RIGHT - MARGIN, { size: 9.5 }).items,
    ...box(270, "Signature", "R. Byrne"),
    ...box(232, "Date", "3 September 2026"),
    rule(90),
    text(MARGIN, 76, "Form PRC-7 (rev. 2025)   For office use: received ____________", { size: 8, color: GREY }),
  ];
}

const formSupplier: Fixture = {
  id: "form-supplier",
  kind: "ordinary",
  description: "A filled-in supplier registration form with a return-by date and a reference.",
  pages: [formPage()],
  expected: {
    document_type: "form",
    title: "Supplier Registration Form",
    // "issued or sent": the council issued the form, the supplier filled it
    // in and sends it, so either reading of sender and recipient is right
    sender_name: {
      value: "Tallis & Byrne Ltd",
      accept: ["Tallis & Byrne", "Harbour City Council", "Harbour City Council Procurement Office"],
    },
    recipient_name: {
      value: "Harbour City Council",
      accept: ["Harbour City Council Procurement Office", "Procurement Office", "Tallis & Byrne Ltd", "Tallis & Byrne"],
    },
    document_date: "2026-09-03",
    due_date: "2026-09-30",
    payment_terms_days: null,
    reference_number: { value: "SR-2026-0932", accept: ["PRC-7"] },
    total_amount: null,
    currency: null,
    summary: "A supplier registration form submitted by Tallis & Byrne to Harbour City Council.",
  },
};

const invoiceVatGbp: Fixture = {
  id: "invoice-vat-gbp",
  kind: "ordinary",
  description: "A UK invoice with subtotal, VAT and total, an invoice date, a due date and a delivery date.",
  pages: [
    invoicePage({
      seller: "Ashdown Print Studio Ltd",
      sellerLines: ["14 Tanners Yard, Lewes BN7 2AP", "VAT Reg. No. GB 318 4402 71"],
      title: "TAX INVOICE",
      meta: [
        ["Invoice no.", "ASP-5521"],
        ["Invoice date", "2 September 2026"],
        ["Due date", "2 October 2026"],
        ["Delivered", "28 August 2026"],
      ],
      billTo: ["Meridian Events Ltd", "Accounts Department", "90 Queens Road", "Brighton BN1 3XE"],
      items: [
        { description: "Exhibition banners, 2 x 1 m, printed and hemmed", quantity: 12, unitPrice: 145 },
        { description: "Printed programmes, A5, 24 pages", quantity: 1500, unitPrice: 1.02 },
        { description: "Design and artwork preparation (hours)", quantity: 8, unitPrice: 65 },
      ],
      totals: [
        ["Subtotal", "£3,790.00"],
        ["VAT at 20%", "£758.00"],
        ["Total (GBP)", "£4,548.00", true],
      ],
      notes: ["Payment by bank transfer within 30 days of the invoice date. Sort code 20-45-77, account 6031 8826."],
      footer: ["Ashdown Print Studio Ltd, registered in England and Wales no. 10233847."],
    }),
  ],
  expected: {
    document_type: "invoice",
    title: { value: "Tax Invoice", accept: ["Invoice"] },
    sender_name: { value: "Ashdown Print Studio Ltd", accept: ["Ashdown Print Studio"] },
    recipient_name: { value: "Meridian Events Ltd", accept: ["Meridian Events"] },
    document_date: "2026-09-02",
    due_date: "2026-10-02",
    payment_terms_days: "30",
    reference_number: "ASP-5521",
    total_amount: "4548.00",
    currency: "GBP",
    summary: "A tax invoice from Ashdown Print Studio to Meridian Events for banners, programmes and design work.",
  },
};

const invoiceGbpNumericDates: Fixture = {
  id: "invoice-gbp-numeric-dates",
  kind: "ordinary",
  description:
    "A UK invoice with numeric day-first dates (Date 02/09/2026, Due 02/10/2026), terms of 30 days net, GB VAT and GBP.",
  pages: [
    invoicePage({
      seller: "Harwick Joinery Ltd",
      sellerLines: ["Unit 4, Mill Lane Industrial Estate, Hebden Bridge HX7 8AP", "VAT Reg. No. GB 402 7719 36"],
      title: "INVOICE",
      meta: [
        ["Invoice no.", "HJ-2291"],
        ["Date", "02/09/2026"],
        ["Due", "02/10/2026"],
        ["Terms", "30 days net"],
      ],
      billTo: ["Calder Valley Housing Trust", "Maintenance Office", "8 Station Road", "Todmorden OL14 5AB"],
      items: [
        { description: "Oak door frames, supplied and fitted", quantity: 6, unitPrice: 285 },
        { description: "Softwood skirting board, per metre", quantity: 150, unitPrice: 5 },
      ],
      totals: [
        ["Subtotal", "£2,460.00"],
        ["VAT at 20%", "£492.00"],
        ["Total (GBP)", "£2,952.00", true],
      ],
      notes: ["Payment by BACS to sort code 40-11-62, account 7715 0293. Please quote the invoice number."],
      footer: ["Harwick Joinery Ltd, registered in England and Wales no. 11820475."],
    }),
  ],
  expected: {
    document_type: "invoice",
    title: "Invoice",
    sender_name: { value: "Harwick Joinery Ltd", accept: ["Harwick Joinery"] },
    recipient_name: "Calder Valley Housing Trust",
    document_date: "2026-09-02",
    due_date: "2026-10-02",
    payment_terms_days: "30",
    reference_number: "HJ-2291",
    total_amount: "2952.00",
    currency: "GBP",
    summary: "An invoice from Harwick Joinery to Calder Valley Housing Trust for fitted oak door frames and skirting board.",
  },
};

function priceListPage(): PdfItem[] {
  const rows: [string, string, string][] = [
    ["Sourdough loaf, 800 g", "case of 6", "$27.00"],
    ["Seeded rye, 750 g", "case of 6", "$25.50"],
    ["Butter croissant", "tray of 24", "$38.40"],
    ["Cinnamon roll", "tray of 12", "$21.60"],
    ["Baguette", "case of 10", "$22.00"],
    ["Focaccia, rosemary", "sheet (12 portions)", "$19.80"],
  ];
  const items: PdfItem[] = [
    ...letterhead(740, "Hillside Bakery Co-op", ["22 Orchard Lane, Asheville, NC 28801", "Wholesale orders (828) 555-0133"]),
    rule(700),
    text(MARGIN, 668, "Wholesale Price List", { size: 18, bold: true }),
    text(MARGIN, 648, "Prices per unit shown, before delivery. Prices may change without notice.", { size: 9.5, color: GREY }),
    { kind: "rect", x: MARGIN, y: 609, width: RIGHT - MARGIN, height: 17, color: LIGHT },
    text(MARGIN + 4, 614, "Product", { size: 9, bold: true }),
    text(330, 614, "Unit", { size: 9, bold: true }),
    text(RIGHT - 4, 614, "Price", { size: 9, bold: true, align: "right" }),
  ];
  rows.forEach(([product, unit, price], i) => {
    const y = 594 - i * 18;
    items.push(
      text(MARGIN + 4, y, product, { size: 10 }),
      text(330, y, unit, { size: 10 }),
      text(RIGHT - 4, y, price, { size: 10, align: "right" }),
    );
  });
  items.push(
    rule(594 - rows.length * 18 + 8),
    ...stack(MARGIN, 440, [
      "Orders placed by 2 p.m. are baked overnight and delivered the next morning, Tuesday to Saturday.",
      "Minimum order three cases. Delivery is free within 15 miles.",
    ], { size: 9.5 }),
  );
  return items;
}

const priceListSparse: Fixture = {
  id: "price-list-sparse",
  kind: "ordinary",
  description: "A wholesale price list: prices but no total, date, recipient, due date or reference.",
  pages: [priceListPage()],
  expected: {
    document_type: "other",
    title: "Wholesale Price List",
    sender_name: "Hillside Bakery Co-op",
    recipient_name: null,
    document_date: null,
    due_date: null,
    payment_terms_days: null,
    reference_number: null,
    total_amount: null,
    currency: null,
    summary: "A wholesale price list of breads and pastries from Hillside Bakery Co-op.",
  },
};

export const ORDINARY_FIXTURES: readonly Fixture[] = [
  invoiceUsd,
  receiptEur,
  contractServices,
  letterAdmission,
  statementUtility,
  formSupplier,
  invoiceVatGbp,
  priceListSparse,
  invoiceGbpNumericDates,
];
