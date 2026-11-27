/**
 * THE STUCK STATES PAGE'S MONEY-CHECK ITEMS (#4910, `INV-PAY-163`).
 *
 * Payment-domain items built from records other jobs already keep. Nothing
 * here decides what is wrong:
 * - what the nightly booking money check last found, read back from its
 *   `CronJobRun` row through `parseBookingMoneyCensusSummary`. Drift is one
 *   critical item. Known classes the owner has not acknowledged are a separate
 *   info item: the server holds no acknowledgement file, so they stay listed,
 *   as history and not as an emergency;
 * - that the check failed or went stale, by the cron-health classifier
 *   (`buildCronHealthReport`), so a check that stopped never reads as clean;
 * - members whose credit balance is below zero, and cancelled bookings still
 *   holding applied credit: the two reads the daily credit reconciliation
 *   reports to Sentry (`readMemberCreditBalances`, `findOrphanedAppliedCredits`).
 *
 * NAMES (#2823). Every item keeps its count and link for any support admin.
 * The rows naming a booking's owner or a member are read only for a membership
 * viewer, and a credit amount is printed only for one who also holds finance
 * view (#4959).
 */
import { adminAnchorHref, adminHref } from "@/lib/admin-hubs";
import { buildCronHealthReport, getAdminCronJobDefinitions, type AdminCronRun } from "@/lib/admin-cron-health";
import { getExpectedJobCronRuns } from "@/lib/admin-cron-runs";
import { BOOKING_LEDGER_CENSUS_COMMAND, BOOKING_MONEY_CENSUS_JOB_NAME } from "@/lib/booking-money-census-job";
import {
  BOOKING_MONEY_RECONCILIATION_CENSUS_COMMAND,
  describeBookingMoneyCensusClass,
  isBookingMoneyCensusDrift,
  parseBookingMoneyCensusSummary,
  type BookingMoneyCensusClassSummary,
  type BookingMoneyCensusSummary,
} from "@/lib/booking-money-census-summary";
import { formatBookingReference } from "@/lib/booking-reference";
import { getClubTimeZone } from "@/lib/club-time-zone-settings";
import { readMemberCreditBalances } from "@/lib/member-credit-balances";
import { findOrphanedAppliedCredits, type OrphanedAppliedCreditFinding } from "@/lib/orphaned-applied-credit-backfill";
import { prisma } from "@/lib/prisma";
import {
  bookingDetailRow,
  OWNED_BOOKING_SELECT,
  STUCK_STATE_DETAIL_ROW_CAP,
  type OwnedBooking,
  type StuckStateDetail,
  type StuckStateDetailFormat,
} from "@/lib/stuck-state-payment-signals";

/** The command that returns orphaned applied credit once the cause is known (`docs/MAINTENANCE.md`). */
const ORPHANED_CREDIT_BACKFILL_COMMAND = "pnpm run payments:backfill-orphaned-credits";

export type BookingMoneyCensusRunState = {
  /**
   * Why the nightly check cannot be relied on: its latest run failed, or its
   * last good run is older than the daily stale window. Null when it is
   * current, and when it has never run (Background Jobs lists that as missing).
   */
  problem: string | null;
  /** When the last good run finished; null when there is none. */
  checkedAt: Date | null;
  /** What the last good run found; null when there is none. */
  summary: BookingMoneyCensusSummary | null;
};

type NegativeCreditBalance = { memberId: string; balanceCents: number };
type NamedMember = { id: string; firstName: string; lastName: string };

/** What the money-check items read. The dashboard's dependencies carry all of it. */
export interface StuckStateMoneyDependencies {
  /** The nightly booking money check: whether its latest run can be relied on, and what it last found. */
  readLatestBookingMoneyCensusRun: (now: Date) => Promise<BookingMoneyCensusRunState>;
  /** Members whose account credit balance is below zero, lowest first. */
  listNegativeCreditBalances: () => Promise<NegativeCreditBalance[]>;
  /** Cancelled bookings still holding applied credit (#1547). */
  findOrphanedAppliedCredits: () => Promise<{
    findings: ReadonlyArray<Pick<OrphanedAppliedCreditFinding, "bookingId" | "appliedCreditCents">>;
  }>;
  /** The bookings the named rows print. Called only for a membership viewer. */
  listMoneyCheckBookings: (bookingIds: readonly string[]) => Promise<OwnedBooking[]>;
  /** The members the named rows print. Called only for a membership viewer. */
  listMoneyCheckMembers: (memberIds: readonly string[]) => Promise<NamedMember[]>;
}

