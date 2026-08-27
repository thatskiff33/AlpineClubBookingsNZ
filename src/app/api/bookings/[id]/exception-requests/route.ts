import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { getDefaultLodgeId } from "@/lib/lodges";
import { isDateOnlyString } from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { checkRateLimit, getClientIp, rateLimiters } from "@/lib/rate-limit";
import { sendAdminBookingChangeRequestAlert } from "@/lib/email";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { nameField } from "@/lib/zod-helpers";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import logger from "@/lib/logger";
import {
  buildModificationProposalParties,
  createModificationExceptionRequest,
  type LiveBookingGuestInput,
} from "@/lib/booking-exception-request-service";
import { mapExceptionRequestError } from "@/lib/booking-exception-request-http";

/**
 * A guest's explicit night set (#713), mirroring `/modify`'s own field.
 *
 * REQUIRED here, not a nicety (#2562 review). The edit panel's grid mode sends
 * `guestStayRanges: [{ guestId, nights }]` and `addGuests: [{ ..., nights }]`, and
 * zod STRIPS unknown keys — so without this field every entry arrived carrying no
 * range at all, the shared resolver's global range-input mode went false, and the
 * frozen proposal was either the whole envelope for every guest (when the dates
 * moved) or byte-identical to the live booking (when they did not). Both are
 * proposals the member never made.
 */
const nightList = z
  .array(z.string().refine(isDateOnlyString, { message: "Night must be YYYY-MM-DD" }))
  .max(370);

const createSchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().trim().min(1).optional(),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        nights: nightList.optional(),
      }),
    )
    .max(200)
    .optional(),
  removeGuestIds: z.array(z.string().trim().min(1)).max(200).optional(),
  guestStayRanges: z
    .array(
      z.object({
        guestId: z.string().trim().min(1),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        nights: nightList.optional(),
      }),
    )
    .max(200)
    .optional(),
  memberMessage: z.string().max(5000),
  supersedeRequestId: z.string().trim().min(1).optional(),
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
  const actorRole = bookingManagementAuthorizationRole(session.user);
  const isAdmin = actorRole === "ADMIN";

  const rl = await checkRateLimit(
    rateLimiters.bookingChangeRequest,
    session.user.id,
  );
  if (!rl.success) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const { id: bookingId } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      // #2526: guests carry their stored explicit night set so the frozen
      // proposal preserves a sparse stay exactly as the canonical planner will,
      // instead of flattening it to its envelope and claiming beds nobody books.
      guests: { include: { nights: { select: { stayDate: true } } } },
      member: true,
      // Whether the live booking holds capacity decides the reservation footprint
      // (#2525 FIX 7); `originBookingRequest` is the #1254 converted-quote signal
      // that `bookingHoldsCapacity` reads for a PENDING booking.
      originBookingRequest: { select: { id: true } },
    },
  });
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (booking.memberId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // A policy-exception request is only meaningful for a booking a modification
  // could otherwise be applied to; defer the full hard-constraint revalidation to
  // #2525's approve-and-execute, but refuse an un-modifiable booking up front.
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: actorRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    // #3123 — the CLUB's day, from its persisted zone.
    today: await clubTodayDateOnlyInstant(),
  });
  if (!editPolicy.canModify) {
    return NextResponse.json(
      { error: editPolicy.reason ?? "This booking cannot be modified" },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const {
    checkIn,
    checkOut,
    addGuests,
    removeGuestIds,
    guestStayRanges,
    memberMessage,
    supersedeRequestId,
  } = parsed.data;

  const removeSet = new Set(removeGuestIds ?? []);
  const invalidRemoveIds = [...removeSet].filter(
    (gid) => !booking.guests.some((g) => g.id === gid),
  );
  const invalidRangeIds = (guestStayRanges ?? [])
    .map((r) => r.guestId)
    .filter((gid) => !booking.guests.some((g) => g.id === gid));
  if (invalidRemoveIds.length > 0 || invalidRangeIds.length > 0) {
    return NextResponse.json(
      { error: "One or more guests were not found on this booking" },
      { status: 400 },
    );
  }

  const liveGuests: LiveBookingGuestInput[] = booking.guests.map((g) => ({
    id: g.id,
    firstName: g.firstName,
    lastName: g.lastName,
    ageTier: g.ageTier,
    isMember: g.isMember,
    memberId: g.memberId,
    stayStart: storedDateOnly(g.stayStart),
    stayEnd: storedDateOnly(g.stayEnd),
    nights: g.nights.map((night) => ({
      stayDate: storedDateOnly(night.stayDate),
    })),
  }));

  const { base, proposed } = buildModificationProposalParties({
    bookingCheckIn: storedDateOnly(booking.checkIn),
    bookingCheckOut: storedDateOnly(booking.checkOut),
    liveGuests,
    delta: {
      checkIn,
      checkOut,
      addGuests,
      removeGuestIds,
      guestStayRanges,
    },
  });

  const effectiveLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(prisma));
  const summaryParts: string[] = [];
  if (checkIn) summaryParts.push(`check-in to ${checkIn}`);
  if (checkOut) summaryParts.push(`check-out to ${checkOut}`);
  if (addGuests?.length) summaryParts.push(`add ${addGuests.length} guest(s)`);
  if (removeSet.size) summaryParts.push(`remove ${removeSet.size} guest(s)`);
  if (guestStayRanges?.length)
    summaryParts.push(`update ${guestStayRanges.length} stay range(s)`);
  const requestedSummary = summaryParts.length
    ? summaryParts.join("; ")
    : "Booking-policy exception on modification";

  try {
    const created = await createModificationExceptionRequest({
      requestedByMemberId: session.user.id,
      bookingId,
      lodgeId: effectiveLodgeId,
      base,
      proposed,
      memberMessage,
      requestedSummary,
      // #2526: freeze the RAW delta alongside the proposal so the approval can
      // replay it against the canonical modification service. It is re-verified
      // against the proposal hash at approval time, never trusted as stored.
      delta: {
        checkIn,
        checkOut,
        addGuests,
        removeGuestIds,
        guestStayRanges,
      },
      supersedeRequestId: supersedeRequestId ?? null,
      // Drives the provisional reservation footprint (#2525 FIX 7): a non-holding
      // base (DRAFT / generic PENDING / un-held PAYMENT_PENDING / WAITLISTED /
      // BUMPED) reserves the FULL proposed footprint, a holding base only the delta.
      baseHoldsCapacity: bookingHoldsCapacity({
        status: booking.status,
        isRequestConverted: Boolean(booking.originBookingRequest),
        hasAdminCapacityHold: booking.adminCapacityHoldAt != null,
      }),
    });

    logAudit({
      action: "booking-policy-exception-request.create",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: booking.memberId,
      entityType: "BookingChangeRequest",
      entityId: created.id,
      category: "booking",
      outcome: "success",
      summary: "Modification policy exception request submitted",
      details: created.reasonCodes.join(", "),
      metadata: {
        source: "MODIFICATION",
        bookingId,
        requestId: created.id,
        proposalHash: created.proposalHash,
        reasonCodes: created.reasonCodes,
        aggregateCapacityMode: created.aggregateCapacityMode,
      },
      ipAddress: getClientIp(req),
    });

    // Post-commit, fire-and-forget: never fail the request on an alert error.
    sendAdminBookingChangeRequestAlert({
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      memberEmail: booking.member.email,
      bookingId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      requestedSummary: `Policy exception (${created.reasonCodes.join(", ")}): ${requestedSummary}`,
      reason: memberMessage,
      requestId: created.id,
    }).catch((err) =>
      logger.error(
        { err, bookingId, requestId: created.id },
        "Failed to send modification policy exception request admin alert",
      ),
    );

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return mapExceptionRequestError(error);
  }
}
