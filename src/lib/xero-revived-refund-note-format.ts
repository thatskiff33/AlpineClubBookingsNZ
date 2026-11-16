/**
 * #4336: the text of the revived refund-note report
 * (`xero-revived-refund-note-report.ts`). Ids, numbers, statuses and amounts
 * only: no member name, email or secret. The list (with `--list`) comes first
 * and the totals last, as the issue asks.
 */
import { formatCentsPlain } from "@/lib/utils";
import type {
  CouldNotReadNote,
  RevivedRefundNoteReport,
  RevivedRefundNoteRow,
  RevivedReportStopReason,
} from "@/lib/xero-revived-refund-note-report";

const STOP_LABELS: Record<RevivedReportStopReason, string> = {
  "daily-limit": "Xero's daily limit, or the app's share of it, was reached",
  reconnect: "Xero needs reconnecting",
  "consecutive-failures": "three reads failed in a row",
};

const READ_FAILURE_LABELS: Record<CouldNotReadNote["reason"], string> = {
  "not-found": "Xero has no such note",
  "no-status": "Xero sent no status",
  failed: "read failed",
};

function linkLines(row: RevivedRefundNoteRow): string[] {
  const amount =
    row.requestNoteCents !== null
      ? `note value ${formatCentsPlain(row.requestNoteCents)} (a refund request's own note: not in the refunded total)`
      : `app counts ${row.countedCents === null ? "nothing" : formatCentsPlain(row.countedCents)}`;
  return [
    `    payment ${row.paymentId}  booking ${row.bookingId ?? "(no such payment)"}  source ${row.paymentSource ?? "UNKNOWN"}`,
    `      role ${row.role}${row.refundRequestId ? `  refund request ${row.refundRequestId}` : ""}`,
    `      note ${row.creditNoteNumber ?? "(no number)"}  ${row.creditNoteId}`,
    `      Xero ${row.xeroStatus} (updated ${row.xeroUpdatedAt ?? "unknown"})  app records ${row.appStatus ?? "no status"}  ${amount}`,
    `      Payment.xeroRefundCreditNoteId names it: ${row.pointerNamesNote ? "yes" : "no"}`,
  ];
}

export function formatRevivedRefundNoteReport(report: RevivedRefundNoteReport, options: { list?: boolean } = {}): string {
  const list = options.list === true;
  const { scope } = report;
  const lines = [
    "Read-only: this report changed no booking, payment, credit, link or Xero record.",
    `Active refund-note links: ${report.activeLinks}, on ${scope.notesInPopulation} credit note(s).`,
  ];
  if (scope.resumedFrom !== null) {
    lines.push(
      `Resumed from note ${scope.resumedFrom}: this run covers ${scope.notesInThisRun} of the ${scope.notesInPopulation} credit notes. Everything below covers only the notes read in this run; add it to the earlier runs.`,
    );
  }
  lines.push(`Read from Xero: ${report.readCount}.`);

  if (list && report.revived.length > 0) {
    lines.push("Xero says VOIDED or DELETED, the app still has the link active and live:");
    for (const row of report.revived) lines.push(...linkLines(row));
  }
  lines.push(
    `Already recorded VOIDED or DELETED by the app, left for the nightly link cleanup (no action needed): ${report.alreadyRecordedCancelled.length} link(s)`,
  );
  if (list) {
    for (const row of report.alreadyRecordedCancelled) lines.push(`    payment ${row.paymentId}  note ${row.creditNoteId}  role ${row.role}`);
  }
  lines.push(`Could not read: ${report.couldNotRead.length} credit note(s)`);
  if (list) {
    for (const note of report.couldNotRead) {
      lines.push(`    note ${note.creditNoteId}  ${READ_FAILURE_LABELS[note.reason]}${note.detail ? ` (${note.detail})` : ""}  payment(s) ${note.paymentIds.join(", ")}`);
    }
  }
  if (report.stopped) {
    lines.push(
      `STOPPED EARLY: ${STOP_LABELS[report.stopped.reason]}. ${report.stopped.notReached.length} credit note(s) not read. ${report.stopped.detail}`,
      `To carry on, run again with --resume-from ${report.stopped.resumeFrom}`,
    );
    if (list) lines.push(...report.stopped.notReached.map((id) => `    not read: note ${id}`));
  }
  if (!report.complete) lines.push("THE LIST IS INCOMPLETE: see the lines above for what was not read.");

  lines.push(`Total: Xero says VOIDED or DELETED, the app still has the link active and live: ${report.totals.count} link(s)`);
  for (const source of report.totals.bySource) {
    const request = source.requestNoteCents > 0 ? `; refund requests' own notes ${formatCentsPlain(source.requestNoteCents)} (not part of the refunded total)` : "";
    lines.push(`  ${source.paymentSource}: ${source.count} link(s); the app counts ${formatCentsPlain(source.countedCents)}${request}`);
  }
  if (!list && (report.totals.count > 0 || report.alreadyRecordedCancelled.length > 0 || report.couldNotRead.length > 0 || report.stopped)) {
    lines.push("Run again with --list for each payment and note.");
  }
  return lines.join("\n");
}
