/**
 * THE NIGHTLY BOOKING MONEY CHECK'S FINDINGS AND SUMMARY (#4910,
 * `INV-PAY-163`).
 *
 * Pure. The booking-ledger census (`INV-MONEY-037`) and the booking-money
 * reconciliation census (`INV-MONEY-031`) decide what is wrong; this module
 * only lists what they reported and cuts it down to the bounded summary the
 * nightly job stores on its `CronJobRun` row. It holds no census rule and no
 * class of its own (`INV-SSOT`): every name in a summary is the census's.
 *
 * One home for both directions: the job builds a summary with
 * `summarizeBookingMoneyCensus` and the stuck-state dashboard reads the stored
 * JSON back with `parseBookingMoneyCensusSummary`, so the two cannot disagree
 * about its shape.
 *
 * A FINDING is one census class on one booking. The server holds no owner
 * acknowledgement file, so the census runs with none and reports everything:
 * - `disagreement`, `coverage`, `integrity`: the records disagree, or the
 *   census could not prove they agree. This is DRIFT.
 * - `class`: an instance of a known class the owner acknowledges booking by
 *   booking with the operator command. Known history, not a new emergency.
 * Classes the census only lists (`classGateRule` `OPEN`) are not findings.
 */
import { z } from "zod";

import {
  BOOKING_LEDGER_CENSUS_CLASSES,
  BOOKING_LEDGER_COVERAGE_KINDS,
} from "@/lib/booking-ledger-projection-census-classes";
import type { BookingLedgerCensusReport } from "@/lib/booking-ledger-projection-census-report";
import {
  BOOKING_MONEY_RECONCILIATION_REASON_ORDER,
  type BookingMoneyReconciliationSummary,
} from "@/lib/booking-money-reconciliation";

/** The command that prints the full booking-money reconciliation census. */
export const BOOKING_MONEY_RECONCILIATION_CENSUS_COMMAND = "pnpm run booking-money:census";

/** The most booking ids a summary, an alert or a dashboard item names for one class. */
export const BOOKING_MONEY_CENSUS_IDS_PER_CLASS = 20;

const FINDING_GROUPS = ["disagreement", "coverage", "integrity", "class"] as const;
export type BookingMoneyCensusFindingGroup = (typeof FINDING_GROUPS)[number];

export type BookingMoneyCensusFinding = {
  group: BookingMoneyCensusFindingGroup;
  /** `<group>:<the census's own name>`, for example `disagreement:CAPTURED`. */
  class: string;
  /** Empty for a finding about the club, not one booking (`JOURNAL_INACTIVE`). */
  bookingId: string;
};

/** Whether a finding is drift: the records disagree, not a known class awaiting the owner. */
export function isBookingMoneyCensusDrift(finding: Pick<BookingMoneyCensusFinding, "group">): boolean {
  return finding.group !== "class";
}

/**
 * Every finding in a booking-ledger census report, one per class and booking,
 * in the report's own order. Reads the report; decides nothing.
 */
