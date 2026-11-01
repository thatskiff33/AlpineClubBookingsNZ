import "server-only";

import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * A REQUEST FOR CREDIT USED ELSEWHERE THAT THE APP HAS STOPPED CHASING ON ITS OWN (#4253 release
 * 2, `INV-ADDPAY-051`), told to the officers once.
 *
 * The request itself stays where officers already look for unpaid money - the unsettled-stays
 * card, the sidebar badge and the bookings-list filter read every owed request - so nothing new is
 * built. What those queues cannot say is WHY the member is not being reminded or asked, so one
 * audit row on the booking says it, in the audit log officers already read:
 *
 * - `waiting-on-edit-request`: a release landed on a booking whose unpaid edit request is still
 *   open; it is asked for once that request is paid or withdrawn.
 * - `invoice-part-paid`: Xero shows the booking's invoice open but owing less than the released
 *   credit the request asks for (a bank transfer that paid part of it, say), so the automatic
 *   reminder is withheld rather than asking the member to pay by card what may already be paid.
 * - `invoice-not-open`: Xero shows the invoice paid, voided or not yet approved, so nothing can be
 *   paid against it as it stands.
 * - `request-unmatched`: the request could not be matched to the booking's invoice at all - no
 *   invoice in Xero, Xero answering that it has no such invoice or giving no amount due, or a
 *   request whose ledger rows could not all be read.
 *
 * Written once per `key` (the recovery row, or the live request's card payment), so a cron that
 * meets the same request every pass adds nothing. The read and the write are not one transaction:
 * two passes racing could write two rows, which says the same thing twice and moves no money.
 */
/** Why a released-credit REMINDER was withheld (`credit-release-reminder-gate.ts`). */
export type CreditReleaseWithheldReason = "invoice-part-paid" | "invoice-not-open" | "request-unmatched";
export type CreditReleaseOfficerSignalReason = "waiting-on-edit-request" | CreditReleaseWithheldReason;

const ACTION = "payment.credit_release_ask.left_to_officers";

/**
 * THE ONE SOURCE of each reason's words: the audit note's summary and, for a withheld reminder,
 * what an officer's re-send is refused with (`creditReleaseResendRefusal`).
 */
const SUMMARY: Record<CreditReleaseOfficerSignalReason, string> = {
  "waiting-on-edit-request":
    "Credit used in Xero was not asked for yet: an unpaid request for a booking change is open, and the released credit will be asked for once it is paid or withdrawn",
  "invoice-part-paid":
    "The automatic reminder for credit used in Xero was withheld: Xero shows the booking's invoice owing less than the request asks for (part may have been paid by bank transfer), so an officer should check it",
  "invoice-not-open":
    "The automatic reminder for credit used in Xero was withheld: Xero shows the booking's invoice paid, voided or not yet approved, so an officer should check it",
  "request-unmatched":
    "The automatic reminder for credit used in Xero was withheld: the request could not be matched to the booking's invoice in Xero, so an officer should check it",
};

const RESEND_REFUSAL: Record<CreditReleaseWithheldReason, string> = {
  "invoice-part-paid":
    "Xero shows this booking's invoice owing less than the credit this request asks for (part of it may have been paid by bank transfer), so nothing was sent. Check the invoice in Xero before asking the member again.",
  "invoice-not-open":
    "Xero shows this booking's invoice paid, voided or not yet approved, so nothing was sent. Check the invoice in Xero before asking the member again.",
  "request-unmatched":
    "This request could not be matched to the booking's invoice in Xero (the invoice is missing there, or Xero gave no amount owing), so nothing was sent. Check the booking's invoice in Xero first.",
};

/** What an officer's re-send of a withheld released-credit request is refused with. */
export function creditReleaseResendRefusal(reason: CreditReleaseWithheldReason): string {
  return RESEND_REFUSAL[reason];
}

export async function signalCreditReleaseToOfficers(params: {
  bookingId: string;
  reason: CreditReleaseOfficerSignalReason;
  /** What makes this the same signal again: written once per key. */
  key: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const already = await prisma.auditLog.findFirst({
      where: { action: ACTION, targetId: params.bookingId, metadata: { path: ["key"], equals: params.key } },
      select: { id: true },
    });
    if (already) return false;
    await createAuditLog({
      action: ACTION,
      targetId: params.bookingId,
      entityType: "Booking",
      entityId: params.bookingId,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary: SUMMARY[params.reason],
      details: params.reason,
      metadata: { key: params.key, reason: params.reason, ...params.metadata },
    });
    return true;
  } catch (err) {
    // The request is still on the officers' queues either way; a lost note is logged, never thrown,
    // so the caller's own wait or withhold always happens.
    logger.error({ err, bookingId: params.bookingId, reason: params.reason }, "Could not record why a credit-release request was left to the officers");
    return false;
  }
}
