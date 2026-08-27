import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { requireInstant, type BoundClubTime } from "@/lib/club-time";

/**
 * Force the light palette onto the off-screen document html2canvas renders from
 * (#2146).
 *
 * The capture is always composited onto a white PDF page (`backgroundColor`
 * below), so a dark-mode operator would otherwise get near-white text on white —
 * a report that looks blank. next-themes marks the active theme with a `dark`
 * class plus an inline `color-scheme` on <html>; dropping both in the CLONE makes
 * every theme token resolve light without flashing the live page the operator is
 * looking at. The class is also cleared from any nested element, so a scoped
 * theme wrapper cannot re-darken part of the capture.
 *
 * Exported for the contract test; `generateReportPDF` is the only caller.
 */
export function forceLightPaletteInClone(clonedDocument: Document): void {
  const root = clonedDocument.documentElement;
  if (root) {
    root.classList.remove("dark");
    root.style.colorScheme = "light";
  }
  for (const element of Array.from(clonedDocument.querySelectorAll(".dark"))) {
    element.classList.remove("dark");
  }
}

/**
 * Render the report area to an A4 PDF and hand it to the operator's browser.
 *
 * ## `club` IS REQUIRED, AND IT IS THE ONLY WAY THIS MODULE KNOWS THE DATE (#3123)
 *
 * THIS CODE RUNS IN THE BROWSER. It drives `jsPDF` and `html2canvas` over a
 * cloned `Document`, and both callers reach it through
 * `await import("@/lib/report-pdf")` inside a `"use client"` component — so
 * neither the `server-only` zone reader nor the runtime reader exists here, and
 * the viewer's own clock is never the answer: an operator exporting from London
 * must get the same cover date as one in Ohakune.
 *
 * So the club's binding arrives as data, and it is a required parameter rather
 * than an optional one on purpose. Both dates this function names — the cover
 * stamp and the day in the saved filename — used to read `APP_TIME_ZONE` through
 * `formatNZLongDate` and `todayDateOnlyForTimeZone`, and a default here would let
 * a future caller silently reacquire that. Both callers already hold a binding
 * from `useClubTime()`, so this costs them a word each.
 *
 * ONE PARAMETER FOR BOTH VALUES, AND ONE READING OF THE CLOCK. The cover needs an
 * INSTANT projected into club time and the filename needs the club's calendar
 * day; taking two arguments would let a caller supply a day and a moment that
 * disagree. The same argument applies INSIDE the function, and it used to be
 * broken here: the cover stamped `new Date()` and the filename separately asked
 * `club.today()`, so an export straddling club midnight produced a file whose
 * name said one day and whose first page said another — in a durable document
 * somebody keeps and later files by date. The instant is now read ONCE, below,
 * and the filename's day is derived from that same instant with
 * `club.calendarDateOf`, which is the club-zone projection `club.today()` would
 * have performed on a second, later reading.
 *
 * The cover keeps the long "16 April 2026" spelling (owner decision, #2264;
 * `INV-DATE-016`) — `club.instantLongDate` IS `formatClubInstantLongDate` with
 * the zone bound, so the shape that invariant protects is byte-identical and
 * only the zone authority changed.
 */
export async function generateReportPDF(
  reportElement: HTMLElement,
  dateRange: { from: string; to: string },
  club: BoundClubTime,
  options?: { title?: string }
): Promise<void> {
  // THE ONLY READING OF THE CLOCK IN THIS FUNCTION (#3123). Both dates the file
  // carries — the cover stamp and the day in its name — are derived from this
  // one instant, so they cannot name different club days across midnight. Taken
  // before the capture, which is the slow part: the stamp should say when the
  // operator asked for the report, not when html2canvas finished with it.
  const generatedAt = requireInstant(new Date());

  // Capture the report content area as a high-res canvas
  // Use foreignObjectRendering: false to avoid SVG/foreignObject issues with Recharts
  const canvas = await html2canvas(reportElement, {
    scale: 2,
    useCORS: true,
    logging: false,
    backgroundColor: "#ffffff",
    foreignObjectRendering: false,
    allowTaint: true,
    removeContainer: true,
    // Renders the capture in the light palette even when the operator is
    // browsing in dark mode, so the white PDF page never receives white text.
    onclone: forceLightPaletteInClone,
  });

  // A4: 210mm x 297mm
  const pdf = new jsPDF("p", "mm", "a4");
  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 15;
  const contentWidth = pageWidth - margin * 2;

  // Header
  pdf.setFontSize(16);
  pdf.text(options?.title ?? "Reports", margin, margin + 5);
  pdf.setFontSize(10);
  pdf.setTextColor(100, 100, 100);
  pdf.text(`Date range: ${dateRange.from} to ${dateRange.to}`, margin, margin + 12);
  // The report cover keeps the long "16 April 2026" form it has always used
  // (owner decision, #2264) — now pinned to the club's PERSISTED zone rather
  // than the container's or the exporter's own.
  pdf.text(
    `Generated: ${club.instantLongDate(generatedAt)}`,
    margin,
    margin + 17
  );
  pdf.setTextColor(0, 0, 0);

  // Thin separator line
  pdf.setDrawColor(200, 200, 200);
  pdf.line(margin, margin + 20, pageWidth - margin, margin + 20);

  // Place captured content as image
  const imgData = canvas.toDataURL("image/png");
  const imgWidth = contentWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;
  const headerHeight = margin + 24;
  const availableFirstPage = pageHeight - headerHeight - margin;

  if (imgHeight <= availableFirstPage) {
    // Fits on one page
    pdf.addImage(imgData, "PNG", margin, headerHeight, imgWidth, imgHeight);
  } else {
    // Multi-page: slice the canvas into page-sized segments
    const scaleFactor = canvas.width / imgWidth;
    let remainingHeight = canvas.height;
    let sourceY = 0;
    let isFirstPage = true;

    while (remainingHeight > 0) {
      const pageAvailable = isFirstPage ? availableFirstPage : pageHeight - margin * 2;
      const sliceHeightMM = Math.min(pageAvailable, remainingHeight / scaleFactor);
      const sliceHeightPx = sliceHeightMM * scaleFactor;

      // Create a temporary canvas for this slice
      const sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = Math.ceil(sliceHeightPx);
      const ctx = sliceCanvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(
          canvas,
          0, sourceY, canvas.width, sliceHeightPx,
          0, 0, canvas.width, sliceHeightPx
        );
      }

      const sliceData = sliceCanvas.toDataURL("image/png");
      const yPos = isFirstPage ? headerHeight : margin;

      if (!isFirstPage) {
        pdf.addPage();
      }
      pdf.addImage(sliceData, "PNG", margin, yPos, imgWidth, sliceHeightMM);

      sourceY += sliceHeightPx;
      remainingHeight -= sliceHeightPx;
      isFirstPage = false;
    }
  }

  // Save. The day in the filename is the CLUB's, from the same binding AND the
  // same instant as the cover above — so a file exported at 8am in London is not
  // named yesterday, and its name can never disagree with its own first page.
  pdf.save(`tac-report-${club.calendarDateOf(generatedAt)}.pdf`);
}
