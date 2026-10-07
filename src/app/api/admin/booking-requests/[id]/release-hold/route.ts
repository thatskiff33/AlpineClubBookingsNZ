import { NextRequest, NextResponse } from "next/server";
import { hostingCoverageParticipantRetryResponse } from "@/lib/adult-member-hosting-retry-response";
import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { cancelBooking } from "@/lib/booking-cancel";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { clubFormatValues } from "@/lib/club-format-server";

// Release the capacity hold placed on a booking request at quote-send/hold
// (#1280) so an admin can re-map or re-hold it (issue #1255 residual risk:
// "held + create-new can't be re-mapped without releasing the hold"). This
// REUSES the shared held-booking cancel path (`cancelBooking`) rather than
// duplicating cancel logic: cancelling the AWAITING_REVIEW held booking detaches
// `heldBookingId`, frees the bed rows/capacity, and audits the cancellation.
// After release the request has no held booking, so the contact picker becomes
// editable again.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;
  // The club's format (#3565), resolved once, before any transaction or
  // lock below — never per amount and never inside a transaction.
  const format = await clubFormatValues();

  const request = await prisma.bookingRequest.findUnique({
    where: { id },
    select: { id: true, heldBookingId: true },
  });
  if (!request) {
    return NextResponse.json({ error: "Booking request not found" }, { status: 404 });
  }
  if (!request.heldBookingId) {
    // Safe no-op: there is nothing to release.
    return NextResponse.json(
      { error: "This booking request has no held slots to release" },
      { status: 400 }
    );
  }

  // Precondition guard against racing the requester's accept: only release while
  // the hold is still AWAITING_REVIEW. Once accepted it converts to PENDING (and
  // CANCELLABLE_BOOKING_STATUSES includes PENDING), so without this check the
  // shared cancel path would cancel a just-accepted booking.
  const held = await prisma.booking.findUnique({
    where: { id: request.heldBookingId },
    select: { id: true, status: true },
  });
  if (!held) {
    // The pointer is stale (booking already cancelled elsewhere). Detach it so
    // the picker re-enables, and report success — the hold is effectively gone.
    await prisma.bookingRequest.updateMany({
      where: { id, heldBookingId: request.heldBookingId },
      data: { heldBookingId: null, version: { increment: 1 } },
    });
    return NextResponse.json({ ok: true, alreadyReleased: true });
  }
  if (held.status !== BookingStatus.AWAITING_REVIEW) {
    return NextResponse.json(
      {
        error:
          "This hold can no longer be released (it may already have been accepted). Refresh and try again.",
      },
      { status: 409 }
    );
  }

  let result;
  try {
    result = await cancelBooking(
      request.heldBookingId,
      session.user.id,
      "ADMIN",
      getClientIp(req),
      format,
      "card",
      {
      // #1255 RR-2: suppress the requester's "booking cancelled" email — this is
      // an admin releasing a hold to re-map, not the requester cancelling. The
      // detach/reconcile/audit in the shared cancel path still run.
      suppressCustomerNotification: true,
      // #1406: this path releases a hold it expects to still be AWAITING_REVIEW.
      // The pre-check above (held.status guard) already 409s a just-accepted
      // hold, but pass the opt-in guard so the shared cancel path itself refuses
      // (409, no side effect) rather than clobbering a booking a concurrent
      // quote-accept flipped to PENDING between that read and cancelBooking's
      // own outer read.
        requireRequestHold: true,
      },
    );
  } catch (err) {
    const hostingRetry = hostingCoverageParticipantRetryResponse(err);
    if (hostingRetry) return hostingRetry;
    throw err;
  }

  // A concurrent cancel/accept won the race (#1160 single-flight): surface the
  // 409 rather than a 500 — the hold is being/has been released either way.
  if (result.status === 409) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }
  if ("error" in result) {
    logger.error(
      { requestId: id, bookingId: request.heldBookingId, error: result.error },
      "Failed to release booking-request hold"
    );
    return NextResponse.json(
      { error: "Could not release the hold", details: result.error },
      { status: result.status >= 400 ? result.status : 500 }
    );
  }

  // #1255 RR-1 (Option B): the requester's quote link is intentionally NOT
  // revoked here, so they can still accept the (now-released) quote. Surface the
  // caveat so the admin re-sends a fresh quote after re-mapping.
  return NextResponse.json({
    ok: true,
    quoteLinkStillActive: true,
    caveat:
      "The requester's existing quote link is still active. Re-send a fresh quote after re-mapping the owner.",
  });
}
