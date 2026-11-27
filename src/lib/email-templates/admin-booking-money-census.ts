/**
 * #4910 (`INV-PAY-163`): the admins' alert from the nightly booking money
 * check, sent when a run finds something it has not reported before. One email
 * per run lists the new findings by census class, with booking ids only (no
 * member details), and points at the Stuck States page and the operator
 * command that prints the full report. Each finding is alerted once
 * (`cron-booking-money-census.ts`). Sender:
 * `src/lib/email/admin-alerts-booking-money-census.ts`.
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, paragraph, layout } from "./layout";
import { BOOKING_LEDGER_CENSUS_COMMAND, BOOKING_MONEY_CENSUS_ALERT_NOTE } from "@/lib/booking-money-census-job";

export function adminBookingMoneyCensusTemplate(data: {
  newFindings: number;
  /** One row per census class: what it is called, and its count with the ids named. */
  classes: ReadonlyArray<{ label: string; findings: string }>;
  reviewUrl: string;
}): string {
  return layout(`
    ${heading("Booking Money Check")}
    ${alertBox(BOOKING_MONEY_CENSUS_ALERT_NOTE, "warning")}
    ${infoTable([
      { label: "New findings", value: String(data.newFindings) },
      ...data.classes.map((row) => ({ label: escapeHtml(row.label), value: escapeHtml(row.findings) })),
    ])}
    ${paragraph(`For the full report, run <code>${escapeHtml(BOOKING_LEDGER_CENSUS_COMMAND)}</code> on the server.`)}
    ${button("Open Stuck States", data.reviewUrl, { sameOrigin: true })}
  `);
}
