/**
 * Draws the app's generated booking invoice (#5066, slice 2) with jsPDF, on the
 * server.
 *
 * It only lays out what `buildBookingInvoiceData` decided: no money is worked
 * out here beyond formatting cents in the club's currency and locale
 * (`formatCents`, `INV-CONFIG-006`). The table header repeats on every page.
 *
 * What it never prints (owner decisions of 15 Nov 2026 on #5066): any GST
 * wording, number or tax line (the GST-registered "Tax invoice" waits for the
 * club's recorded GST status, #5153); a payment box or bank details (#4526);
 * an invoice number; an issuer contact line.
 */
import { jsPDF } from "jspdf";

import {
  BOOKING_INVOICE_NOT_YET_APPROVED,
  BOOKING_INVOICE_NOT_YET_APPROVED_NOTE,
  type BookingInvoiceData,
  type BookingInvoiceLine,
} from "@/lib/booking-invoice";
import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

const PAGE = { width: 210, height: 297, margin: 18 } as const;
const FOOTER_Y = PAGE.height - 12;
const CONTENT_BOTTOM = PAGE.height - 24;
const LINE = 5;

// Column right edges / left edges for the line table (mm).
const COLUMNS = {
  guest: PAGE.margin,
  category: 74,
  nightsRight: 140,
  rateRight: 166,
  amountRight: PAGE.width - PAGE.margin,
} as const;

/**
 * jsPDF's built-in Helvetica covers WinAnsi only. Names can carry macrons and
 * other letters outside it (Māori names, for example), which would print as
 * garbage, so anything outside Latin-1 is folded to its base letter, or "?"
 * when it has none.
 */
export function pdfSafeText(value: string): string {
  let out = "";
  for (const char of value) {
    if (char.codePointAt(0)! <= 0xff || "•–—‘’“”€".includes(char)) {
      out += char;
      continue;
    }
    const folded = char.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += folded && [...folded].every((c) => c.codePointAt(0)! <= 0xff) ? folded : "?";
  }
  return out;
}

type Pen = {
  doc: jsPDF;
  y: number;
  text: (value: string, x: number, y: number, options?: { align?: "left" | "right" | "center" }) => void;
  wrap: (value: string, width: number) => string[];
  drawLines: (lines: readonly string[], x: number, top: number) => void;
  money: (cents: number) => string;
};

const right = { align: "right" as const };

function pen(doc: jsPDF, format: ClubFormat): Pen {
  return {
    doc,
    y: PAGE.margin + 4,
    text: (value, x, y, options) => doc.text(pdfSafeText(value), x, y, options),
    // Long text wraps onto several lines; every caller advances by the lines it
    // actually drew, so a wrapped row never overlaps the next one.
    wrap: (value, width) => doc.splitTextToSize(pdfSafeText(value), width) as string[],
    drawLines: (lines, x, top) => lines.forEach((line, index) => doc.text(line, x, top + index * LINE)),
    money: (cents) => pdfSafeText(formatCents(cents, format)),
  };
}

/** Supplier on the left, the title, date and booking reference on the right. */
function drawHeader(p: Pen, data: BookingInvoiceData) {
  const { doc } = p;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  const supplierLines = p.wrap(data.supplier.name, 100);
  p.drawLines(supplierLines, PAGE.margin, p.y);
  doc.setFontSize(22);
  p.text(data.title, COLUMNS.amountRight, p.y + 2, right);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  let y = p.y + supplierLines.length * LINE + 1;
  for (const line of data.supplier.addressLines) {
    p.text(line, PAGE.margin, y);
    y += LINE;
  }

  let metaY = PAGE.margin + 14;
  for (const [label, value] of [
    ["Date", data.documentDate],
    ["Booking reference", data.bookingReference],
  ] as const) {
    doc.setFont("helvetica", "bold");
    p.text(`${label}:`, COLUMNS.rateRight - 2, metaY, right);
    doc.setFont("helvetica", "normal");
    p.text(value, COLUMNS.amountRight, metaY, right);
    metaY += LINE;
  }
  p.y = Math.max(y, metaY) + 4;
}

/** A booking the club has not approved yet is marked so, prominently, above everything it bills. */
function drawNotYetApproved(p: Pen) {
  const { doc } = p;
  const note = p.wrap(BOOKING_INVOICE_NOT_YET_APPROVED_NOTE, PAGE.width - PAGE.margin * 2 - 8);
  const height = (note.length + 1) * LINE + 5;
  doc.setDrawColor(160, 40, 40);
  doc.setLineWidth(0.6);
  doc.rect(PAGE.margin, p.y, PAGE.width - PAGE.margin * 2, height);
  doc.setLineWidth(0.2);
  doc.setDrawColor(0, 0, 0);
  doc.setTextColor(160, 40, 40);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  p.text(BOOKING_INVOICE_NOT_YET_APPROVED.toUpperCase(), PAGE.margin + 4, p.y + 6);
  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  p.drawLines(note, PAGE.margin + 4, p.y + 6 + LINE);
  p.y += height + 6;
}

