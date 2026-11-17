import type { BookingChangeRequestStatus, Prisma } from "@prisma/client";

/**
 * The where-clause behind each Booking Requests queue, defined once (#4969,
 * `INV-SSOT`). The list a tab shows and the pending count that badges it
 * (`getBookingRequestPendingCounts`, read by the sidebar, the dashboard card and
 * the page's tab badges) both build their query here, so narrowing a list
 * narrows its count in the same edit. The public-request queue has the same
 * shape in `buildBookingRequestListWhere` (`booking-request.ts`).
 *
 * Pure and Prisma-client-free, so any route or service can import it.
 */

/** Approvals: bookings held for an admin review. */
export function buildBookingReviewListWhere(
  status: "PENDING" | "APPROVED" | "REJECTED" | "ALL",
): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    ...(status === "ALL"
      ? { adminReviewStatus: { not: null } }
      : { adminReviewStatus: status }),
  };
}

/**
 * Changes: locked-period change requests only. A POLICY_EXCEPTION change
 * request shares the table but is listed and decided on the Policy Exceptions
 * tab (#2524), so it is excluded here and counted there.
 */
export function buildLockedPeriodChangeRequestListWhere(
  status: BookingChangeRequestStatus | "ALL",
): Prisma.BookingChangeRequestWhereInput {
  return status === "ALL"
    ? { kind: "LOCKED_PERIOD" }
    : { kind: "LOCKED_PERIOD", status };
}

/**
 * Policy Exceptions, source one of two: requests to make a NEW booking
 * (#2526). The tab merges this with the modification source below.
 */
export function buildNewBookingExceptionQueueWhere(
  status: BookingChangeRequestStatus | "ALL",
): Prisma.NewBookingPolicyExceptionRequestWhereInput {
  return status === "ALL" ? {} : { status };
}

/**
 * Policy Exceptions, source two of two: POLICY_EXCEPTION change requests, the
 * exception requests for an existing booking's modification (#2524).
 */
export function buildModificationExceptionQueueWhere(
  status: BookingChangeRequestStatus | "ALL",
): Prisma.BookingChangeRequestWhereInput {
  return status === "ALL"
    ? { kind: "POLICY_EXCEPTION" }
    : { kind: "POLICY_EXCEPTION", status };
}
