/**
 * #2501 — Xero credit-sync checker (detect-and-warn reconciliation).
 *
 * The owner's #2483 decision split the unpaid-confirmation credit problem in
 * two: the member-facing email nets credit from BookingApp's OWN ledger with no
 * wait on Xero (delivered under #2483), and THIS separate checker keeps that
 * local ledger and Xero's live invoice allocations in sync — warning admins,
 * with the exact amount, whenever they drift. That split is what makes the
 * local computation safe: a manual Xero-side edit that diverges from the local
 * ledger surfaces to an admin instead of the two silently disagreeing.
 *
 * WHAT IT RECONCILES (per the docblock in booking-money-lines.ts →
 * `resolveUnpaidCreditNetting`): the population is every booking with at least
 * one `BOOKING_APPLIED` row STAMPED with a Xero credit-note id — i.e. a booking
 * BookingApp believes it has allocated credit onto a Xero invoice for. For each,
 * it compares
 *
 *   localCents  = |Σ ALL BOOKING_APPLIED rows| (net)   (BookingApp's known credit)
 *   xeroCents   = Σ appliedAmount of the invoice's credit notes RESTRICTED to the
 *                 ones BookingApp STAMPED for this booking (Xero's live member-
 *                 account-credit allocation)
 *
 * and reports drift when they are not equal (a credit BookingApp thinks it
 * applied that Xero does not show allocated, or vice versa), naming the member,
 * booking, invoice and the EXACT integer-cent amount.
 *
 * WHY PER-NOTE, NOT invoice.amountCredited (Finding #2501-1): a single invoice
 * can carry credit notes of MORE THAN ONE class. Besides the member-account
 * credit notes this checker owns, BookingApp allocates a downward-reprice
 * MODIFICATION credit note (`createXeroCreditNoteForModification`) to the SAME
 * invoice when a booking is trimmed. That note inflates `invoice.amountCredited`
 * but is NOT a MemberCredit `BOOKING_APPLIED` row, so it never enters
 * `localCents`. Comparing `localCents` against `amountCredited` would therefore
 * report a permanent false `excess_in_xero` on every credit-using booking later
 * repriced downward. Restricting the Xero side to the STAMPED member credit-note
 * ids isolates the one allocation class both sides actually track.
 *
 * The local metric nets ALL BOOKING_APPLIED rows (not just the stamped ones): it
 * is the same figure `deriveBookingAppliedCreditCents` and the #2483 email use,
 * and netting is what lets a COMPLETED #1887 clamp deallocation reconcile — the
 * clamp appends an UNSTAMPED positive offset and deallocates the invoice, so the
 * net falls to match Xero. Summing stamped rows alone would read that settled
 * state as drift. The STAMPED credit-note ids select the population AND scope the
 * Xero-side comparison to the member-account allocation.
 *
 * DISCIPLINE (Critical — Xero + money):
 *  - READ-ONLY. It NEVER mutates financial state to "fix" drift: the owner asked
 *    for a warning, not an auto-correct. An auto-correct here would risk masking
 *    the very regression the checker exists to surface (cf. the #1547 alert-only
 *    orphaned-credit rule in cron-credit-reconciliation.ts).
 *  - Money is integer cents; the only arithmetic is subtraction, so no rounding.
 *  - Xero calls run OUTSIDE any DB transaction and pass `armTransientBreaker:
 *    false` (#2394/#2423 posture): this decorative reconciliation read must not
 *    arm the process-global breaker and take invoicing/sync/webhooks down. It
 *    still RESPECTS a breaker armed elsewhere (withXeroRetry refuses up front).
 *  - FAIL SAFE. A Xero read failure (outage, rate-limit, degraded payload)
 *    DEFERS that booking — it never emits a false-drift warning. A booking with
 *    an in-flight allocation/deallocation op is deferred too (mid-flight, not
 *    drift). Only a settled mismatch warns.
 *  - IDEMPOTENT. Re-running produces the same findings and sends at most one
 *    warning per recheck interval (a completed pass throttles the next runs off
 *    the CronJobRun history — no schema, no per-booking state).
 *
 * SCOPE. The scan universe is exactly the STAMPED-credit population, which is
 * the population the owner named and the only one for which a Xero-invoice
 * allocation is provably expected. Applied credit that BookingApp never stamped
 * (e.g. card-netted credit that reduces the charge instead of a Xero invoice) is
 * deliberately out of scope: distinguishing it from a genuinely stalled IB
 * allocation needs the payment source, and the failed/stalled-op class is
 * already surfaced by the Xero reconciliation report. See the report for the
 * carried-forward follow-ups.
 */
