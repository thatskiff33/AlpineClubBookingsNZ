import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { bookingOwner } from "@/lib/booking-owner";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  changeRequestAddGuestsSchema,
  changeRequestValidationMessage,
} from "@/lib/booking-change-request-guests";
import {
  changeRequestDeltaSchema,
  mergeChangeRequestGuests,
  unknownChangeRequestGuestRefusal,
  validateChangeRequestDatesAndNights,
} from "@/lib/booking-change-request-input";
import { estimateChangeRequestAddedGuests } from "@/lib/booking-change-request-estimate";
import { checkRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * #4030 Part A: the price estimate an in-progress stay's change-request card
 * shows for the guests the member is asking to add, before they send it.
 *
 * Side-effect free: nothing is written and no provider is contacted. Authorised
 * exactly as the request itself is (the booking's owner, or a Booking Officer).
 * Member guests are listed but never priced here — see
 * `booking-change-request-estimate.ts` for why that is a privacy boundary, not a
 * gap.
 */
const estimateSchema = z.object({
  // Only the card guests are priced; the full proposal is validated below.
  addGuests: changeRequestAddGuestsSchema.nonempty(),
  editorChanges: changeRequestDeltaSchema.optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;
  const isAdmin = bookingManagementAuthorizationRole(session.user) === "ADMIN";

  const { id: bookingId } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      memberId: true,
      deletedAt: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      guests: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          stayStart: true,
          stayEnd: true,
          ageTier: true,
          isMember: true,
          nights: { select: { stayDate: true } },
        },
      },
    },
  });
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // `INV-ADDPAY-031`: a deleted booking answers with the ordinary not-found
  // body, AFTER the authorisation check, so a caller with no claim gets 403
  // either way and this is never a deleted-or-live oracle.
  if (booking.deletedAt) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  // #4030 review S1: the card re-asks as the list changes, so the estimate is
  // throttled on the booking-quote budget (`bookingQuery`, the one the booking
  // quote route spends), not on the change request's own five-a-day limiter.
  // It is keyed on the caller, so nobody spends another member's budget, and it
  // runs after the owner check, so a refused caller spends none.
  const rl = await checkRateLimit(rateLimiters.bookingQuery, session.user.id);
  if (!rl.success) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = estimateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: changeRequestValidationMessage(parsed.error), details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // INV-REQ-011: judge the same merged date/night proposal submission receives,
  // including editor guests which affect range mode, but never price them here.
  const proposal = changeRequestDeltaSchema.safeParse(
    mergeChangeRequestGuests(parsed.data.editorChanges ?? {}, parsed.data.addGuests),
  );
  if (!proposal.success) {
    return NextResponse.json(
      { error: changeRequestValidationMessage(proposal.error), details: proposal.error.flatten() },
      { status: 400 },
    );
  }
  const validated = validateChangeRequestDatesAndNights(booking, proposal.data);
  if (validated.error !== undefined) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  // #4203: the editor's removals and ranges name guests of THIS booking only,
  // as submission requires, before they shape the party the estimate counts.
  const unknownGuest = unknownChangeRequestGuestRefusal(booking.guests, proposal.data);
  if (unknownGuest) {
    return NextResponse.json({ error: unknownGuest }, { status: 400 });
  }

  // The card's guests are priced inside the whole proposed party (#4203);
  // everyone else is counted, never priced.
  const estimate = await estimateChangeRequestAddedGuests(
    booking,
    parsed.data.addGuests,
    parsed.data.editorChanges,
  );
  return NextResponse.json({ estimate });
}
