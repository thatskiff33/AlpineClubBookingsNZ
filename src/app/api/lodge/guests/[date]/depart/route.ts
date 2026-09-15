import { NextRequest, NextResponse } from "next/server";
import { bookingOwner } from "@/lib/booking-owner";
import { checkLodgeAuth, getLodgeAuthActorMemberId, kioskLodgeAuthErrorResponse, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { findLodgeGuestDepartingOnDate } from "@/lib/lodge-date-scoping";
import { getNextGuestBedNightAfter } from "@/lib/booking-guest-stay-ranges";
import { parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { logAudit, getAuditRequestContext } from "@/lib/audit";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { lockRosterDates } from "@/lib/roster-lock";
import { acquireLodgeCapacityLock } from "@/lib/capacity";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bodySchema = z.object({
  bookingGuestId: z.string().min(1),
});

/**
 * PUT /api/lodge/guests/[date]/depart
 * Mark a guest as departed (sets departedAt timestamp).
 * Sending again toggles off (clears departedAt).
 * Requires tier >= lodge (staying-guest cannot mark departures).
 *
 * ONE ATTENDANCE PAIR PER STAY, NOT A LOG (#2628). `departedAt` means "this
 * person has left and has not come back", not "these are the check-outs that
 * happened". A sparse stay leaves once per SEGMENT and the endpoint now accepts
 * every one of them, so the pair is kept honest from the other side: marking the
 * RETURN arrival clears the superseded departure (see the arrive route), which
 * is what leaves this toggle free to record the next check-out. Skip the return
 * arrival and the row still reads "Departed" on the later morning — pressing the
 * button clears that stale state first and a second press records the real
 * departure. Nothing is lost, because there was only ever one state to hold.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const authResult = await checkLodgeAuth(dateStr, { request: req });
  const { error, status, tier } = authResult;
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  // Staying guests cannot mark departures
  if (tier === "staying-guest") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }
  const date = parseDateOnly(dateStr);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const lodgeId = await resolveKioskLodgeId(authResult, prisma);
    const updateResult = await prisma.$transaction(async (tx) => {
      // Consent decline/expiry already uses global -> lodge before it changes
      // this BookingGuest and removes chore rows. Join that order before the
      // roster keys so departure cannot hold roster while waiting on the same
      // guest tuple in the opposite direction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(tx, lodgeId);
      const guest = await findLodgeGuestDepartingOnDate(
        parsed.data.bookingGuestId,
        date,
        lodgeId,
        tx,
      );
      if (!guest) return { notFound: true as const };

      // Toggle from the post-lock row, never from the pre-transaction display.
      const departedAt = guest.departedAt ? null : new Date();
      // THE SWEEP IS BOUNDED BY THE SEGMENT, NOT BY "AFTER TODAY" (#2628).
      // Checking a guest out clears the suggested chores they can no longer do.
      // Until this issue the endpoint only ever accepted the morning after the
      // LAST booked night, so "everything after today" WAS "the rest of this
      // segment" and the unbounded sweep was correct. It is not correct now: a
      // guest booked on nights {11, 14} who checks out on the 12th is back on
      // the 14th, and an unbounded sweep would silently delete the roster
      // somebody generated for their second segment. Stop at the next night
      // they hold a bed for; a final departure has none and sweeps everything
      // after it, exactly as before. CONFIRMED rows are never touched either
      // way — only a roster nobody has confirmed yet.
      const nextBookedNight = getNextGuestBedNightAfter(
        guest,
        date,
        guest.booking,
      );
      const sweptDates = nextBookedNight
        ? { gt: date, lt: nextBookedNight }
        : { gt: date };
      const futureSuggested = departedAt
        ? await tx.choreAssignment.findMany({
            where: {
              bookingGuestId: parsed.data.bookingGuestId,
              date: sweptDates,
              status: "SUGGESTED",
              booking: lodgeNullTolerantScope(lodgeId),
              choreTemplate: lodgeNullTolerantScope(lodgeId),
            },
            select: { date: true },
          })
        : [];
      await lockRosterDates(tx, futureSuggested.map((assignment) => assignment.date));
      await tx.bookingGuest.update({
        where: { id: parsed.data.bookingGuestId },
        data: { departedAt },
      });

      if (departedAt) {
        await tx.choreAssignment.deleteMany({
          where: {
            bookingGuestId: parsed.data.bookingGuestId,
            date: sweptDates,
            status: "SUGGESTED",
            booking: lodgeNullTolerantScope(lodgeId),
            choreTemplate: lodgeNullTolerantScope(lodgeId),
          },
        });
      }
      return { guest, departedAt };
    });

    if ("notFound" in updateResult) {
      return NextResponse.json(
        { error: "Guest not found for this date" },
        { status: 404 }
      );
    }
    const { guest, departedAt } = updateResult;

    const actorMemberId = getLodgeAuthActorMemberId(authResult);
    const auditRequest = getAuditRequestContext(req);
    const markedDeparted = Boolean(departedAt);
    logAudit({
      action: markedDeparted
        ? "lodge.guest.departed"
        : "lodge.guest.departure_cleared",
      memberId: actorMemberId,
      targetId: guest.id,
      subjectMemberId: guest.memberId ?? bookingOwner(guest.booking).memberId,
      entityType: "BookingGuest",
      entityId: guest.id,
      category: "lodge",
      severity: "important",
      outcome: "success",
      summary: markedDeparted
        ? "Guest marked departed"
        : "Guest departure cleared",
      details: `${markedDeparted ? "Marked guest departed" : "Cleared guest departure"} for ${dateStr}`,
      metadata: {
        date: dateStr,
        tier,
        bookingId: guest.bookingId,
        bookingGuestId: guest.id,
        bookingMemberId: bookingOwner(guest.booking).memberId,
        guestMemberId: guest.memberId,
        guestName: `${guest.firstName} ${guest.lastName}`,
      },
      ipAddress: auditRequest?.ipAddress,
      requestId: auditRequest?.id,
      userAgent: auditRequest?.userAgent,
    });

    return NextResponse.json({ success: true, departedAt: departedAt?.toISOString() ?? null });
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    logger.error({ err }, "Error marking guest departure");
    return NextResponse.json({ error: "Failed to update guest" }, { status: 500 });
  }
}
