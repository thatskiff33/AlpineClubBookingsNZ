/**
 * #3643 (`INV-PAY-107`): what the hold-expiry job does with an expired hold it
 * cannot simply release, and how the treasurer hears about it.
 *
 * The owner's option A: a hold whose invoice shows any payment is kept. The
 * orchestrator's decision on the thread bounds the case option A did not name —
 * an invoice Xero cannot read (disconnected, token lapsed, the invoice gone):
 * it is kept only until the club's check-in date or seven days past the hold
 * deadline, whichever comes first, then released with a second alert - except
 * that the release's own started-stay rule (#3663, `INV-PAY-016`) never cancels
 * a stay that has started, so the check-in arm hands the hold to that rule and
 * its one alert rather than releasing it. Nothing
 * is voided without a successful Xero read even then: the release only queues
 * the clearing note, and its builder reads the invoice and creates nothing when
 * the invoice owes less than the note (`xero-clearing-allocations.ts`).
 */
import { PaymentSource } from "@prisma/client";
import {
  ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  ALERT_ONCE_EVER_WINDOW_MS,
  deferAlertCooldown,
  listOwedAlertKeys,
  markAlertOwed,
  noteOwedAlertAttempt,
  releaseAlertCooldown,
  settleOwedAlert,
} from "@/lib/alert-cooldown";
import { claimAlertCooldownFailOpen } from "@/lib/alert-cooldown-fail-open";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, type RateLimitConfig } from "@/lib/rate-limit";
import type { AdminAlertSendOutcome } from "@/lib/email/admin-alert-send-result";
import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import { bookingStayHasStarted } from "@/lib/booking-edit-policy";
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminInternetBankingHoldKeptAlert } from "@/lib/email";
import type { InternetBankingHoldKeptReason } from "@/lib/email-message-notes";
import type { HoldPaymentEvidence } from "@/lib/internet-banking-hold-payment-evidence";
import logger from "@/lib/logger";
import { UNREADABLE_INVOICE_HOLD_BOUND_MS } from "@/lib/unreadable-invoice-hold-bound";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";


/**
 * Live Xero reads one run may spend on expired holds. Each read is one call per
 * invoice, and kept holds stay candidates, so without a cap K kept holds cost
 * K reads every 15 minutes against the tenant's daily limit.
 */
export const HOLD_READS_PER_RUN = 20;

const RUN_SLOT_MS = 15 * 60 * 1000;

export interface ExpiredHoldView {
  id: string;
  bookingId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  internetBankingHoldUntil: Date | null;
  booking: {
    checkIn: Date;
    checkOut: Date;
    memberId: string | null;
    member: { firstName: string; lastName: string } | null;
    organisation: { name: string; email: string | null } | null;
  };
}

export type ExpiredHoldDecision =
  | { action: "release" }
  | { action: "keep"; reason: InternetBankingHoldKeptReason }
  | { action: "release-at-bound" };

/**
 * `clubToday` is the club's calendar day as a date-only instant, comparable
 * with `booking.checkIn` (`@db.Date`).
 */
export function decideExpiredHold(
  hold: ExpiredHoldView,
  evidence: HoldPaymentEvidence,
  { now, clubToday }: { now: Date; clubToday: Date },
): ExpiredHoldDecision {
  if (evidence.kind === "paid") {
    return { action: "keep", reason: evidence.paidInFull ? "paid-in-full" : "part-paid" };
  }
  if (evidence.kind === "unreadable") {
    const holdUntil = hold.internetBankingHoldUntil ?? now;
    const boundPassed =
      // The one started-stay derivation (INV-PAY-016), never a raw Date compare.
      bookingStayHasStarted(hold.booking.checkIn, clubToday) ||
      now.getTime() >= holdUntil.getTime() + UNREADABLE_INVOICE_HOLD_BOUND_MS;
    return boundPassed ? { action: "release-at-bound" } : { action: "keep", reason: "unreadable" };
  }
  return { action: "release" };
}

/**
 * The holds this run reads, at most `cap`, rotating through the rest run by
 * run (15-minute slots) so no hold waits more than ceil(n / cap) runs. The
 * others are left for a later run: neither released nor alerted.
 */
export function selectHoldsToRead<T>(candidates: T[], now: Date, cap = HOLD_READS_PER_RUN): T[] {
  if (candidates.length <= cap) return candidates;
  const slot = Math.floor(now.getTime() / RUN_SLOT_MS);
  const start = (slot * cap) % candidates.length;
  return [...candidates, ...candidates].slice(start, start + cap);
}

