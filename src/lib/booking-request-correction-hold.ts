/**
 * THE BEDS A CORRECTED REQUEST WAS HOLDING (#2936, MAD epic #2725).
 *
 * The other half of `booking-request-corrections.ts`, and a separate module
 * because it is a separate concern with a separate lock story. That file owns
 * one short transaction that claims the request row under the global key. This
 * one runs AFTER that transaction has committed, takes no lock of its own, and
 * hands the work to `cancelBooking` — which takes the global key and opens
 * transactions of its own, so calling it from inside the claim would
 * self-deadlock.
 *
 * `declineBookingRequest` composes the identical pair (claim the request, then
 * release the hold outside) and this follows it deliberately, including the
 * order of the member-guest read: the people the hold told they were on a lodge
 * booking are collected while that booking still describes them.
 *
 * WHY A CORRECTION RELEASES RATHER THAN MOVES THE HOLD. A hold is a whole
 * `AWAITING_REVIEW` booking built out of the request — its nights, its guest
 * rows, its owner's name and email address, its priced split. Every corrected
 * field except the catering preference feeds one of those, so a moved hold
 * would have to be rebuilt from scratch anyway, and rebuilding it inside a
 * correction would mean re-running capacity, the person-night guard and the
 * hosting reconcile in a path that is not a booking writer. Releasing is the
 * honest answer: the officer re-holds, or simply re-sends a quote, and the
 * existing hold path does all of that with the corrected data.
 */

import { BookingStatus } from "@prisma/client";

import {
  collectNotifiedMemberGuestIds,
  notifyMemberGuestsHoldReleased,
} from "@/lib/booking-request-shared";
import { cancelBooking } from "@/lib/booking-cancel";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/** How the request's capacity hold ended up. */
export type CorrectionHoldOutcome =
  | "none"
  | "released"
  | "detachedStalePointer"
  | "keptCateringOnly";

/**
 * The correction COMMITTED but something after the claim did not.
 *
 * Separate from `BookingRequestError` because the caller must not retry: the
 * request is already corrected, and a retry would refuse on the bumped version
 * anyway. The usual case is a hold over the old shape, still pointed at by the
 * request and still carrying its own Release button — but every post-claim
 * failure wears this shape, because every one of them leaves a saved
 * correction, and telling the officer it failed is what makes them re-type it.
 *
 * `cause` is carried rather than dropped so
 * `isHostingCoverageParticipantRetry` can still see the participant fence
 * through the wrapper, exactly as `BookingRequestDeclineCommittedError` does.
 */
export class BookingRequestCorrectionCommittedError extends Error {
  status: number;
  holdReleasePending: boolean;

  constructor(
    message: string,
    status: number,
    holdReleasePending: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BookingRequestCorrectionCommittedError";
    this.status = status;
    this.holdReleasePending = holdReleasePending;
  }
}

/**
 * Release the beds a corrected request was holding for its old shape.
 *
 * Runs AFTER the claim committed and outside every transaction, because
 * `cancelBooking` takes the global key and opens transactions of its own. The
 * shape is `declineBookingRequest`'s, including the order of the member-guest
 * read: the people the hold told they were on a lodge booking are collected
 * while that booking still describes them.
 */
export async function reconcileCorrectedRequestHold(params: {
  requestId: string;
  heldBookingId: string | null;
  holdAffecting: boolean;
  adminMemberId: string;
  ipAddress: string;
}): Promise<CorrectionHoldOutcome> {
  if (!params.heldBookingId) return "none";
  if (!params.holdAffecting) return "keptCateringOnly";

  const held = await prisma.booking.findUnique({
    where: { id: params.heldBookingId },
    select: { id: true, status: true },
  });
  if (!held || held.status !== BookingStatus.AWAITING_REVIEW) {
    // The pointer is stale — the hold was cancelled from the bed board, or a
    // sweep took it. Detach it so the corrected request stops claiming beds
    // nothing reserves, which is the same repair the Release-hold route makes.
    await prisma.bookingRequest.updateMany({
      where: { id: params.requestId, heldBookingId: params.heldBookingId },
      data: { heldBookingId: null, version: { increment: 1 } },
    });
    return "detachedStalePointer";
  }

  const notifiedMemberGuestIds = await collectNotifiedMemberGuestIds(
    prisma,
    params.heldBookingId,
  );
  const result = await cancelBooking(
    params.heldBookingId,
    params.adminMemberId,
    "ADMIN",
    params.ipAddress,
    "card",
    {
      // An officer correcting a request, not the requester cancelling a
      // booking: the requester hears about this when the corrected quote
      // arrives, not as a cancellation notice for beds they never knew about.
      suppressCustomerNotification: true,
      // A requester accept can convert this hold to a live PENDING booking
      // between the claim above and here. The opt-in guard makes the shared
      // cancel path refuse rather than clobber it.
      requireRequestHold: true,
    },
  );

  if (result.status === 409) {
    throw new BookingRequestCorrectionCommittedError(
      "The correction was saved, but this request's held beds could not be released — the hold may have just been accepted. Open the request and check it before quoting again.",
      409,
      false,
    );
  }
  if (result.status !== 200) {
    logger.error(
      {
        requestId: params.requestId,
        bookingId: params.heldBookingId,
        error: "error" in result ? result.error : undefined,
      },
      "Failed to release booking-request hold during correction",
    );
    throw new BookingRequestCorrectionCommittedError(
      "The correction was saved, but this request's held beds could not be released. Release the hold from the request before quoting again.",
      result.status >= 400 ? result.status : 500,
      true,
    );
  }

  await notifyMemberGuestsHoldReleased({
    bookingId: params.heldBookingId,
    targetMemberIds: notifiedMemberGuestIds,
    logContext: { bookingRequestId: params.requestId },
  });
  return "released";
}