function drawBillToAndStay(p: Pen, data: BookingInvoiceData) {
  const { doc } = p;
  const stayX = COLUMNS.category + 20;
  doc.setFont("helvetica", "bold");
  p.text("Bill to", PAGE.margin, p.y);
  p.text("Stay", stayX, p.y);
  doc.setFont("helvetica", "normal");
  p.y += LINE;
  const billToLines = p.wrap(data.billTo, stayX - PAGE.margin - 6);
  p.drawLines(billToLines, PAGE.margin, p.y);
  const stayLines = [
    ...p.wrap(`Place of stay: ${data.placeOfStay}`, COLUMNS.amountRight - stayX),
    `Check-in: ${data.stay.checkIn}`,
    `Check-out: ${data.stay.checkOut}`,
    `${data.stay.nights} night${data.stay.nights === 1 ? "" : "s"} • ${data.stay.guests} guest${data.stay.guests === 1 ? "" : "s"}`,
  ].map(pdfSafeText);
  p.drawLines(stayLines, stayX, p.y);
  p.y += LINE * Math.max(stayLines.length, billToLines.length) + 6;
}

function drawLineTable(p: Pen, lines: readonly BookingInvoiceLine[]) {
  const { doc } = p;
  const drawTableHeader = () => {
    doc.setFillColor(235, 235, 235);
    doc.rect(PAGE.margin, p.y - 4, PAGE.width - PAGE.margin * 2, 7, "F");
    doc.setFont("helvetica", "bold");
    p.text("Guest", COLUMNS.guest + 1, p.y);
    p.text("Category", COLUMNS.category, p.y);
    p.text("Nights", COLUMNS.nightsRight, p.y, right);
    p.text("Rate / night", COLUMNS.rateRight, p.y, right);
    p.text("Amount", COLUMNS.amountRight - 1, p.y, right);
    doc.setFont("helvetica", "normal");
    p.y += 8;
  };
  drawTableHeader();
  for (const line of lines) {
    const columns =
      line.kind === "GUEST"
        ? [
            { lines: p.wrap(line.guest, COLUMNS.category - COLUMNS.guest - 3), x: COLUMNS.guest + 1 },
            { lines: p.wrap(line.category, COLUMNS.nightsRight - COLUMNS.category - 14), x: COLUMNS.category },
          ]
        : [{ lines: p.wrap(line.description, COLUMNS.rateRight - COLUMNS.guest - 20), x: COLUMNS.guest + 1 }];
    const rows = Math.max(...columns.map((column) => column.lines.length));
    ensureRoom(p, rows * LINE + 1, drawTableHeader);
    for (const column of columns) p.drawLines(column.lines, column.x, p.y);
    if (line.kind === "GUEST") {
      p.text(String(line.nights), COLUMNS.nightsRight, p.y, right);
      p.text(p.money(line.ratePerNightCents), COLUMNS.rateRight, p.y, right);
    }
    p.text(p.money(line.amountCents), COLUMNS.amountRight - 1, p.y, right);
    p.y += rows * LINE + 1;
  }
}

function ensureRoom(p: Pen, needed: number, onNewPage?: () => void) {
  if (p.y + needed <= CONTENT_BOTTOM) return;
  p.doc.addPage();
  p.y = PAGE.margin + 4;
  onNewPage?.();
}

/** The total, then the account rows the booking page's card shows, in its words. */
function drawTotals(p: Pen, data: BookingInvoiceData, format: ClubFormat) {
  const { doc } = p;
  const rows: Array<[string, string, boolean]> = [
    [`Total (${format.currencyCode})`, p.money(data.totalCents), true],
    ...data.accountRows.map((row): [string, string, boolean] => [row.label, p.money(row.cents), row.emphasis]),
  ];
  ensureRoom(p, (LINE + 1) * rows.length + 6);
  p.y += 2;
  doc.line(COLUMNS.category + 20, p.y - 3, COLUMNS.amountRight, p.y - 3);
  for (const [label, value, bold] of rows) {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    p.text(label, COLUMNS.rateRight, p.y, right);
    p.text(value, COLUMNS.amountRight - 1, p.y, right);
    p.y += LINE + 1;
  }
  doc.setFont("helvetica", "normal");
}

export function renderBookingInvoicePdf(data: BookingInvoiceData, format: ClubFormat): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const p = pen(doc, format);

  drawHeader(p, data);
  if (data.notYetApproved) drawNotYetApproved(p);
  drawBillToAndStay(p, data);
  drawLineTable(p, data.lines);
  drawTotals(p, data, format);

  ensureRoom(p, LINE * 2);
  p.y += 8;
  doc.setFont("helvetica", "bold");
  p.text("Thank you for your booking", PAGE.width / 2, p.y, { align: "center" });

  // Footer on every page, repeating the mark on an unapproved booking.
  const pages = doc.getNumberOfPages();
  const footer = [data.supplier.name, data.title, ...(data.notYetApproved ? [BOOKING_INVOICE_NOT_YET_APPROVED] : [])].join(" • ");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    p.text(footer, PAGE.margin, FOOTER_Y);
    p.text(`Page ${page} of ${pages}`, COLUMNS.amountRight, FOOTER_Y, right);
  }

  return Buffer.from(doc.output("arraybuffer"));
}
