import "server-only";

import type { BookingCreditNote, BookingCreditNoteKind } from "@/lib/booking-invoice-access";
import { prisma } from "@/lib/prisma";
import { REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import { APPLIED_CREDIT_REMAINDER_NOTE_ROLE } from "@/lib/xero-applied-credit-link-roles";
import { isRefundCreditNoteLinkCancelledInXero } from "@/lib/xero-refund-note-status";

/**
 * THE BOOKING'S XERO CREDIT NOTES, from the app's own records (#5066; owner
 * decision on PR #5201, 17 Nov 2026: the booking page lists each credit note
 * raised against the booking beside its invoice, each with its own download).
 *
 * Only notes whose Xero id the app holds, found in three places:
 *
 * - `XeroObjectLink` rows of type CREDIT_NOTE anchored to the booking, its
 *   payment or one of its modifications, in a role that credits the booking:
 *   an edit's reduction (MODIFICATION_CREDIT_NOTE, allocated against the primary
 *   invoice), a refund (REFUND_CREDIT_NOTE, REFUND_REQUEST_CREDIT_NOTE), money
 *   moved to account credit (ACCOUNT_CREDIT_NOTE,
 *   MODIFICATION_ACCOUNT_CREDIT_NOTE), and the note minted for applied credit
 *   that had none (APPLIED_CREDIT_REMAINDER_NOTE);
 * - the refund-note columns `Payment.xeroRefundCreditNoteId` and
 *   `PaymentRefund.xeroRefundCreditNoteId`, which can predate their link;
 * - the booking owner's own credit notes allocated to this booking's invoice
 *   (`MemberCreditNoteAllocation`), which is how applied account credit reaches
 *   the invoice in Xero.
 *
 * Organiser-extra notes (ORGANISER_EXTRA_*) credit the organiser's extra
 * invoice, not this booking's, and are not listed.
 *
 * A note is left out when any link the app holds for it records it as voided
 * or deleted in Xero, or when every link for it is inactive (a duplicate the
 * single-note rule turned off). Reads only; never calls Xero.
 *
 * The download route serves a credit note only if its id is in this list, so
 * an id the booking does not hold is refused (`INV-SSOT`: one list for the page
 * and the route).
 */
const ROLE_KIND: Readonly<Record<string, BookingCreditNoteKind>> = {
  MODIFICATION_CREDIT_NOTE: "CHANGE",
  REFUND_CREDIT_NOTE: "REFUND",
  [REFUND_REQUEST_CREDIT_NOTE_ROLE]: "REFUND",
  ACCOUNT_CREDIT_NOTE: "ACCOUNT_CREDIT",
  MODIFICATION_ACCOUNT_CREDIT_NOTE: "ACCOUNT_CREDIT",
  [APPLIED_CREDIT_REMAINDER_NOTE_ROLE]: "CREDIT_USED",
};

type CreditNoteLink = {
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  active: boolean;
  metadata: unknown;
};

/** Pure: which candidates survive the app's own links for them, in order, once each. */
export function offeredBookingCreditNotes(
  candidates: ReadonlyArray<{ creditNoteId: string; kind: BookingCreditNoteKind }>,
  links: ReadonlyArray<CreditNoteLink>,
): BookingCreditNote[] {
  const offered: BookingCreditNote[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.creditNoteId)) continue;
    seen.add(candidate.creditNoteId);
    const own = links.filter((link) => link.xeroObjectId === candidate.creditNoteId);
    if (own.some((link) => isRefundCreditNoteLinkCancelledInXero(link.metadata))) continue;
    if (own.length > 0 && !own.some((link) => link.active)) continue;
    const creditNoteNumber = own.find((link) => link.xeroObjectNumber)?.xeroObjectNumber ?? null;
    offered.push({ creditNoteId: candidate.creditNoteId, creditNoteNumber, kind: candidate.kind });
  }
  return offered;
}

export async function readBookingCreditNotes(
  booking: { id: string; paymentId: string | null; ownerMemberId: string | null; modificationIds: readonly string[] },
  db: Pick<typeof prisma, "paymentRefund" | "payment" | "memberCreditNoteAllocation" | "xeroObjectLink"> = prisma,
): Promise<BookingCreditNote[]> {
  const { id: bookingId, paymentId, ownerMemberId, modificationIds } = booking;
  const [payment, refunds, allocations] = await Promise.all([
    paymentId ? db.payment.findUnique({ where: { id: paymentId }, select: { xeroRefundCreditNoteId: true } }) : null,
    paymentId
      ? db.paymentRefund.findMany({
          where: { paymentId, xeroRefundCreditNoteId: { not: null } },
          select: { xeroRefundCreditNoteId: true },
          orderBy: { createdAt: "asc" },
        })
      : [],
    ownerMemberId
      ? db.memberCreditNoteAllocation.findMany({
          where: { appliedToBookingId: bookingId, memberCredit: { memberId: ownerMemberId } },
          select: { xeroCreditNoteId: true },
          orderBy: { createdAt: "asc" },
        })
      : [],
  ]);
  const anchors = [
    { localModel: "Booking", localId: bookingId },
    ...(paymentId ? [{ localModel: "Payment", localId: paymentId }] : []),
    ...(modificationIds.length > 0 ? [{ localModel: "BookingModification", localId: { in: [...modificationIds] } }] : []),
  ];
  const anchored = await db.xeroObjectLink.findMany({
    where: { xeroObjectType: "CREDIT_NOTE", active: true, role: { in: Object.keys(ROLE_KIND) }, OR: anchors },
    select: { xeroObjectId: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  const candidates = [
    ...anchored.map((link) => ({ creditNoteId: link.xeroObjectId, kind: ROLE_KIND[link.role] ?? "REFUND" })),
    ...[payment?.xeroRefundCreditNoteId, ...refunds.map((refund) => refund.xeroRefundCreditNoteId)]
      .filter((id): id is string => Boolean(id))
      .map((creditNoteId) => ({ creditNoteId, kind: "REFUND" as const })),
    ...allocations.map((allocation) => ({ creditNoteId: allocation.xeroCreditNoteId, kind: "CREDIT_USED" as const })),
  ];
  if (candidates.length === 0) return [];
  const links = await db.xeroObjectLink.findMany({
    where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: { in: [...new Set(candidates.map((c) => c.creditNoteId))] } },
    select: { xeroObjectId: true, xeroObjectNumber: true, active: true, metadata: true },
  });
  return offeredBookingCreditNotes(candidates, links);
}