import { CreditType } from "@prisma/client";
import { prisma } from "./prisma";
import { bookingOwner } from "@/lib/booking-owner";
import logger from "@/lib/logger";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";
import { sendAdminCreditSyncDriftAlert } from "@/lib/email";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import {
  type CreditSyncDriftItemEmail,
  type CreditSyncDriftReportEmail,
} from "@/lib/email-templates/admin-xero-reports";

/**
 * Cron job name for this checker. The Xero cron runner records each run under
 * this name; the throttle below reads that history back, so the two MUST agree
 * — the runner imports this constant rather than repeating the string.
 */
export const XERO_CREDIT_SYNC_JOB_NAME = "xero-credit-sync-check";

// A completed pass throttles real Xero work to roughly once a day, so bundling
// this task into a frequently-run `all` cron cannot burn the org's daily Xero
// quota, and a persisting drift warns at most once per interval rather than on
// every tick. 20h (< 24h) so a once-daily external schedule always fires.
// FLAGGED DEFAULT (owner may retune): recheck interval + booking cap.
const DEFAULT_MIN_RECHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;

// Hard cap on invoices read from Xero per run, so a pathological backlog cannot
// unbounded-read. Applied-credit-to-invoice bookings are rare, so this normally
// covers the whole population; a truncated run marks the pass incomplete (so it
// is not throttled) and logs that more remain.
const DEFAULT_CREDIT_SYNC_BOOKING_LIMIT = 250;

/** Per-note detail retained on a drift item for the "detailed amount" email. */
export interface CreditSyncInvoiceNote {
  creditNoteId: string | null;
  creditNoteNumber: string | null;
  appliedCents: number;
}

/** Parsed live-invoice read used by the reconciliation. */
export interface CreditSyncInvoiceRead {
  found: boolean;
  /** round(invoice.amountCredited * 100), or null on a degraded payload. Used
   * ONLY as a degraded-payload guard (null => defer); the drift comparison sums
   * the per-note `notes[].appliedCents` restricted to the stamped member notes. */
  amountCreditedCents: number | null;
  invoiceNumber: string | null;
  notes: CreditSyncInvoiceNote[];
}

export interface XeroCreditSyncCheckResult {
  /** True when the run did no Xero work (disconnected, throttled, or nothing to
   * check). The cron runner records a skipped run as SKIPPED. */
  skipped: boolean;
  reason?: string;
  /** Bookings with a positive stamped-applied-credit position (the scan set). */
  scannedBookings: number;
  /** Bookings whose Xero invoice was actually read and compared this run. */
  checkedBookings: number;
  /** Bookings deferred (in-flight op, Xero read failure, or degraded payload). */
  deferredBookings: number;
  /** Bookings whose local stamped credit did not match Xero's allocation. */
  driftBookings: number;
  /** Σ of the exact per-booking drift amounts, integer cents. */
  totalDriftCents: number;
  /** True only when every scanned booking was checked with no deferral and the
   * scan was not truncated — the property the throttle keys on. */
  completePass: boolean;
  /** True when an admin drift warning was dispatched this run. */
  emailSent: boolean;
}

export interface XeroCreditSyncCheckerDeps {
  now?: Date;
  minRecheckIntervalMs?: number;
  bookingLimit?: number;
  db?: typeof prisma;
  /** Read a live Xero invoice's credit allocation. Injected in tests; throws on
   * a Xero outage/rate-limit so the caller can defer rather than false-warn. */
  readInvoiceCreditAllocation?: (invoiceId: string) => Promise<CreditSyncInvoiceRead>;
  sendAlert?: (report: CreditSyncDriftReportEmail) => Promise<void>;
}