function runTime(run: AdminCronRun): number {
  return new Date(run.completedAt ?? run.startedAt).getTime();
}

/**
 * The nightly check's state from its own runs. Health is the cron-health
 * classifier's answer for this job (one definition of failed and stale,
 * `INV-SSOT`), asked of the rows alone: the web process that renders the page
 * usually schedules no cron, and that must not read as the check being off.
 */
export function classifyBookingMoneyCensusRuns(
  runs: readonly AdminCronRun[],
  clubTimeZone: string,
  now: Date,
): BookingMoneyCensusRunState {
  const definition = getAdminCronJobDefinitions(clubTimeZone).find(
    (candidate) => candidate.jobName === BOOKING_MONEY_CENSUS_JOB_NAME,
  );
  if (!definition) throw new Error(`${BOOKING_MONEY_CENSUS_JOB_NAME} is not in the admin cron health list`);
  const job = buildCronHealthReport({
    runs: [...runs],
    clubTimeZone,
    now,
    definitions: [{ ...definition, enabled: true, disabledReason: null }],
  }).jobs[0];

  const lastGood = runs.filter((run) => run.status === "SUCCESS").sort((a, b) => runTime(b) - runTime(a))[0];
  const summary = lastGood ? parseBookingMoneyCensusSummary(lastGood.resultSummary) : null;
  // "missing" is the job never having run: not a problem this page reports.
  // A skipped run over a good one inside the stale window is not one either.
  const reliable =
    job.status === "current" ||
    job.status === "warning" ||
    job.status === "missing" ||
    (job.status === "skipped" && lastGood !== undefined);
  let problem = reliable ? null : job.summary;
  if (!problem && lastGood && !summary) problem = "Its latest summary could not be read.";
  return { problem, checkedAt: lastGood ? new Date(runTime(lastGood)) : null, summary };
}

export const defaultStuckStateMoneyDependencies: StuckStateMoneyDependencies = {
  readLatestBookingMoneyCensusRun: async (now) => {
    const [clubTimeZone, runs] = await Promise.all([
      getClubTimeZone(),
      getExpectedJobCronRuns(BOOKING_MONEY_CENSUS_JOB_NAME),
    ]);
    return classifyBookingMoneyCensusRuns(runs, clubTimeZone, now);
  },
  listNegativeCreditBalances: async () =>
    (await readMemberCreditBalances())
      .filter((balance) => balance.balanceCents < 0)
      .sort((a, b) => a.balanceCents - b.balanceCents || a.memberId.localeCompare(b.memberId)),
  findOrphanedAppliedCredits: () => findOrphanedAppliedCredits(),
  listMoneyCheckBookings: (bookingIds) =>
    prisma.booking.findMany({ where: { id: { in: [...bookingIds] } }, select: OWNED_BOOKING_SELECT }),
  listMoneyCheckMembers: (memberIds) =>
    prisma.member.findMany({
      where: { id: { in: [...memberIds] } },
      select: { id: true, firstName: true, lastName: true },
    }),
};

/** One money-check item, without the domain the dashboard files it under. */
export type StuckStateMoneyItem = {
  id: string;
  title: string;
  severity: "critical" | "warning" | "info";
  owner: "Finance" | "System";
  count: number;
  href: string;
  summary: string;
  details?: StuckStateDetail[];
};

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

/** `CAPTURED disagreement (2), NO_LINES coverage gap (1)`: classes and counts, no booking ids. */
function classCounts(classes: readonly BookingMoneyCensusClassSummary[]): string {
  return classes.map((entry) => `${describeBookingMoneyCensusClass(entry)} (${entry.count})`).join(", ");
}