/**
 * Reasons whose subject no later run selects again: the hold was released, or
 * the booking was cancelled. An undelivered alert for one of these is marked
 * OWED and drained by a later run (`drainOwedHoldAlerts`), and is audited on
 * the first attempt regardless of delivery (#3643 delta D4). Every other reason
 * belongs to a hold that stays a candidate, so its claim is given back (a send
 * that threw) or held a day (one that reached nobody), and a later run retries
 * through the ordinary path.
 */
const AFTER_COMMIT_REASONS: ReadonlySet<InternetBankingHoldKeptReason> = new Set([
  "released-unreadable",
  "cancelled-payment-recorded",
]);

const OWED_ALERT_PREFIX = "internet-banking-hold-alert-owed:";

function owedAlertKey(reason: InternetBankingHoldKeptReason, paymentId: string): string {
  return `${OWED_ALERT_PREFIX}${reason}:${paymentId}`;
}

/**
 * `send-threw` is the send failing before it reached anyone (the claim is
 * given back, as `sendAdminAlertOnceEver` does); `undelivered` is a send that
 * ran and reached nobody, which a retry every run would only repeat (F1).
 */
type HoldAlertSendOutcome = AdminAlertSendOutcome | "send-threw";

async function sendHoldAlert(
  hold: ExpiredHoldView,
  evidence: HoldPaymentEvidence,
  reason: InternetBankingHoldKeptReason,
  memberName: string,
  format: ClubFormat,
): Promise<HoldAlertSendOutcome> {
  return sendAdminInternetBankingHoldKeptAlert(
    {
      reason,
      memberName,
      bookingId: hold.bookingId,
      checkIn: hold.booking.checkIn,
      checkOut: hold.booking.checkOut,
      holdUntil: hold.internetBankingHoldUntil,
      paidCents: alertPaidCents(evidence),
      amountOwingCents: evidence.kind === "paid" ? evidence.amountDueCents : null,
      xeroInvoiceNumber: hold.xeroInvoiceNumber,
      // Cross-lane #2283: Xero deep links are BUILT, never hand-rolled.
      xeroInvoiceUrl: hold.xeroInvoiceId ? buildXeroInvoiceUrl(hold.xeroInvoiceId) : null,
    },
    format,
  ).catch((err) => {
    logger.error(
      { err, bookingId: hold.bookingId, paymentId: hold.id, reason },
      "Failed to alert admins about an Internet Banking hold",
    );
    return "send-threw" as const;
  });
}

function alertPaidCents(evidence: HoldPaymentEvidence): number | null {
  return evidence.kind === "paid" && !evidence.fromRecordedLinkOnly ? evidence.paidCents : null;
}

function readOwner(hold: ExpiredHoldView): { memberName: string; memberId: string | null } {
  try {
    const owner = bookingOwner(hold.booking);
    return {
      memberName: `${owner.member.firstName} ${owner.member.lastName}`.trim(),
      memberId: owner.memberId ?? null,
    };
  } catch (err) {
    logger.warn({ err, bookingId: hold.bookingId }, "Internet Banking hold alert has no readable owner");
    return { memberName: "unknown member", memberId: null };
  }
}

/**
 * Tell the treasurer, once per hold per reason. The claim is taken first (so
 * two instances do not both send).
 *  - A hold that stays a candidate: when the send threw, the claim is GIVEN
 *    BACK and the next run retries; when it ran and reached nobody, the claim
 *    is held for a day (`ALERT_NOBODY_ELIGIBLE_RETRY_MS`, #3635 F1). The
 *    audit entry is written once the alert settles.
 *  - A released hold or a cancelled booking (`AFTER_COMMIT_REASONS`): audited
 *    on the first attempt whatever happened, and an undelivered send is marked
 *    owed for the next run to deliver.
 * A `part-paid` hold the app cannot credit — an organisation's, or a payment
 * Xero could not size — is worded `part-paid-manual` (#3643 delta D5).
 *
 * WHY NOT `sendAdminAlertOnceEver` (#3635, decided and recorded): that helper is
 * the once-ever rule for an alert a later run re-selects, and this one differs
 * from it in four ways, each for its own reason (`INV-PAY-107`, #3643 D4):
 *  - a failed CLAIM sends anyway (`claimAlertCooldownFailOpen`), because a
 *    released hold is never selected again, where the helper skips;
 *  - nobody eligible (`no-recipients`, `skipped-by-policy`) KEEPS the claim,
 *    where the helper holds it a day and tries again;
 *  - a send that threw is given back and one that reached nobody is held a
 *    day, as in the helper (#3635 F1), but the helper cannot tell them from
 *    the four-way outcome this caller audits;
 *  - undelivered after commit is marked OWED, which the helper has no notion
 *    of: due on the next run when the send threw, a day later when it reached
 *    nobody (#3635 N1), and the caller needs the four-way outcome for the
 *    audit row's `alertDelivery`.
 * Widening the helper with three options for this one caller would give its
 * two other callers (the mid-stay joiner and started-stay hold alerts) a
 * shape neither needs, so only the claim is shared.
 */