function toFiniteCents(value: number | null | undefined): number | null {
  return providerAmountToCents(value);
}

/**
 * Default live reader: fetch the invoice and read its credit-note allocation.
 * `creditNotes[].appliedAmount` is the per-note breakdown the reconciliation
 * compares against (restricted to the member-stamped notes — see the module
 * docblock, Finding #2501-1). `amountCredited` is Xero's own total across ALL
 * credit-note classes on the invoice; it is retained only as a degraded-payload
 * signal (unreadable => defer), NOT as the comparison basis. Pass
 * `armTransientBreaker: false` so a read failure here never arms the global
 * breaker (this is a reconciliation read, not invoicing).
 */
async function readInvoiceCreditAllocationLive(
  invoiceId: string
): Promise<CreditSyncInvoiceRead> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getInvoice(tenantId, invoiceId),
    {
      operation: "getInvoice",
      resourceType: "INVOICE",
      workflow: "xeroCreditSyncCheck",
      context: `xeroCreditSyncCheck(${invoiceId})`,
      // Reconciliation read: never take invoicing/sync/webhooks down if it 5xxs.
      armTransientBreaker: false,
    }
  );

  const invoice = response.body.invoices?.[0];
  if (!invoice?.invoiceID) {
    return { found: false, amountCreditedCents: null, invoiceNumber: null, notes: [] };
  }

  const notes: CreditSyncInvoiceNote[] = (invoice.creditNotes ?? []).map((cn) => ({
    creditNoteId: cn.creditNoteID ?? null,
    creditNoteNumber: cn.creditNoteNumber ?? null,
    appliedCents: toFiniteCents(cn.appliedAmount) ?? 0,
  }));

  return {
    found: true,
    amountCreditedCents: toFiniteCents(invoice.amountCredited),
    invoiceNumber: invoice.invoiceNumber ?? null,
    notes,
  };
}

/**
 * Does this booking's payment have a Xero allocation op mid-flight? Both the
 * allocate and deallocate ops share entityType ALLOCATION on the Payment, so a
 * PENDING/RUNNING one means the local ledger and Xero are being reconciled RIGHT
 * NOW — a transient window, not settled drift. Used twice: once as a fast
 * pre-filter before the Xero read, and again after it to collapse the
 * snapshot-skew window before warning (Finding #2501-2).
 */
async function hasInFlightAllocationOp(
  db: typeof prisma,
  paymentId: string
): Promise<boolean> {
  const inFlight = await db.xeroSyncOperation.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      entityType: "ALLOCATION",
      status: { in: ["PENDING", "RUNNING"] },
    },
    select: { id: true },
  });
  return inFlight !== null;
}

/**
 * Re-read the LIVE net applied credit for one booking (Finding #2501-2). Same
 * metric as the pre-loop bulk snapshot — the net over ALL BOOKING_APPLIED rows,
 * clamped at zero so a completed #1887 clamp offset nets down rather than going
 * negative — but read fresh, immediately alongside the Xero read, so a
 * concurrent allocation/deallocation in the gap between the snapshot and the
 * Xero read cannot make a settled ledger look drifted.
 */
async function readBookingNetAppliedCredit(
  db: typeof prisma,
  bookingId: string
): Promise<number> {
  const agg = await db.memberCredit.aggregate({
    where: {
      type: CreditType.BOOKING_APPLIED,
      appliedToBookingId: bookingId,
    },
    _sum: { amountCents: true },
  });
  return Math.max(0, -(agg._sum.amountCents ?? 0));
}

function isCompletePassSummary(summary: unknown): boolean {
  return (
    !!summary &&
    typeof summary === "object" &&
    (summary as { completePass?: unknown }).completePass === true
  );
}

function emptyResult(
  overrides: Partial<XeroCreditSyncCheckResult> = {}
): XeroCreditSyncCheckResult {
  return {
    skipped: false,
    scannedBookings: 0,
    checkedBookings: 0,
    deferredBookings: 0,
    driftBookings: 0,
    totalDriftCents: 0,
    completePass: true,
    emailSent: false,
    ...overrides,
  };
}

