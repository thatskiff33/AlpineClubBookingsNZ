/**
 * #3643 (`INV-PAY-107`): what the hold-expiry job does with an expired hold it
 * cannot simply release, and how the treasurer hears about it.
 *
 * The owner's option A: a hold whose invoice shows any payment is kept. The
 * orchestrator's decision on the thread bounds the case option A did not name —
 * an invoice Xero cannot read (disconnected, token lapsed, the invoice gone):
 * it is kept only until the club's check-in date or seven days past the hold
 * deadline, whichever comes first, then released with a second alert. Nothing
 * is voided without a successful Xero read even then: the release only queues
 * the clearing note, and its builder reads the invoice and creates nothing when
 * the invoice owes less than the note (`xero-clearing-allocations.ts`).
 */
import { PaymentSource } from "@prisma/client";
import { claimAlertCooldown, releaseAlertCooldown } from "@/lib/alert-cooldown";
import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminInternetBankingHoldKeptAlert } from "@/lib/email";
import type { InternetBankingHoldKeptReason } from "@/lib/email-message-notes";
import type { HoldPaymentEvidence } from "@/lib/internet-banking-hold-payment-evidence";
import logger from "@/lib/logger";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";

/** The orchestrator's bound on an unreadable invoice (#3643, matches #3642). */
export const UNREADABLE_HOLD_BOUND_DAYS = 7;

/**
 * Live Xero reads one run may spend on expired holds. Each read is one call per
 * invoice, and kept holds stay candidates, so without a cap K kept holds cost
 * K reads every 15 minutes against the tenant's daily limit.
 */
export const HOLD_READS_PER_RUN = 20;

/** One alert per hold per reason, for as long as the hold (its deadline) lasts. */
const KEPT_HOLD_ALERT_WINDOW_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
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
      hold.booking.checkIn <= clubToday ||
      now.getTime() >= holdUntil.getTime() + UNREADABLE_HOLD_BOUND_DAYS * DAY_MS;
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
 * Tell the treasurer, once per hold per reason. The claim is taken first (so
 * two instances do not both send) and GIVEN BACK when recipients existed but
 * none was reached, so a failed first send is retried by the next run instead
 * of being the only notification, lost. The audit entry is written once the
 * alert is settled — delivered, muted by the club's delivery rules, or with
 * nobody to send to.
 */
export async function alertExpiredHold(
  hold: ExpiredHoldView,
  evidence: HoldPaymentEvidence,
  reason: InternetBankingHoldKeptReason,
  format: ClubFormat,
): Promise<void> {
  const holdUntil = hold.internetBankingHoldUntil ?? new Date(0);
  const key = `internet-banking-hold-kept:${reason}:${hold.id}:${holdUntil.toISOString()}`;
  const context = { bookingId: hold.bookingId, paymentId: hold.id, reason };

  const holdsClaim = await claimAlertCooldown({ key, windowMs: KEPT_HOLD_ALERT_WINDOW_MS }).catch(
    (err) => {
      logger.error(
        { err, ...context },
        "Failed to claim the Internet Banking hold alert; sending anyway rather than staying silent about money on a held booking",
      );
      return true;
    },
  );
  if (!holdsClaim) return;

  const paidCents =
    evidence.kind === "paid" && !evidence.fromRecordedLinkOnly ? evidence.paidCents : null;
  const amountOwingCents = evidence.kind === "paid" ? evidence.amountDueCents : null;
  let memberName = "unknown member";
  let subjectMemberId: string | null = null;
  try {
    const owner = bookingOwner(hold.booking);
    memberName = `${owner.member.firstName} ${owner.member.lastName}`.trim();
    subjectMemberId = owner.memberId ?? null;
  } catch (err) {
    logger.warn({ err, ...context }, "Internet Banking hold alert has no readable owner");
  }

  const outcome = await sendAdminInternetBankingHoldKeptAlert(
    {
      reason,
      memberName,
      bookingId: hold.bookingId,
      checkIn: hold.booking.checkIn,
      checkOut: hold.booking.checkOut,
      holdUntil,
      paidCents,
      amountOwingCents,
      xeroInvoiceNumber: hold.xeroInvoiceNumber,
      // Cross-lane #2283: Xero deep links are BUILT, never hand-rolled.
      xeroInvoiceUrl: hold.xeroInvoiceId ? buildXeroInvoiceUrl(hold.xeroInvoiceId) : null,
    },
    format,
  ).catch((err) => {
    logger.error({ err, ...context }, "Failed to alert admins about an Internet Banking hold");
    return "undelivered" as const;
  });

  if (outcome === "undelivered") {
    await releaseAlertCooldown({ key }).catch((err) =>
      logger.error({ err, ...context }, "Failed to give back an undelivered hold alert's claim"),
    );
    return;
  }

  writeInternetBankingHoldAudit({
    action:
      reason === "released-unreadable"
        ? "booking.internet_banking_hold_released_unreadable"
        : "booking.internet_banking_hold_kept",
    bookingId: hold.bookingId,
    subjectMemberId,
    outcome: reason === "released-unreadable" ? "success" : "blocked",
    summary:
      reason === "released-unreadable"
        ? "Expired Internet Banking hold released at its bound: its invoice could not be read from Xero"
        : reason === "unreadable"
          ? "Expired Internet Banking hold kept: its invoice could not be read from Xero"
          : "Expired Internet Banking hold kept: money is paid against its invoice",
    details: {
      paymentId: hold.id,
      reason,
      holdUntil: holdUntil.toISOString(),
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
      holdUntil: holdUntil.toISOString(),
      paidCents,
      amountOwingCents,
    },
  });
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
    | "booking.internet_banking_hold_released_unreadable";
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
