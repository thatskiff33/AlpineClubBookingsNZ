/**
 * #4316 (`INV-ADDPAY-044`): has this booking ENDED - CANCELLED or BUMPED, the
 * statuses that retire every ask on it (`isAdditionalAskRetiredBookingStatus`)?
 * Read fresh, outside any transaction, by the after-commit writers that must
 * not ask an ended booking for money: the minters' guard
 * (`ended-booking-ask-guard.ts`) and an edit review's settlement. One read, so
 * the two cannot disagree about which statuses end a booking (`INV-SSOT`). A
 * missing booking has not ended.
 */
import { isAdditionalAskRetiredBookingStatus } from "@/lib/additional-payment-chase";
import { prisma } from "@/lib/prisma";

export async function readBookingHasEnded(bookingId: string): Promise<boolean> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { status: true } });
  return isAdditionalAskRetiredBookingStatus(booking?.status);
}
