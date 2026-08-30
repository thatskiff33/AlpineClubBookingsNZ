import "server-only";

import { ManualRefundTaskKind, ManualRefundTaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * #3033 (epic #2797): which bookings currently have money held for review.
 *
 * The one read behind every surface that has to say "this booking's stay change
 * saved, but its adjustment is still being worked out" — the member's booking
 * detail banner, the My Bookings row qualifier, and the admin booking tools
 * warning. One module so those three cannot drift into disagreeing about what
 * "pending review" means, which on a money claim is the difference between
 * reassuring a member and misleading them (`INV-SSOT`).
 *
 * ## Scoped by BOOKING, not by payment
 *
 * Reused reasoning, not re-derived: the finance-evidence diagnostics blocker
 * (`diagnostics/tools/packs/finance-evidence.ts`) already counts OPEN manual
 * tasks by booking rather than by payment, because owner decision D2 makes
 * `paymentId` optional and a review raised for an unpriceable edit can be
 * credit-only. A payment-scoped lookup would miss precisely the tasks this
 * feature creates.
 *
 * ## Narrower than that blocker in one respect, deliberately
 *
 * The blocker counts EVERY OPEN task, because any of them means the booking's
 * finance state is unsettled. These readers ask a narrower question, and the
 * answer reaches a member: only an `EDIT_FINANCIAL_REVIEW` task means "your
 * change saved and the adjustment is being worked out". A cash hand-back on a
 * cancelled booking is a different situation with its own wording elsewhere, and
 * telling a member their booking change is under review because of one would be
 * false.
 */
const OPEN_FINANCIAL_REVIEW = {
  kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
  status: ManualRefundTaskStatus.OPEN,
} as const;

/**
 * Which of these bookings have an OPEN financial review, as a set.
 *
 * Batched because the caller is a list: My Bookings renders every booking a
 * member is on, and asking per row would be one query per card. An empty input
 * issues no query at all rather than a `WHERE id IN ()`.
 *
 * `distinct` on the booking rather than a `groupBy` count: the callers need
 * membership of the set, never how many tasks a booking has, and a booking can
 * legitimately hold more than one review from separate edits.
 */
export async function bookingsWithOpenFinancialReview(
  bookingIds: readonly string[],
): Promise<Set<string>> {
  if (bookingIds.length === 0) return new Set();

  const rows = await prisma.manualRefundTask.findMany({
    where: { ...OPEN_FINANCIAL_REVIEW, bookingId: { in: [...bookingIds] } },
    select: { bookingId: true },
    distinct: ["bookingId"],
  });

  return new Set(rows.map((row) => row.bookingId));
}

/**
 * Whether one booking has an OPEN financial review.
 *
 * Routed through the batched read above so there is one query shape and one
 * definition of what counts, rather than a second `where` that agrees today.
 */
export async function bookingHasOpenFinancialReview(
  bookingId: string,
): Promise<boolean> {
  const withReview = await bookingsWithOpenFinancialReview([bookingId]);
  return withReview.has(bookingId);
}
