import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { sendAdminRefundRequestAlert } from "@/lib/email";
import { getRemainingRefundableCents } from "@/lib/booking-payment-state";
import { hasAdminAccess } from "@/lib/access-roles";
import { deletedBookingRefusalResponse } from "@/lib/deleted-booking-refusal";
import { formatCents } from "@/lib/utils";

const createSchema = z.object({
  reason: z.string().min(10).max(2000),
  requestedAmountCents: z.number().int().min(1).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const { id: bookingId } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && !hasAdminAccess(session.user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // #2674: a SOFT-DELETED booking is NOT FOUND here, for every caller.
  //
  // WHY THIS ROUTE, AND NOT THE ONE THE ISSUE WAS FILED ABOUT. #2674 came in
  // against the arrival-time write, but that handler already refuses a deleted
  // booking as a side effect of a gate it has for another reason: its status
  // check admits only bookings that are still live. `Booking.deletedAt` has
  // exactly ONE writer — `softDeleteCancelledBooking` in
  // `src/lib/booking-delete.ts` — which refuses anything that is not already
  // CANCELLED and never clears the column, and nothing in the codebase moves a
  // booking back OUT of CANCELLED. A soft-deleted booking is therefore
  // CANCELLED, permanently. Most of the write surface under this route folder
  // inherits a free refusal from that fact.
  //
  // THIS ROUTE INVERTS IT, and that asymmetry is the whole finding. Its status
  // gate immediately below is not a block, it is a REQUIREMENT: it demands
  // `status === "CANCELLED"` and 400s everything else. So the one status a
  // soft-deleted booking is guaranteed to carry is precisely the status this
  // handler is looking for, and the appeal sailed straight through by
  // construction — creating a RefundRequest row, a `refund-request.create`
  // audit entry and an admin alert email about a booking the club has deleted
  // from its own records. Nothing on the path read `deletedAt` at all.
  //
  // AND IT IS PRODUCIBLE, not merely reachable on paper. Soft-delete is blocked
  // when money history exists, but the two sides count DIFFERENT tables:
  // `getCancelledBookingDeleteBlockers` (booking-delete.ts) counts the
  // PaymentTransaction LEDGER, while `getRemainingRefundableCents`
  // (booking-payment-state.ts) reads the Payment MIRROR — SUCCEEDED or
  // PARTIALLY_REFUNDED with a positive amount. A legacy mirror-only payment,
  // a shape booking-cancel.ts explicitly acknowledges ("no ledger row for the
  // outstanding intent (legacy mirror-only payment)"), satisfies both at once:
  // deletable by the ledger's reckoning, still refundable by the mirror's. The
  // ORDER is the other half of it — that same blocker list refuses a delete
  // while a RefundRequest exists, so appeal-then-delete is already covered and
  // delete-then-appeal is exactly the hole that check cannot close. This guard
  // closes it from the other end.
  //
  // 404 FOR EVERY ROLE, INCLUDING A FULL ADMIN. `bookings/[id]/page.tsx`
  // exempts admins (`booking.deletedAt && !isAdmin`) because a page is a
  // record-VIEWING surface and an officer has a real reason to read a deleted
  // booking. This is a write, and no downstream surface can act on the row it
  // would create, so nobody of any role should be able to create it. Same shape
  // as the sibling writes `send-guest-payment-link` and
  // `requested-room/options` (#2673).
  //
  // AFTER the authorisation check, deliberately. Checked first it would answer
  // 404 for a deleted booking and 403 for a live one, handing a caller with no
  // claim on the booking a deleted-or-live oracle. This way an unauthorised
  // caller gets 403 either way, and only someone entitled to the booking learns
  // its state.
  //
  // No select change was needed: the read above uses `include`, so the whole
  // booking row — `deletedAt` with it — is already in hand.
  if (booking.deletedAt) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Only cancelled bookings with partial or zero refund are eligible
  if (booking.status !== "CANCELLED") {
    return NextResponse.json(
      { error: "Refund appeals are only available for cancelled bookings" },
      { status: 400 }
    );
  }

  if (!booking.payment || booking.payment.status === "REFUNDED") {
    return NextResponse.json(
      { error: "This booking already received a full refund" },
      { status: 400 }
    );
  }

  // Check for existing pending request
  const existingRequest = await prisma.refundRequest.findFirst({
    where: { bookingId, status: "PENDING" },
  });

  if (existingRequest) {
    return NextResponse.json(
      { error: "A refund appeal is already pending for this booking" },
      { status: 400 }
    );
  }

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { reason, requestedAmountCents } = parsed.data;

  const maxRefundable = getRemainingRefundableCents(booking.payment);
  if (maxRefundable <= 0) {
    return NextResponse.json(
      { error: "No successful payment was captured for this booking" },
      { status: 400 }
    );
  }

  if (requestedAmountCents && requestedAmountCents > maxRefundable) {
    return NextResponse.json(
      {
        error: `Requested amount exceeds maximum refundable amount of ${formatCents(maxRefundable)}`,
      },
      { status: 400 }
    );
  }

  const refundRequest = await prisma.refundRequest.create({
    data: {
      bookingId,
      memberId: session.user.id,
      reason,
      requestedAmountCents: requestedAmountCents ?? null,
    },
  });

  logAudit({
    action: "refund-request.create",
    memberId: session.user.id,
    targetId: bookingId,
    subjectMemberId: booking.memberId,
    entityType: "RefundRequest",
    entityId: refundRequest.id,
    category: "payment",
    outcome: "success",
    summary: "Refund appeal submitted",
    details: `Refund appeal submitted${requestedAmountCents ? ` for ${formatCents(requestedAmountCents)}` : ""}`,
    metadata: {
      bookingId,
      requestedAmountCents: requestedAmountCents ?? null,
      maxRefundableCents: maxRefundable,
    },
    ipAddress: req.headers.get("x-forwarded-for") ?? "unknown",
  });

  // Notify admins
  sendAdminRefundRequestAlert({
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    bookingId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    reason,
    requestedAmountCents: requestedAmountCents ?? null,
    paidAmountCents: booking.payment.amountCents,
    refundedAmountCents: booking.payment.refundedAmountCents,
  }).catch(() => {});

  return NextResponse.json(refundRequest, { status: 201 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const { id: bookingId } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    // #2700: `deletedAt` selected beside the authority field, the way
    // `requested-room/options` does it (`INV-ADDPAY-031`). The POST above reads
    // the booking with `include` and already had it; this read did not, which is
    // how the GET stayed unguarded while its own POST was closed in #2674.
    select: { memberId: true, deletedAt: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && !hasAdminAccess(session.user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The rule is `INV-ADDPAY-034`; `INV-ADDPAY-033`, which tracked this as an
  // open decision, is now a superseded stub pointing there. Note the POST above
  // deliberately keeps `INV-ADDPAY-031`'s byte-identical body while this GET
  // carries the shared sentence — both are correct, and the difference is
  // asserted in this route's deleted-booking test rather than accidental.
  //
  // #2700 — one of the two reads `INV-ADDPAY-033` tracked: it served a deleted
  // booking's own refund appeals to its owner, while the booking page that links
  // here refuses the record outright. Owner decision, 10 Aug 2026: refuse, with
  // the SAME sentence the consent write uses rather than a bare 404, so a member
  // following a stale link is told what happened.
  //
  // AFTER the 403 above, deliberately: a caller with no claim on the booking
  // gets the same answer whether it is deleted or live, so this discloses
  // nothing to anyone not already entitled to read it.
  //
  // No UI regression: `RefundAppealButton` — the only client of this endpoint —
  // is rendered on `bookings/[id]/page.tsx` behind `!isDeleted`, so it never
  // mounts against a deleted booking for any role, Full Admin included.
  if (booking.deletedAt) {
    return deletedBookingRefusalResponse();
  }

  const requests = await prisma.refundRequest.findMany({
    where: { bookingId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(requests);
}
