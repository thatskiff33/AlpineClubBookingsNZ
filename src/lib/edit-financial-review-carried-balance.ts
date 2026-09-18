import "server-only";

import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { formatCents } from "@/lib/utils";

/**
 * WHAT A REVIEW CHARGE ABSORBED FROM THE ASK ITS MINT RETIRED, told to a person
 * (#3371, `INV-PAY-098`).
 *
 * Minting a booking edit's charge request cancels every other live one on the
 * payment, so the new request carries whatever was still unpaid on the one it
 * superseded. The FIGURE lives on the ledger row
 * (`PaymentTransaction.carriedAskCents`); this module is the STORY, which is a
 * different job and has a different audience.
 *
 * It has its own file for the ordinary reason: `edit-financial-review-charge-request.ts`
 * was at its size ceiling, and everything here is one idea - how a carried
 * balance is described to an officer - the audit entry, and the arithmetic and
 * sentence an uncollected-share record needs. Splitting on that seam keeps both.
 *
 * WHY IT IS SAID AT ALL, when nothing is owed and nobody has to act: an officer
 * opening the earlier change finds its request gone with no explanation on it,
 * and a member sees one larger figure where they were expecting two. The rule is
 * `INV-PAY-098` and is not restated here.
 */

/**
 * WHAT THIS EDIT WAS ASKED FOR, WHAT IS STILL SHORT, AND HOW TO SAY SO.
 *
 * A shortfall measured against the whole request would understate itself by
 * exactly the carried part - the member was asked for more than this change's
 * reviews come to, and only the shares part of it answers them. The sentence is
 * empty when nothing was carried, so an ordinary record reads exactly as it did
 * before #3371.
 */
export function measureCarriedAskShortfall({
  derivedTotalCents,
  requestedTotalCents,
  carriedAskCents,
}: {
  derivedTotalCents: number;
  requestedTotalCents: number | null;
  carriedAskCents: number;
}): {
  requestedForThisEditCents: number | null;
  shortfallCents: number | null;
  carriedSentence: string;
} {
  const requestedForThisEditCents =
    requestedTotalCents === null ? null : requestedTotalCents - carriedAskCents;
  return {
    requestedForThisEditCents,
    shortfallCents:
      requestedForThisEditCents === null
        ? null
        : Math.max(derivedTotalCents - requestedForThisEditCents, 0),
    carriedSentence:
      carriedAskCents > 0
        ? ` Note that ${formatCents(requestedTotalCents ?? 0)} was asked for in total, because ${formatCents(carriedAskCents)} of an earlier change's unpaid extra was carried into this request when it was raised. That carried money is not part of this change's reviews and is not part of the amount above.`
        : "",
  };
}

/**
 * The durable, officer-findable record that this charge absorbed another
 * change's unpaid extra.
 *
 * `info` and `success`, not `important`/`failure`: nothing is owed outside the
 * system and nobody has to act, and a provenance row in the queue of things that
 * DO need acting on makes that queue less readable. Best-effort and never
 * rethrown, like every other record on this path - the request is already
 * raised, and an audit insert failing must not undo it.
 */
export async function recordCarriedEditReviewChargeBalance({
  bookingId,
  bookingModificationId,
  memberId,
  shareTotalCents,
  carriedCents,
}: {
  bookingId: string;
  bookingModificationId: string;
  memberId: string | null;
  /** This edit's own settled shares - the part that is genuinely this change's. */
  shareTotalCents: number;
  /** The other change's unpaid balance, now folded into the same request. */
  carriedCents: number;
}) {
  logger.info(
    { bookingId, bookingModificationId, shareTotalCents, carriedCents },
    "An edit-financial-review charge carried the unpaid balance of an ask its mint retired",
  );
  try {
    await createAuditLog({
      action: "booking.editFinancialReview.chargeCarriedUnpaidBalance",
      subjectMemberId: memberId,
      targetId: bookingId,
      entityType: "Booking",
      entityId: bookingId,
      category: "payment",
      severity: "info",
      outcome: "success",
      summary: `This booking change's payment request carried ${formatCents(carriedCents)} still unpaid from an earlier change`,
      details: `An admin settled a booking-change review as money the member owes the club, and the reviews for that change come to ${formatCents(shareTotalCents)}. The member already had ${formatCents(carriedCents)} outstanding from an earlier change on this booking, and raising a new request cancels the old one - so the new request asks for both together, ${formatCents(shareTotalCents + carriedCents)}. Nothing has been written off and nothing needs collecting by hand. The earlier change's own request no longer appears against it, which is expected: the money moved onto this one rather than disappearing.`,
      metadata: {
        bookingModificationId,
        shareTotalCents,
        carriedCents,
        askedTotalCents: shareTotalCents + carriedCents,
      },
    });
  } catch (err) {
    logger.error(
      { err, bookingId, bookingModificationId },
      "Failed to record the audit trace for a carried unpaid balance on an edit-financial-review charge",
    );
  }
}