/**
 * Reconcile BookingApp's stamped applied credit against Xero's live invoice
 * allocations and warn admins on drift. Read-only, idempotent, fail-safe.
 */
export async function reconcileXeroCreditSync(
  deps: XeroCreditSyncCheckerDeps = {}
): Promise<XeroCreditSyncCheckResult> {
  const now = deps.now ?? new Date();
  const minInterval = deps.minRecheckIntervalMs ?? DEFAULT_MIN_RECHECK_INTERVAL_MS;
  const limit = deps.bookingLimit ?? DEFAULT_CREDIT_SYNC_BOOKING_LIMIT;
  const readInvoice =
    deps.readInvoiceCreditAllocation ?? readInvoiceCreditAllocationLive;
  const sendAlert = deps.sendAlert ?? sendAdminCreditSyncDriftAlert;
  const db = deps.db ?? prisma;

  // 1) THROTTLE. If a COMPLETE pass finished within the interval, do no Xero
  // work — return skipped so the runner records SKIPPED. A prior run that was
  // truncated or deferred (Xero outage) is NOT a complete pass, so it does not
  // throttle and this run retries.
  if (minInterval > 0) {
    const recent = await db.cronJobRun.findFirst({
      where: {
        jobName: XERO_CREDIT_SYNC_JOB_NAME,
        status: "SUCCESS",
        startedAt: { gte: new Date(now.getTime() - minInterval) },
      },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, resultSummary: true },
    });
    if (recent && isCompletePassSummary(recent.resultSummary)) {
      return emptyResult({
        skipped: true,
        reason: "Throttled: a complete credit-sync pass ran within the recheck interval.",
      });
    }
  }

  // 2) LOCAL SCAN — two-step so the metric nets clamp offsets correctly.
  //
  // (a) POPULATION: bookings with at least one STAMPED BOOKING_APPLIED row (a
  //     row carrying a Xero credit-note id). A stamped row proves the booking is
  //     on the allocate-to-a-Xero-invoice path, so it is the population for which
  //     a Xero allocation is expected. Credit that was never stamped — card
  //     credit that reduces the charge rather than an invoice, or an allocation
  //     still pending — has no stamped row and is correctly out of scope.
  //     The stamped Xero credit-note ids are RETAINED per booking (not just the
  //     booking id): the reconciliation compares against ONLY the credit notes
  //     BookingApp itself stamped as this booking's member-account credit, so a
  //     different class of credit note allocated to the same invoice — most
  //     notably a downward-reprice modification credit note
  //     (createXeroCreditNoteForModification) — cannot masquerade as drift
  //     (Finding #2501-1).
  const stampedRows = await db.memberCredit.findMany({
    where: {
      type: CreditType.BOOKING_APPLIED,
      xeroCreditNoteId: { not: null },
      appliedToBookingId: { not: null },
    },
    select: { appliedToBookingId: true, xeroCreditNoteId: true },
  });

  const stampedCreditNoteIdsByBooking = new Map<string, Set<string>>();
  for (const row of stampedRows) {
    if (!row.appliedToBookingId || !row.xeroCreditNoteId) continue;
    let ids = stampedCreditNoteIdsByBooking.get(row.appliedToBookingId);
    if (!ids) {
      ids = new Set<string>();
      stampedCreditNoteIdsByBooking.set(row.appliedToBookingId, ids);
    }
    ids.add(row.xeroCreditNoteId);
  }

  const populationIds = [...stampedCreditNoteIdsByBooking.keys()].sort(); // deterministic order

  if (populationIds.length === 0) {
    logger.info({ scannedBookings: 0 }, "Credit sync check: no stamped applied credit to reconcile");
    return emptyResult({ completePass: true });
  }

  // Hard cap. A truncated run is not a complete pass (it must not throttle).
  const cappedIds = populationIds.slice(0, limit);
  const truncated = populationIds.length > cappedIds.length;

  // (b) METRIC: the NET applied credit over ALL BOOKING_APPLIED rows for the
  //     population — the same figure `deriveBookingAppliedCreditCents` and the
  //     #2483 email use. Netting all rows (not just the stamped ones) is what
  //     makes a COMPLETED #1887 clamp deallocation reconcile: the clamp appends
  //     an UNSTAMPED positive offset and deallocates the invoice, so the net
  //     falls to match Xero. Summing stamped rows alone would read the settled
  //     post-clamp state as drift.
  const netGroups = await db.memberCredit.groupBy({
    by: ["appliedToBookingId"],
    where: {
      type: CreditType.BOOKING_APPLIED,
      appliedToBookingId: { in: cappedIds },
    },
    _sum: { amountCents: true },
  });

  const localByBooking = new Map<string, number>();
  for (const group of netGroups) {
    if (!group.appliedToBookingId) continue;
    // Applied credit is negative; the positive clamp offset nets it down.
    localByBooking.set(
      group.appliedToBookingId,
      Math.max(0, -(group._sum.amountCents ?? 0))
    );
  }

  // Only bookings that CURRENTLY hold applied credit expected on a Xero invoice.
  // A fully-clamped booking (net 0) is not drift-relevant here; its stuck
  // deallocation, if any, surfaces as a FAILED op in the reconciliation report.
  const bookingIds = cappedIds.filter((id) => (localByBooking.get(id) ?? 0) > 0);

  const scannedBookings = bookingIds.length;
  if (scannedBookings === 0) {
    logger.info({ scannedBookings: 0 }, "Credit sync check: no live applied credit to reconcile");
    return emptyResult({ completePass: !truncated });
  }

  const bookings = await db.booking.findMany({
    where: { id: { in: bookingIds } },
    select: {
      id: true,
      member: { select: { firstName: true, lastName: true } },
      payment: { select: { id: true, xeroInvoiceId: true } },
    },
  });
  const bookingById = new Map(bookings.map((b) => [b.id, b]));

  const drifts: CreditSyncDriftItemEmail[] = [];
  let checkedBookings = 0;
  let deferredBookings = 0;
  let completePass = !truncated;

  for (const bookingId of bookingIds) {
    const localCents = localByBooking.get(bookingId) ?? 0;
    const booking = bookingById.get(bookingId);
    if (!booking) {
      // Booking hard-deleted since the groupBy; nothing to reconcile against.
      deferredBookings += 1;
      completePass = false;
      continue;
    }

    const memberName =
      `${bookingOwner(booking).member.firstName} ${bookingOwner(booking).member.lastName}`.trim() || "Member";
    const paymentId = booking.payment?.id ?? null;
    const invoiceId = booking.payment?.xeroInvoiceId ?? null;

    // Finding: applied credit believed on a Xero invoice, but none is linked.
    if (!invoiceId) {
      checkedBookings += 1;
      drifts.push({
        kind: "no_invoice",
        bookingId,
        memberName,
        invoiceId: null,
        invoiceNumber: null,
        invoiceUrl: null,
        localCents,
        xeroCents: 0,
        deltaCents: localCents,
        notes: [],
      });
      continue;
    }

    // Defer a booking whose allocation/deallocation is mid-flight — a transient
    // window, not drift. Fast pre-filter to skip a Xero read for an obviously
    // in-flight booking; the same guard is re-checked after the read to collapse
    // the snapshot-skew window (Finding #2501-2).
    if (paymentId && (await hasInFlightAllocationOp(db, paymentId))) {
      deferredBookings += 1;
      completePass = false;
      continue;
    }

    // Read the live invoice. ANY failure (outage, rate-limit, degraded payload)
    // defers this booking — a Xero read failure must never emit a false drift.
    let read: CreditSyncInvoiceRead;
    try {
      read = await readInvoice(invoiceId);
    } catch (err) {
      logger.warn(
        { err, bookingId, invoiceId },
        "Credit sync check: deferred booking (Xero read failed)"
      );
      deferredBookings += 1;
      completePass = false;
      continue;
    }

    // A degraded payload (`amountCredited` unreadable) defers: the per-note
    // breakdown the comparison relies on cannot be trusted either.
    if (!read.found || read.amountCreditedCents === null) {
      deferredBookings += 1;
      completePass = false;
      continue;
    }

    // Finding #2501-1: compare ONLY the member-account credit allocation. Xero's
    // invoice.amountCredited is the total of EVERY credit note allocated to the
    // invoice — including a downward-reprice modification credit note
    // (createXeroCreditNoteForModification), which is NOT a MemberCredit
    // BOOKING_APPLIED row and so never enters `localCents`. Comparing against it
    // would report a permanent false `excess_in_xero` on every credit-using
    // booking later trimmed downward. Instead, sum the per-note applied amounts
    // RESTRICTED to the credit notes BookingApp itself stamped for this booking.
    const stampedNoteIds = stampedCreditNoteIdsByBooking.get(bookingId);
    const stampedNotes = read.notes.filter(
      (note) => note.creditNoteId !== null && !!stampedNoteIds?.has(note.creditNoteId)
    );
    const xeroCents = stampedNotes.reduce((sum, note) => sum + note.appliedCents, 0);

    if (xeroCents === localCents) {
      checkedBookings += 1;
      continue;
    }

    // Potential drift. `localCents` came from the PRE-LOOP bulk snapshot while
    // this Xero read is live; a concurrent allocation/deallocation in that gap
    // would make a settled ledger look drifted (Finding #2501-2). Collapse that
    // window to align with the in-flight guard before warning: re-check the
    // in-flight op AND re-read the fresh local net, and warn only if a real
    // settled mismatch against the FRESH net remains.
    if (paymentId && (await hasInFlightAllocationOp(db, paymentId))) {
      deferredBookings += 1;
      completePass = false;
      continue;
    }
    const freshLocalCents = await readBookingNetAppliedCredit(db, bookingId);
    if (freshLocalCents === xeroCents) {
      // Snapshot skew, not drift: the fresh local net now matches Xero.
      checkedBookings += 1;
      continue;
    }

    checkedBookings += 1;
    drifts.push({
      kind: xeroCents < freshLocalCents ? "missing_in_xero" : "excess_in_xero",
      bookingId,
      memberName,
      invoiceId,
      invoiceNumber: read.invoiceNumber,
      invoiceUrl: buildXeroInvoiceUrl(invoiceId),
      localCents: freshLocalCents,
      xeroCents,
      deltaCents: Math.abs(freshLocalCents - xeroCents),
      notes: stampedNotes,
    });
  }

  const driftBookings = drifts.length;
  const totalDriftCents = drifts.reduce((sum, d) => sum + d.deltaCents, 0);

  let emailSent = false;
  if (driftBookings > 0) {
    const report: CreditSyncDriftReportEmail = {
      generatedAt: now,
      scannedBookings,
      checkedBookings,
      deferredBookings,
      totalDriftCents,
      drifts,
    };
    try {
      await sendAlert(report);
      emailSent = true;
    } catch (err) {
      // A send failure must not fail the whole checker (the drift is already
      // durable in this run's summary and re-detected next pass).
      logger.error({ err }, "Credit sync check: failed to send drift warning email");
    }

    // Operator-facing log carries ids + cents only — never member names/emails.
    logger.error(
      {
        alert: "XERO_CREDIT_SYNC_DRIFT",
        driftBookings,
        totalDriftCents,
        sample: drifts.slice(0, 10).map((d) => ({
          bookingId: d.bookingId,
          invoiceId: d.invoiceId,
          kind: d.kind,
          localCents: d.localCents,
          xeroCents: d.xeroCents,
          deltaCents: d.deltaCents,
        })),
      },
      `${driftBookings} booking(s) have applied credit that does not match Xero's live allocation`
    );
  }

  logger.info(
    {
      scannedBookings,
      checkedBookings,
      deferredBookings,
      driftBookings,
      totalDriftCents,
      completePass,
      emailSent,
    },
    "Credit sync check complete"
  );

  return {
    skipped: false,
    scannedBookings,
    checkedBookings,
    deferredBookings,
    driftBookings,
    totalDriftCents,
    completePass,
    emailSent,
  };
}