/** The bookings a set of classes names, in order, no more than a signal may list. */
function classBookingRows(classes: readonly BookingMoneyCensusClassSummary[]) {
  return classes
    .flatMap((entry) => entry.bookingIds.map((bookingId) => ({ entry, bookingId })))
    .slice(0, STUCK_STATE_DETAIL_ROW_CAP);
}

/** What the price check in the same run counted; empty when every booking reconciled. */
function reconciliationSentence(summary: BookingMoneyCensusSummary): string {
  const { unreconciled, totalBookings, byReason } = summary.reconciliation;
  if (unreconciled === 0) return "";
  const reasons = Object.entries(byReason)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  return ` The price check in the same run counted ${unreconciled} of ${totalBookings} ${plural(totalBookings, "booking")} whose price records do not reconcile (${reasons}); ${BOOKING_MONEY_RECONCILIATION_CENSUS_COMMAND} prints the breakdown.`;
}

/**
 * The money-check items to show, in no particular order (the dashboard sorts).
 * An item with nothing to report is left out.
 */
export async function getMoneyCheckItems(
  deps: StuckStateMoneyDependencies & { loadDetailFormat: () => Promise<StuckStateDetailFormat> },
  now: Date,
  viewer: { membership: boolean; finance: boolean },
): Promise<StuckStateMoneyItem[]> {
  const [run, negative, orphaned] = await Promise.all([
    deps.readLatestBookingMoneyCensusRun(now),
    deps.listNegativeCreditBalances(),
    deps.findOrphanedAppliedCredits(),
  ]);
  const { summary } = run;
  const drift = summary?.classes.filter(isBookingMoneyCensusDrift) ?? [];
  const known = summary?.classes.filter((entry) => !isBookingMoneyCensusDrift(entry)) ?? [];
  const driftRows = classBookingRows(drift);
  const knownRows = classBookingRows(known);
  const negativeRows = negative.slice(0, STUCK_STATE_DETAIL_ROW_CAP);
  const orphanedRows = orphaned.findings.slice(0, STUCK_STATE_DETAIL_ROW_CAP);

  // #2823: without membership view the name lookups never run.
  const bookingIds = viewer.membership
    ? [...new Set([...driftRows, ...knownRows, ...orphanedRows].map((row) => row.bookingId))]
    : [];
  const memberIds = viewer.membership ? negativeRows.map((row) => row.memberId) : [];
  const [bookings, members] = await Promise.all([
    bookingIds.length > 0 ? deps.listMoneyCheckBookings(bookingIds) : [],
    memberIds.length > 0 ? deps.listMoneyCheckMembers(memberIds) : [],
  ]);
  const bookingsById = new Map(bookings.map((booking) => [booking.id, booking]));
  const membersById = new Map(members.map((member) => [member.id, member]));
  // The format is read only when an item prints the check's date or an amount.
  const printsCheckDate =
    run.checkedAt !== null &&
    (run.problem !== null || (summary !== null && summary.drift + summary.unacknowledgedClassInstances > 0));
  const printsAmount = viewer.finance && negativeRows.length + orphanedRows.length > 0;
  const format = printsCheckDate || printsAmount ? await deps.loadDetailFormat() : null;
  const checkedOn = run.checkedAt && format ? format.instantDate(run.checkedAt) : null;
  const theCheck = checkedOn ? `The nightly check on ${checkedOn}` : "The nightly check";

  const bookingRow = (id: string, bookingId: string, line: string): StuckStateDetail => {
    const booking = bookingsById.get(bookingId);
    // A booking no longer on file still gets its row, by reference alone.
    return booking
      ? bookingDetailRow(id, booking, line)
      : { id, title: formatBookingReference(bookingId), summary: line, href: `/bookings/${bookingId}` };
  };
  const classDetails = (rows: ReturnType<typeof classBookingRows>) =>
    viewer.membership
      ? rows.map(({ entry, bookingId }) =>
          bookingRow(`${entry.class}:${bookingId}`, bookingId, `${describeBookingMoneyCensusClass(entry)}.`),
        )
      : undefined;

  const items: StuckStateMoneyItem[] = [];
  if (summary && summary.drift > 0) {
    items.push({
      id: "payment-booking-money-census-drift",
      title: "Booking money records disagree",
      severity: "critical",
      owner: "Finance",
      count: summary.drift,
      href: adminAnchorHref("stuck-states", "payment-booking-money-census-drift"),
      summary: `${theCheck} found ${summary.drift} ${plural(summary.drift, "finding")} where a booking's payment records and its ledger lines disagree, or could not be compared: ${classCounts(drift)}. The check only reads, so nothing has been repaired. For the full report, run ${BOOKING_LEDGER_CENSUS_COMMAND} on the server.${reconciliationSentence(summary)}`,
      details: classDetails(driftRows),
    });
  }
  if (summary && summary.unacknowledgedClassInstances > 0) {
    items.push({
      id: "payment-booking-money-census-known",
      title: "Known booking money classes not acknowledged",
      severity: "info",
      owner: "Finance",
      count: summary.unacknowledgedClassInstances,
      href: adminAnchorHref("stuck-states", "payment-booking-money-census-known"),
      summary: `${theCheck} counted ${summary.unacknowledgedClassInstances} ${plural(summary.unacknowledgedClassInstances, "instance")} of known classes the owner has not acknowledged: ${classCounts(known)}. These are known history, not new faults. The server holds no acknowledgement file, so they stay listed here; ${BOOKING_LEDGER_CENSUS_COMMAND} --acknowledged <owner-file.json> checks them against the owner's file.${summary.drift > 0 ? "" : reconciliationSentence(summary)}`,
      details: classDetails(knownRows),
    });
  }
  if (run.problem) {
    items.push({
      id: "payment-booking-money-census-not-run",
      title: "Money check did not run",
      severity: "warning",
      owner: "System",
      count: 1,
      href: adminHref("background-jobs"),
      summary: `The nightly booking money check cannot be relied on. ${run.problem} ${
        checkedOn
          ? `Anything it reports on this page is from its last good run on ${checkedOn}.`
          : "It has no good run to report from."
      } Open Background Jobs for its history; ${BOOKING_LEDGER_CENSUS_COMMAND} runs the same check by hand.`,
    });
  }
  if (negative.length > 0) {
    items.push({
      id: "payment-negative-credit-balances",
      title: "Members with negative credit",
      severity: "critical",
      owner: "Finance",
      count: negative.length,
      href: adminAnchorHref("stuck-states", "payment-negative-credit-balances"),
      summary: `${negative.length} ${plural(negative.length, "member")} ${plural(negative.length, "has", "have")} an account credit balance below zero, which should never happen: more credit was used than was ever added. Open each member's credit history to find the entry that took it below zero.`,
      details: viewer.membership
        ? negativeRows.map((row) => {
            const member = membersById.get(row.memberId);
            return {
              id: row.memberId,
              title: [member?.firstName, member?.lastName].filter(Boolean).join(" ") || "Member",
              summary:
                viewer.finance && format
                  ? `Credit balance ${format.cents(row.balanceCents)}.`
                  : "Credit balance is below zero.",
              href: adminHref("member-detail", { id: row.memberId }),
            };
          })
        : undefined,
    });
  }
  if (orphaned.findings.length > 0) {
    const count = orphaned.findings.length;
    items.push({
      id: "payment-orphaned-applied-credit",
      title: "Cancelled bookings still holding credit",
      severity: "critical",
      owner: "Finance",
      count,
      href: adminAnchorHref("stuck-states", "payment-orphaned-applied-credit"),
      summary: `${count} cancelled ${plural(count, "booking")} still ${plural(count, "holds", "hold")} account credit that was applied to ${plural(count, "it", "them")} and never returned to the member. The app does not return it by itself: find out why the cancellation did not, then run ${ORPHANED_CREDIT_BACKFILL_COMMAND} on the server.`,
      details: viewer.membership
        ? orphanedRows.map((row) =>
            bookingRow(
              row.bookingId,
              row.bookingId,
              viewer.finance && format
                ? `${format.cents(row.appliedCreditCents)} of applied credit not returned.`
                : "Applied credit not returned.",
            ),
          )
        : undefined,
    });
  }
  return items;
}