export function listBookingMoneyCensusFindings(report: BookingLedgerCensusReport): BookingMoneyCensusFinding[] {
  const seen = new Set<string>();
  const findings: BookingMoneyCensusFinding[] = [];
  const add = (group: BookingMoneyCensusFindingGroup, name: string, bookingId: string) => {
    const finding = { group, class: `${group}:${name}`, bookingId };
    const key = bookingMoneyCensusAlertKey(finding);
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  for (const row of report.disagreements) add("disagreement", row.identity, row.bookingId);
  for (const kind of BOOKING_LEDGER_COVERAGE_KINDS) {
    for (const bookingId of report.coverage[kind]) add("coverage", kind, bookingId);
  }
  for (const finding of report.integrity.findings) add("integrity", finding.kind, finding.bookingId);
  for (const name of BOOKING_LEDGER_CENSUS_CLASSES) {
    const censusClass = report.classes[name];
    if (!censusClass.holdsGate) continue;
    for (const instance of censusClass.instances) {
      if (!instance.acknowledged) add("class", name, instance.bookingId);
    }
  }
  return findings;
}

/**
 * The once-ever alert key for one finding (`AlertCooldown.key`): the class and
 * the booking, so a finding alerts the first night it is seen and never again.
 */
export function bookingMoneyCensusAlertKey(finding: Pick<BookingMoneyCensusFinding, "class" | "bookingId">): string {
  return `booking-money-census:${finding.class}:${finding.bookingId || "club"}`;
}

const classSummarySchema = z.object({
  class: z.string().min(1),
  group: z.enum(FINDING_GROUPS),
  /** Findings in this class: bookings, or 1 for a finding about the club. */
  count: z.number().int().nonnegative(),
  /** The first `BOOKING_MONEY_CENSUS_IDS_PER_CLASS` booking ids, never more. */
  bookingIds: z.array(z.string().min(1)).max(BOOKING_MONEY_CENSUS_IDS_PER_CLASS),
});

/** What one nightly run stores as `CronJobRun.resultSummary`: counts and a few ids, never the report. */
const summarySchema = z.object({
  /** The booking-ledger census's verdict, as the operator command prints it. */
  verdict: z.enum(["GATE_OPEN", "GATE_CLOSED"]),
  bookingsChecked: z.number().int().nonnegative(),
  /** Every finding: one per class and booking. */
  findings: z.number().int().nonnegative(),
  /** The findings that are drift (`isBookingMoneyCensusDrift`). */
  drift: z.number().int().nonnegative(),
  /** The census's own count of known-class instances the owner has not acknowledged. */
  unacknowledgedClassInstances: z.number().int().nonnegative(),
  /** Only classes with a finding, in the census's order. */
  classes: z.array(classSummarySchema),
  /** The booking-money reconciliation census's totals; it names no booking. */
  reconciliation: z.object({
    totalBookings: z.number().int().nonnegative(),
    reconciled: z.number().int().nonnegative(),
    unreconciled: z.number().int().nonnegative(),
    /** Only reasons with a booking. */
    byReason: z.record(z.string(), z.number().int().positive()),
  }),
  /** What the run did about findings it had not alerted before; `failed` when the alert step threw. */
  alert: z.object({ newFindings: z.number().int().nonnegative(), sent: z.boolean(), failed: z.boolean() }),
});
export type BookingMoneyCensusSummary = z.infer<typeof summarySchema>;
export type BookingMoneyCensusClassSummary = z.infer<typeof classSummarySchema>;

/** Findings grouped by class in their given order, each cut to the ids one class may name. */
export function summarizeBookingMoneyCensusClasses(
  findings: readonly BookingMoneyCensusFinding[],
): BookingMoneyCensusClassSummary[] {
  const byClass = new Map<string, BookingMoneyCensusClassSummary>();
  for (const finding of findings) {
    let entry = byClass.get(finding.class);
    if (!entry) {
      entry = { class: finding.class, group: finding.group, count: 0, bookingIds: [] };
      byClass.set(finding.class, entry);
    }
    entry.count += 1;
    if (finding.bookingId && entry.bookingIds.length < BOOKING_MONEY_CENSUS_IDS_PER_CLASS) {
      entry.bookingIds.push(finding.bookingId);
    }
  }
  return [...byClass.values()];
}

export function summarizeBookingMoneyCensus(input: {
  ledger: Pick<BookingLedgerCensusReport, "verdict" | "population" | "unacknowledgedClassInstances">;
  money: BookingMoneyReconciliationSummary;
  findings: readonly BookingMoneyCensusFinding[];
  alert: BookingMoneyCensusSummary["alert"];
}): BookingMoneyCensusSummary {
  const { ledger, money, findings, alert } = input;
  return {
    verdict: ledger.verdict,
    bookingsChecked: ledger.population.bookings,
    findings: findings.length,
    drift: findings.filter(isBookingMoneyCensusDrift).length,
    unacknowledgedClassInstances: ledger.unacknowledgedClassInstances,
    classes: summarizeBookingMoneyCensusClasses(findings),
    reconciliation: {
      totalBookings: money.totalBookings,
      reconciled: money.byState.RECONCILED,
      unreconciled: money.byState.UNRECONCILED,
      byReason: Object.fromEntries(
        BOOKING_MONEY_RECONCILIATION_REASON_ORDER.filter((reason) => money.byReason[reason] > 0).map((reason) => [
          reason,
          money.byReason[reason],
        ]),
      ),
    },
    alert,
  };
}

/** A stored `resultSummary` read back, or null when it is not one this module wrote. */
export function parseBookingMoneyCensusSummary(value: unknown): BookingMoneyCensusSummary | null {
  const parsed = summarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One class's count and the ids it names, saying how many more there are: `3 (id1, id2, and 1 more)`. */
export function bookingMoneyCensusClassFindings(entry: Pick<BookingMoneyCensusClassSummary, "count" | "bookingIds">): string {
  if (entry.bookingIds.length === 0) return String(entry.count);
  const more = entry.count - entry.bookingIds.length;
  return `${entry.count} (${entry.bookingIds.join(", ")}${more > 0 ? `, and ${more} more` : ""})`;
}

/** One class as a plain line: its name, then its count and ids. */
export function bookingMoneyCensusClassLine(entry: BookingMoneyCensusClassSummary): string {
  return `${describeBookingMoneyCensusClass(entry)}: ${bookingMoneyCensusClassFindings(entry)}`;
}

/** `disagreement:CAPTURED` as an admin reads it: `CAPTURED disagreement`; a known class by its name alone. */
export function describeBookingMoneyCensusClass(entry: Pick<BookingMoneyCensusClassSummary, "class" | "group">): string {
  const name = entry.class.slice(entry.group.length + 1);
  if (entry.group === "class") return name;
  if (entry.group === "coverage") return `${name} coverage gap`;
  return `${name} ${entry.group}`;
}