export async function alertExpiredHold(
  hold: ExpiredHoldView,
  evidence: HoldPaymentEvidence,
  requestedReason: InternetBankingHoldKeptReason,
  format: ClubFormat,
): Promise<void> {
  const owner = readOwner(hold);
  const reason: InternetBankingHoldKeptReason =
    requestedReason === "part-paid" &&
    evidence.kind === "paid" &&
    (!owner.memberId || !evidence.cashComplete)
      ? "part-paid-manual"
      : requestedReason;
  const holdUntilLabel = hold.internetBankingHoldUntil?.toISOString() ?? "none";
  const key = `internet-banking-hold-kept:${reason}:${hold.id}:${holdUntilLabel}`;
  const context = { bookingId: hold.bookingId, paymentId: hold.id, reason };

  const claimedAt = new Date();
  const holdsClaim = await claimAlertCooldownFailOpen({
    key,
    // One alert per hold per reason per deadline (the key carries all three).
    windowMs: ALERT_ONCE_EVER_WINDOW_MS,
    now: claimedAt,
    context,
    logMessage:
      "Failed to claim the Internet Banking hold alert; sending anyway rather than staying silent about money on a held booking",
  });
  if (!holdsClaim) return;

  const sendOutcome = await sendHoldAlert(hold, evidence, reason, owner.memberName, format);
  const outcome: AdminAlertSendOutcome =
    sendOutcome === "send-threw" ? "undelivered" : sendOutcome;
  const afterCommit = AFTER_COMMIT_REASONS.has(reason);

  if (outcome === "undelivered") {
    if (!afterCommit) {
      // #3635 (F1): a send that threw is given back for the next run; one that
      // ran and reached nobody (every address suppressed, a non-production
      // withhold) is held for a day, as `sendAdminAlertOnceEver` holds it, so
      // a kept hold never costs an email attempt and a critical audit row
      // every 15 minutes.
      const settle =
        sendOutcome === "send-threw"
          ? releaseAlertCooldown({ key, claimedAt })
          : deferAlertCooldown({
              key,
              claimedAt,
              windowMs: ALERT_ONCE_EVER_WINDOW_MS,
              retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
            });
      await settle.catch((err) =>
        logger.error({ err, ...context }, "Failed to give back or defer an undelivered hold alert's claim"),
      );
      return;
    }
    await markAlertOwed({
      key: owedAlertKey(reason, hold.id),
      // #3635 (N1): a throw is transient, so it is due on the next run; a send
      // that reached nobody waits a day, as the drain's own retries do.
      due: sendOutcome === "send-threw" ? "next-run" : "after-retry",
      retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
    }).catch((err) =>
      logger.error({ err, ...context }, "Failed to mark an undelivered hold alert as owed"),
    );
  }

  const paidCents = alertPaidCents(evidence);
  const amountOwingCents = evidence.kind === "paid" ? evidence.amountDueCents : null;
  writeInternetBankingHoldAudit({
    action:
      reason === "released-unreadable"
        ? "booking.internet_banking_hold_released_unreadable"
        : reason === "cancelled-payment-recorded"
          ? "booking.internet_banking_cancelled_payment_recorded"
          : "booking.internet_banking_hold_kept",
    bookingId: hold.bookingId,
    subjectMemberId: owner.memberId,
    outcome: afterCommit ? "success" : "blocked",
    summary:
      reason === "released-unreadable"
        ? "Expired Internet Banking hold released at its bound: its invoice could not be read from Xero"
        : reason === "cancelled-payment-recorded"
          ? "Internet Banking booking cancelled as unpaid with a payment recorded to settle by hand"
          : reason === "unreadable"
            ? "Expired Internet Banking hold kept: its invoice could not be read from Xero"
            : "Expired Internet Banking hold kept: money is paid against its invoice",
    details: {
      paymentId: hold.id,
      reason,
      holdUntil: holdUntilLabel,
      paidCents,
      amountOwingCents,
      alertDelivery: outcome,
      ...(evidence.kind === "unreadable"
        ? { readFailure: evidence.reason, invoiceNotFound: evidence.notFound }
        : {}),
    },
    metadata: {
      paymentId: hold.id,
      reason,
      holdUntil: holdUntilLabel,
      paidCents,
      amountOwingCents,
    },
  });
}

