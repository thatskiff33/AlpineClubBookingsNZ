import { prisma } from "@/lib/prisma";
import { buildBookingRequestListWhere } from "@/lib/booking-request";

/**
 * The four queues behind the Booking Requests page, one per tab (#4969), each
 * counting exactly what that tab lists. `admin-booking-requests-path.ts` maps
 * them onto the tabs.
 */
export type BookingRequestPendingCounts = {
  /** Approvals: new bookings held for an admin review. */
  bookingReviews: number;
  /**
   * Changes: locked-period change requests only. A POLICY_EXCEPTION change
   * request shares the `BookingChangeRequest` table but is listed and decided
   * on the Policy Exceptions tab (#2524), so it is counted there instead.
   */
  lockedPeriodChangeRequests: number;
  /**
   * Policy Exceptions (#2526): NEW-booking exception requests plus
   * MODIFICATION ones (POLICY_EXCEPTION change requests) — the two sources the
   * tab's unified queue merges.
   */
  policyExceptionRequests: number;
  /** Public Requests: verified non-member requests in the Queue. */
  publicBookingRequests: number;
};

/**
 * The one definition of "pending" for each Booking Requests queue, read by the
 * sidebar badges (through `getAdminPendingCounts`) and the admin dashboard card
 * alike (#4969), so neither can count a queue its own way.
 *
 * ponytail: each count mirrors the where-clause of the list its tab shows —
 * booking-reviews, booking-change-requests (LOCKED_PERIOD only),
 * `readUnifiedExceptionQueue` (both exception sources) and booking-requests
 * (QUEUE); update both together if a queue definition changes.
 */
export async function getBookingRequestPendingCounts(): Promise<BookingRequestPendingCounts> {
  const [
    bookingReviews,
    lockedPeriodChangeRequests,
    modificationPolicyExceptionRequests,
    newBookingPolicyExceptionRequests,
    publicBookingRequests,
  ] = await Promise.all([
    prisma.booking.count({
      where: { deletedAt: null, adminReviewStatus: "PENDING" },
    }),
    prisma.bookingChangeRequest.count({
      where: { kind: "LOCKED_PERIOD", status: "REQUESTED" },
    }),
    prisma.bookingChangeRequest.count({
      where: { kind: "POLICY_EXCEPTION", status: "REQUESTED" },
    }),
    prisma.newBookingPolicyExceptionRequest.count({
      where: { status: "REQUESTED" },
    }),
    prisma.bookingRequest.count({
      where: buildBookingRequestListWhere("QUEUE"),
    }),
  ]);

  return {
    bookingReviews,
    lockedPeriodChangeRequests,
    policyExceptionRequests:
      newBookingPolicyExceptionRequests + modificationPolicyExceptionRequests,
    publicBookingRequests,
  };
}
