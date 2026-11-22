import type { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getDisplayedWaitlistPositions } from "@/lib/waitlist-queue";

/**
 * #5402 (`INV-CAP-041`): the booking's true place in its lodge's waitlist
 * queue, read now from the live queue rather than a number stored when it
 * joined. Null for any booking that is not `WAITLISTED`, and for a silenced one
 * ("No emails" on), which is not in the running. Read unlocked: it is display
 * only and the next render corrects a queue that moved.
 */
export async function loadBookingDetailWaitlistPosition(booking: {
  id: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  createdAt: Date;
  status: BookingStatus;
  noEmails: boolean;
}): Promise<number | null> {
  if (booking.status !== "WAITLISTED") return null;
  return (
    (await getDisplayedWaitlistPositions(prisma, [booking])).get(booking.id) ??
    null
  );
}
