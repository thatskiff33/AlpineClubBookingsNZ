import { prisma } from "@/lib/prisma";
import { buildBookingRequestListWhere } from "@/lib/booking-request";
import {
  buildBookingReviewListWhere,
  buildLockedPeriodChangeRequestListWhere,
  buildModificationExceptionQueueWhere,
  buildNewBookingExceptionQueueWhere,
} from "@/lib/booking-request-queue-where";

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
 * Each count builds its query from the same where-builder the list its tab
 * shows uses (`booking-request-queue-where.ts` for booking-reviews,
 * booking-change-requests and `readUnifiedExceptionQueue`;
 * `buildBookingRequestListWhere` for booking-requests), so a list and its badge
 * cannot be narrowed apart.
 */
export async function getBookingRequestPendingCounts(): Promise<BookingRequestPendingCounts> {
  const [
    bookingReviews,
    lockedPeriodChangeRequests,
    modificationPolicyExceptionRequests,
    newBookingPolicyExceptionRequests,
    publicBookingRequests,
  ] = await Promise.all([
    prisma.booking.count({ where: buildBookingReviewListWhere("PENDING") }),
    prisma.bookingChangeRequest.count({
      where: buildLockedPeriodChangeRequestListWhere("REQUESTED"),
    }),
    prisma.bookingChangeRequest.count({
      where: buildModificationExceptionQueueWhere("REQUESTED"),
    }),
    prisma.newBookingPolicyExceptionRequest.count({
      where: buildNewBookingExceptionQueueWhere("REQUESTED"),
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
