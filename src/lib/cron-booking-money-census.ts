/**
 * THE NIGHTLY BOOKING MONEY CHECK (#4910, `INV-PAY-164`).
 *
 * Runs the two censuses an operator could only run by hand before: the
 * booking-ledger census (`INV-MONEY-037`), which compares every booking's
 * payment columns with its ledger lines, and the booking-money reconciliation
 * census (`INV-MONEY-031`). It calls them as they are, so there is one census
 * and one definition of every class (`INV-SSOT`).
 *
 * READ-ONLY. Each census reads inside its own read-only snapshot, and this job
 * repairs nothing: it takes no advisory lock (`INV-LOCK-001`), and the only
 * rows a run leaves are its `CronJobRun` row (written by the scheduler), the
 * once-ever alert claims in `AlertCooldown`, and the alert's own email rows.
 *
 * NO ACKNOWLEDGEMENTS. The operator command takes the owner's acknowledgement
 * file; the server has none, so every finding is reported, the known history
 * included. Three things keep that from becoming noise:
 * - ONLY DRIFT IS EMAILED (owner decision, 28 Nov 2026): a known class such as
 *   `IN_FLIGHT_REFUND` follows most cancellations, so it is never emailed. The
 *   summary keeps known-class instances apart from drift
 *   (`booking-money-census-summary.ts`), and the Stuck States page shows them
 *   as an info item awaiting acknowledgement, not as an emergency;
 * - each drift finding (a census class on a booking) is alerted ONCE, the
 *   first night it is seen, under a once-ever key;
 * - a night with no new drift sends nothing.
 *
 * ONE EMAIL PER NIGHT. The new drift findings go out together under a digest key
 * made from their keys; each finding's own key is stamped only once that email
 * is kept (an admin was sent it, or a copy waits for the email retry cron).
 * If nobody can receive it, or the send fails, nothing is stamped, the run's
 * summary carries a warning (Background Jobs shows it) and a later night tries
 * again. Limits: if the email is kept and a stamp then fails twice, the next
 * night either finds the same digest kept and stamps without sending, or, when
 * another finding arrived meanwhile, names the unstamped ones again. Two
 * instances running the same night send one email when they find the same new
 * findings (one digest key); if a finding lands between their reads, each sends
 * its own and the findings both saw are named twice.
 */
import { createHash } from "node:crypto";

import {
  findHeldOnceEverAlertKeys,
  readOnceEverClaimState,
  sendAdminAlertOnceEver,
  stampOnceEverAlertSent,
} from "@/lib/admin-alert-once";
import type { BookingLedgerCensusReport } from "@/lib/booking-ledger-projection-census-report";
import { CENSUS_PAGE_SIZE, censusBookingLedgerProjection } from "@/lib/booking-ledger-projection-census-store";
import { BOOKING_MONEY_CENSUS_JOB_NAME } from "@/lib/booking-money-census-job";
import {
  bookingMoneyCensusAlertKey,
  isBookingMoneyCensusDrift,
  listBookingMoneyCensusFindings,
  summarizeBookingMoneyCensus,
  summarizeBookingMoneyCensusClasses,
  type BookingMoneyCensusFinding,
  type BookingMoneyCensusSummary,
} from "@/lib/booking-money-census-summary";
import type { BookingMoneyReconciliationSummary } from "@/lib/booking-money-reconciliation";
import { censusBookingMoneyReconciliation } from "@/lib/booking-money-reconciliation-store";
import { getClubFormat } from "@/lib/club-format-settings";
import type { ClubTimeZone } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { sendAdminBookingMoneyCensusAlert } from "@/lib/email/admin-alerts-booking-money-census";
import { bookingJournalInactiveReason } from "@/lib/member-money";
import { reportCronError } from "@/lib/observability-bridge";
import { prisma } from "@/lib/prisma";

const ALERT_LABEL = "booking money check alert";
/** How many once-ever keys one held-key read asks for; exported for the test that crosses a chunk edge. */
export const HELD_KEY_READ_SIZE = 1000;

/** Everything the run reaches, so a test runs it without a database. */
export type BookingMoneyCensusDependencies = {
  /** The club's zone, read outside any snapshot (`INV-DATE-019`, `INV-CONFIG-002`). */
  readZone: () => Promise<ClubTimeZone>;
  /** Why the journal posts nothing for this club, or null; read outside any snapshot. */
  readJournalInactive: () => Promise<string | null>;
  censusLedger: (options: { journalInactive: string | null; pageSize: number }) => Promise<BookingLedgerCensusReport>;
  censusMoney: (zone: ClubTimeZone) => Promise<BookingMoneyReconciliationSummary>;
  findHeldKeys: typeof findHeldOnceEverAlertKeys;
  readClaimState: typeof readOnceEverClaimState;
  sendOnceEver: typeof sendAdminAlertOnceEver;
  sendAlert: typeof sendAdminBookingMoneyCensusAlert;
  stampSent: typeof stampOnceEverAlertSent;
  now: () => Date;
};

