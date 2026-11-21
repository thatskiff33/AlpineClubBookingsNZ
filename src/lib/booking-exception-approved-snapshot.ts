import type { Prisma } from "@prisma/client";
import { readBookingCashCover } from "@/lib/booking-cash-evidence";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import { prisma } from "@/lib/prisma";
import { withReadOnlySnapshot } from "@/lib/read-only-snapshot";

/** The created booking, as the approval email addresses and describes it. */
export function readApprovedBookingEmailDetails(tx: Pick<Prisma.TransactionClient, "booking">, bookingId: string) {
  return tx.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      status: true,
      // `bookingHoldsCapacity`'s other two inputs (#1254, #1764).
      adminCapacityHoldAt: true,
      originBookingRequest: { select: { id: true } },
      member: { select: { id: true, email: true, firstName: true } },
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
      guests: { select: { id: true } },
    },
  });
}

/**
 * #4069: the created booking, what its cash covers and whether its beds are
 * held, all from ONE read-only snapshot, so the amount and the held-bed
 * sentence cannot describe two different moments. The beds are held exactly
 * when `bookingHoldsCapacity` says so: an exclusive whole-lodge hold can only
 * be set on a booking that already holds (the exclusive-hold route refuses
 * otherwise), so its flag adds nothing, and one left behind by a released
 * admin hold must not claim beds the booking does not hold.
 */
export async function readApprovedBookingSnapshot(bookingId: string) {
  return withReadOnlySnapshot(
    prisma,
    async (tx) => {
      const booking = await readApprovedBookingEmailDetails(tx, bookingId);
      if (!booking) return undefined;
      return {
        booking,
        cover: await readBookingCashCover(tx, bookingId),
        bedsHeld: bookingHoldsCapacity({
          status: booking.status,
          isRequestConverted: booking.originBookingRequest !== null,
          hasAdminCapacityHold: booking.adminCapacityHoldAt !== null,
        }),
      };
    },
    // Post-commit, so wait for a connection rather than lose the email.
    { maxWait: 10_000, timeout: 10_000 },
  );
}