/**
 * Deliver the alerts an earlier run marked owed (D4). Runs at the start of the
 * hold-expiry job, outside every transaction; never throws. The marker is
 * settled once the alert is delivered, muted by the club's rules, or has
 * nobody to go to; one that reached nobody stays owed and is tried again at
 * most once a day (#3635 F1: `listOwedAlertKeys` returns only due markers),
 * while one whose send threw stays due and is tried on the next run (N1).
 */
export async function drainOwedHoldAlerts(format: ClubFormat): Promise<void> {
  let keys: string[];
  try {
    keys = await listOwedAlertKeys({
      prefix: OWED_ALERT_PREFIX,
      retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
    });
  } catch (err) {
    logger.error({ err }, "Failed to read owed Internet Banking hold alerts");
    return;
  }
  for (const key of keys) {
    const [reason, paymentId] = key.slice(OWED_ALERT_PREFIX.length).split(":") as [
      InternetBankingHoldKeptReason,
      string,
    ];
    try {
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          booking: {
            include: { member: true, organisation: { select: { name: true, email: true } } },
          },
        },
      });
      if (!payment) {
        await settleOwedAlert({ key });
        continue;
      }
      const hold: ExpiredHoldView = { ...payment, booking: payment.booking };
      const evidence: HoldPaymentEvidence = {
        kind: "unreadable",
        readStartedAt: new Date(),
        reason: "Resent after an earlier alert could not be delivered.",
        notFound: false,
      };
      const outcome = await sendHoldAlert(hold, evidence, reason, readOwner(hold).memberName, format);
      if (outcome === "undelivered") {
        // #3635 (F1): tried and reached nobody; the next attempt is a day away.
        await noteOwedAlertAttempt({ key });
      } else if (outcome !== "send-threw") {
        await settleOwedAlert({ key });
      }
      // #3635 (N1): a send that threw is transient, so its marker is left
      // untouched and stays due for the next run.
    } catch (err) {
      logger.error({ err, key }, "Failed to deliver an owed Internet Banking hold alert");
    }
  }
}

/**
 * One unit of the club-wide daily budget for live hold reads (D9). A limiter
 * failure degrades to the limiter's own in-process fallback, never to "no
 * budget", so an outage of the counter cannot stall releases.
 */
export const HOLD_READ_DAILY_BUDGET: RateLimitConfig = {
  // One unit per expired hold read (1 + supplementary invoices calls), so the
  // job never spends more than a known share of the tenant's 5,000-a-day Xero
  // limit; the per-run cap spreads it, this bounds it. Unread holds wait.
  id: "ib-hold-xero-reads",
  limit: 400,
  windowSeconds: 24 * 60 * 60,
};

export async function takeHoldReadBudget(): Promise<boolean> {
  const result = await checkRateLimit(HOLD_READ_DAILY_BUDGET, "club");
  return result.success;
}

/**
 * The ONE audit writer for the hold-expiry job's outcomes — released, kept,
 * released at the unreadable bound. Fire-and-forget: a failed audit write is
 * logged and never fails the release or the alert that already happened.
 */
export function writeInternetBankingHoldAudit(entry: {
  action:
    | "booking.internet_banking_hold_expired"
    | "booking.internet_banking_hold_kept"
    | "booking.internet_banking_hold_released_unreadable"
    | "booking.internet_banking_cancelled_payment_recorded";
  bookingId: string;
  subjectMemberId: string | null;
  outcome: "success" | "blocked";
  summary: string;
  details: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): void {
  createAuditLog({
    action: entry.action,
    targetId: entry.bookingId,
    subjectMemberId: entry.subjectMemberId,
    entityType: "Booking",
    entityId: entry.bookingId,
    category: "payment",
    severity: "important",
    outcome: entry.outcome,
    summary: entry.summary,
    details: JSON.stringify(entry.details),
    metadata: { ...entry.metadata, paymentSource: PaymentSource.INTERNET_BANKING },
  }).catch((err) =>
    logger.error(
      { err, bookingId: entry.bookingId, action: entry.action },
      "Failed to audit an Internet Banking hold outcome",
    ),
  );
}