const defaultDependencies: BookingMoneyCensusDependencies = {
  readZone: readClubTimeZoneOutsideRequest,
  readJournalInactive: async () => bookingJournalInactiveReason(await getClubFormat()),
  // No acknowledgements: the server holds no owner file, so every finding is reported.
  censusLedger: (options) => censusBookingLedgerProjection(prisma, options),
  censusMoney: (zone) => censusBookingMoneyReconciliation(prisma, zone),
  findHeldKeys: findHeldOnceEverAlertKeys,
  readClaimState: readOnceEverClaimState,
  sendOnceEver: sendAdminAlertOnceEver,
  sendAlert: sendAdminBookingMoneyCensusAlert,
  stampSent: stampOnceEverAlertSent,
  now: () => new Date(),
};

/** The findings no once-ever key holds yet: never alerted, or given back after a send that failed. */
async function findingsNotAlertedBefore(
  findings: readonly BookingMoneyCensusFinding[],
  deps: Pick<BookingMoneyCensusDependencies, "findHeldKeys">,
  now: Date,
): Promise<BookingMoneyCensusFinding[]> {
  const keys = findings.map(bookingMoneyCensusAlertKey);
  const held = new Set<string>();
  for (let start = 0; start < keys.length; start += HELD_KEY_READ_SIZE) {
    for (const key of await deps.findHeldKeys(keys.slice(start, start + HELD_KEY_READ_SIZE), now)) held.add(key);
  }
  return findings.filter((finding) => !held.has(bookingMoneyCensusAlertKey(finding)));
}

/**
 * Send one alert for the drift findings not alerted before, then stamp each so later
 * nights stay quiet. Returns what it did, `failed` when new findings reached
 * nobody; throws only if the alert store cannot be read.
 */
async function alertNewFindings(
  findings: readonly BookingMoneyCensusFinding[],
  deps: BookingMoneyCensusDependencies,
): Promise<BookingMoneyCensusSummary["alert"]> {
  const now = deps.now();
  const fresh = await findingsNotAlertedBefore(findings, deps, now);
  if (fresh.length === 0) return { newFindings: 0, sent: false, failed: false };

  const freshKeys = fresh.map(bookingMoneyCensusAlertKey).sort();
  const digest = createHash("sha256").update(freshKeys.join("\n")).digest("hex").slice(0, 32);
  const digestKey = `${BOOKING_MONEY_CENSUS_JOB_NAME}:digest:${digest}`;
  const context = { job: BOOKING_MONEY_CENSUS_JOB_NAME, newFindings: fresh.length, digestKey };
  const sent = await deps.sendOnceEver({
    key: digestKey,
    label: ALERT_LABEL,
    context,
    send: () => deps.sendAlert({ newFindings: fresh.length, classes: summarizeBookingMoneyCensusClasses(fresh) }),
  });
  // Not kept by this run, so ask where the digest's claim stands.
  // - `kept`: an earlier night sent this very digest and its stamps failed.
  //   Stamp now; the email is not sent twice.
  // - `awaiting-send`: another instance is sending it now, and stamps it.
  // - `none` or `deferred`: the send failed, or no admin can receive it. The
  //   once-ever helper never throws, so this is the only place that can say so.
  const claim = sent ? "kept" : await deps.readClaimState(digestKey, now);
  if (claim === "kept") {
    for (const key of freshKeys) await deps.stampSent(key, ALERT_LABEL, { ...context, findingKey: key });
  }
  return { newFindings: fresh.length, sent, failed: claim === "none" || claim === "deferred" };
}

/**
 * One nightly run: both censuses, the bounded summary the scheduler records,
 * and an alert for anything new. A census that throws fails the run, so the
 * scheduler records FAILURE and the Stuck States page says the check did not
 * run. Only drift is alerted; known classes stay on the page. A failure in the alert step alone leaves the summary standing, with a
 * warning: the findings are still on the page, and a later night alerts.
 */
export async function runBookingMoneyCensus(
  overrides: Partial<BookingMoneyCensusDependencies> = {},
): Promise<BookingMoneyCensusSummary> {
  const deps = { ...defaultDependencies, ...overrides };
  const zone = await deps.readZone();
  const journalInactive = await deps.readJournalInactive();
  const ledger = await deps.censusLedger({ journalInactive, pageSize: CENSUS_PAGE_SIZE });
  const money = await deps.censusMoney(zone);
  const findings = listBookingMoneyCensusFindings(ledger);

  let alert: BookingMoneyCensusSummary["alert"];
  try {
    // Known classes are left to the Stuck States info item: only drift is emailed.
    alert = await alertNewFindings(findings.filter(isBookingMoneyCensusDrift), deps);
  } catch (err) {
    reportCronError({
      tag: `${BOOKING_MONEY_CENSUS_JOB_NAME}-alert`,
      err,
      message: "The booking money check could not send its alert; the next run tries again",
    });
    alert = { newFindings: 0, sent: false, failed: true };
  }
  return summarizeBookingMoneyCensus({ ledger, money, findings, alert });
}
