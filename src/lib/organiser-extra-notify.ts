/**
 * #4299 (`INV-PAY-142`, decision 2): TELL THE GROUP ORGANISER ABOUT THEIR
 * EXTRA INVOICE - once per change, after the invoice is in Xero so the email
 * carries its number.
 *
 * At most once: the row's `organiserNotifiedAt` is claimed with a guarded write
 * BEFORE the send (claim before the side effect), so a retried or replayed
 * invoice run never emails twice. A send that then fails is logged and not
 * retried - the invoice itself is the organiser's record, and Xero holds it.
 * The organiser booking's "No emails" switch withholds it, as it does every
 * organiser-scoped email (`booking-email-suppression.ts`).
 */
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { sendGroupOrganiserExtraInvoiceEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/** The change, in a few plain words, for the organiser's email. */
export function organiserExtraChangeSummary(modificationType: string): string {
  switch (modificationType) {
    case "GUEST_ADD":
      return "Guests added";
    case "GUEST_REMOVE":
      return "Guests removed";
    case "DATE_CHANGE":
    case "EXTEND_STAY":
      return "Dates changed";
    default:
      return "Booking changed";
  }
}

export async function notifyOrganiserOfExtraInvoice(organiserExtraInvoiceId: string, format: ClubFormat): Promise<boolean> {
  const extra = await prisma.organiserExtraInvoice.findUnique({
    where: { id: organiserExtraInvoiceId },
    select: {
      id: true,
      bookingId: true,
      billedCents: true,
      xeroInvoiceNumber: true,
      xeroInvoiceId: true,
      combinedInvoiceNumber: true,
      organiserNotifiedAt: true,
      groupSettlementId: true,
      bookingModification: { select: { modificationType: true } },
    },
  });
  if (!extra || extra.organiserNotifiedAt || !extra.xeroInvoiceId) return false;

  const [joiner, settlement] = await Promise.all([
    prisma.booking.findUnique({
      where: { id: extra.bookingId },
      select: { id: true, memberId: true, checkIn: true, checkOut: true, member: { select: { firstName: true, lastName: true, email: true } }, organisation: { select: { name: true, email: true } } },
    }),
    prisma.groupBookingSettlement.findUnique({
      where: { id: extra.groupSettlementId },
      select: { groupBooking: { select: { organiserBookingId: true } } },
    }),
  ]);
  if (!joiner || !settlement) return false;
  const organiserBooking = await prisma.booking.findUnique({
    where: { id: settlement.groupBooking.organiserBookingId },
    select: { id: true, memberId: true, member: { select: { id: true, firstName: true, lastName: true, email: true } }, organisation: { select: { name: true, email: true } } },
  });
  if (!organiserBooking) return false;
  const organiser = bookingOwner(organiserBooking);
  if (!organiser.member.email) return false;

  // The claim: whichever run writes it first sends; every other run sends nothing.
  const claimed = await prisma.organiserExtraInvoice.updateMany({
    where: { id: extra.id, organiserNotifiedAt: null },
    data: { organiserNotifiedAt: new Date() },
  });
  if (claimed.count !== 1) return false;

  const joinerOwner = bookingOwner(joiner);
  try {
    await sendGroupOrganiserExtraInvoiceEmail(
      {
        bookingContext: { bookingId: organiserBooking.id, recipientMemberId: organiser.memberId ?? null },
        email: organiser.member.email,
        firstName: organiser.member.firstName,
        joinerName: `${joinerOwner.member.firstName} ${joinerOwner.member.lastName}`.trim(),
        amountCents: extra.billedCents,
        invoiceNumber: extra.xeroInvoiceNumber ?? extra.xeroInvoiceId,
        combinedInvoiceNumber: extra.combinedInvoiceNumber,
        changeSummary: organiserExtraChangeSummary(extra.bookingModification.modificationType),
        checkIn: joiner.checkIn,
        checkOut: joiner.checkOut,
      },
      format,
    );
  } catch (err) {
    logger.error({ err, organiserExtraInvoiceId: extra.id }, "Failed to send the group organiser's extra invoice email (#4299); not retried, the invoice is in Xero");
    return false;
  }
  return true;
}
