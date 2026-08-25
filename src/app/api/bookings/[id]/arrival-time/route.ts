import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import {
  calendarDateOfDateOnlyInstant,
  compareCalendarDates,
} from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { hasAdminAccess } from "@/lib/access-roles";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { ARRIVAL_TIME_ERROR_MESSAGE, ARRIVAL_TIME_PATTERN } from "@/lib/arrival-time";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";

// #2621 — WHY THERE IS NO ADVISORY LOCK ON THIS ROUTE.
//
// Every other write on a booking that this route's neighbours perform takes the
// per-booking advisory lock, because those writes read state, decide something
// from it, and write a derived result — so two concurrent requests can compute
// from the same stale read and both be wrong. This route does none of that. It
// writes ONE scalar column to a value supplied whole by the caller, and that
// column is display-only information (owner decision, 8 Aug): it gates no
// capacity, no money, no chore assignment and no state machine. Two admins
// setting a time at the same instant should end with one of the two times, and
// last-write-wins gives exactly that. A lock here would buy a stricter ordering
// nobody can observe, at the cost of taking the booking's lock — and blocking a
// payment or a modification behind it — for a field that decides nothing.
//
// The pre-write guards (status, check-in date) are read outside the update and
// so are advisory rather than atomic. That is the pre-existing shape and it is
// tolerable for the same reason: the worst outcome of losing that race is an
// arrival time recorded on a booking that was cancelled a millisecond ago,
// which displays nowhere because every reader filters on status.
//
// WHAT IS ATOMIC, AND WHY THAT IS ENOUGH. The AUDIT PAIR is. The row this route
// writes says "X → Y", and the only way to be sure X is the value Y actually
// replaced is to read it in the same transaction as the write — otherwise two
// admins saving at the same instant both read the pre-existing value and both
// record it as the "old", so the audit log claims a change that never happened
// and loses one that did. So the previous value is re-read inside a short
// interactive `$transaction` alongside the update. That is a row-level ordering
// on ONE row for the duration of one scalar write, not the booking's advisory
// lock: it cannot block a payment or a modification, and last-write-wins on the
// field itself is unchanged — the two admins still end with one of the two
// times, and now the audit trail says truthfully which order they landed in.

// #2621: the accepted-value rule is `ARRIVAL_TIME_PATTERN`, imported rather
// than re-spelled here. The literal that used to live on this line read
// `[0-5]0` and so accepted :10/:20/:40/:50 while the message beside it promised
// 30-minute increments.
const arrivalTimeSchema = z.object({
  expectedArrivalTime: z
    .string()
    .regex(ARRIVAL_TIME_PATTERN, ARRIVAL_TIME_ERROR_MESSAGE),
});

/**
 * #2674 — a soft-deleted booking is not a booking this route will write to.
 *
 * WHAT THIS DOES AND DOES NOT FIX, stated plainly because the issue that filed
 * it assumed more than was true. It does NOT close a live hole: `deletedAt` has
 * exactly one writer in the repo, `softDeleteCancelledBooking`
 * (`src/lib/booking-delete.ts`), which refuses anything whose status is not
 * `CANCELLED`, and nothing anywhere transitions a booking back out of
 * `CANCELLED`. So every soft-deleted booking is a cancelled one, and the status
 * gate below already answered these requests — with `400 Cannot update arrival
 * time for cancelled or completed bookings`, before the transaction. No write
 * landed and no audit row was written.
 *
 * What it fixes is the ANSWER and the contract. A record the club considers
 * gone should read as gone, not as "cancelled": `page.tsx` will not show it,
 * and the two neighbours that already carry this guard —
 * `send-guest-payment-link` and `additional-payment-secret` — both answer 404.
 * And it stops the route's correctness resting on a coincidence: today the
 * status gate covers it, but that gate is about status, and a future change to
 * either rule would silently uncover the write.
 *
 * PLACED AFTER THE AUTHORISATION CHECK, and BEFORE the status gate. After the
 * 403, because checking deletion first would hand a caller with no claim on the
 * booking a deleted-or-live oracle — the reasoning `requested-room/options`
 * (#2673) wrote down and this follows. Before the status gate, because
 * otherwise the 400 answers first and the deleted booking never reaches this at
 * all, which is precisely the state being corrected.
 *
 * NO FULL ADMIN EXEMPTION, unlike `bookings/[id]/page.tsx`. That exemption
 * exists because the page is a record-VIEWING surface where an admin has a
 * legitimate reason to inspect a deleted booking. This is a write.
 */
function refuseDeletedBooking(booking: { deletedAt: Date | null }) {
  if (!booking.deletedAt) return null;
  return NextResponse.json({ error: "Booking not found" }, { status: 404 });
}

/**
 * PUT /api/bookings/[id]/arrival-time
 * Set or update the expected arrival time on a booking.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    // The permission and eligibility guards only. The value being replaced is
    // NOT read here: an audit row that says "changed" has to say what it changed
    // from, and the only reading of that which cannot go stale is the one taken
    // inside the write below.
    select: {
      memberId: true,
      checkIn: true,
      status: true,
      // #2674: see `refuseDeletedBooking` below.
      deletedAt: true,
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Only booking owner or admin can update
  // Issue #1313 (option A2): owner, Full Admin, or Booking Officer
  // (bookings:edit) may set/clear the expected arrival time on any booking.
  if (
    booking.memberId !== session.user.id &&
    !hasAdminAccess(session.user) &&
    !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const deleted = refuseDeletedBooking(booking);
  if (deleted) return deleted;

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return NextResponse.json(
      { error: "Cannot update arrival time for cancelled or completed bookings" },
      { status: 400 }
    );
  }

  // Cannot update after check-in date has passed
  /*
    CT-4 (#2870). Two temporal concepts, and the old spelling took both from the
    environment. "Today" IS a zone question: the persisted `ClubTimeSettings`
    zone answers it (INV-CONFIG-002, INV-DATE-019). `booking.checkIn` is NOT —
    it is `@db.Date`, a calendar day encoded as UTC midnight, so it is decoded
    in UTC (INV-DATE-019's first boundary with INV-DATE-026, not INV-DATE-010,
    #3080). Projecting it, as the old helper did, is the identity in New Zealand
    and the PREVIOUS day for a club behind UTC, so the editor locked a day early.
  */
  const today = (await clubTime()).today();
  const checkInDay = calendarDateOfDateOnlyInstant(booking.checkIn);
  if (compareCalendarDates(checkInDay, today) < 0) {
    return NextResponse.json(
      { error: "Cannot update arrival time after check-in date has passed" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = arrivalTimeSchema.safeParse(body);
  if (!parsed.success) {
    // #2621: this used to answer a refused time with the bare word "Invalid
    // input" and bury `ARRIVAL_TIME_ERROR_MESSAGE` in `details`, which no caller
    // reads — and the editor renders `error` verbatim, so a member who typed a
    // time on the quarter hour was told "Invalid input" and never learned that
    // the field takes the hour or half hour. The schema already carries the
    // truthful sentence; surface it. A malformed or missing field falls back to
    // zod's own message for that shape rather than to a time-format sentence
    // that would not describe the real problem.
    const flattened = parsed.error.flatten();
    const message =
      flattened.fieldErrors.expectedArrivalTime?.[0] ??
      flattened.formErrors[0] ??
      ARRIVAL_TIME_ERROR_MESSAGE;
    return NextResponse.json({ error: message, details: flattened }, { status: 400 });
  }

  // The audit pair, read where it cannot go stale — see the transaction note in
  // the header comment. `previous` is what this write really replaced.
  const { previous, updated } = await prisma.$transaction(async (tx) => {
    const current = await tx.booking.findUnique({
      where: { id },
      select: { expectedArrivalTime: true },
    });
    const written = await tx.booking.update({
      where: { id },
      data: { expectedArrivalTime: parsed.data.expectedArrivalTime },
      select: { id: true, expectedArrivalTime: true },
    });
    return { previous: current?.expectedArrivalTime ?? null, updated: written };
  });

  // #2621: this route wrote to a booking and recorded nothing. It is reachable
  // by a Booking Officer on ANY member's booking (#1313 option A2), so a member
  // seeing a time they did not set had no way to find out who set it.
  //
  // ACTOR VERSUS SUBJECT. `memberId` is who pressed the button; `subjectMemberId`
  // is the booking's OWNER, which is the member the row is about and the one an
  // operator filtering by "Subject" is looking for. `onBehalf` then names the
  // AUTHORITY used, because the two ids alone do not distinguish "the owner
  // edited their own booking" from "an officer edited it for them" without the
  // reader comparing them — the same modelling `members/[id]/photo` already uses
  // for the identical owner-or-admin pair, so this is the house form rather than
  // a new one. `previous` may be null: that is the first-ever set, and it is a
  // fact worth recording.
  //
  // Written after the transaction commits, deliberately: `logAudit` is
  // fire-and-forget, and a durable "changed" claim must never be able to survive
  // a rolled-back write.
  logAudit({
    action: "booking.expected_arrival_time.set",
    memberId: session.user.id,
    targetId: id,
    subjectMemberId: booking.memberId,
    entityType: "Booking",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary: "Expected arrival time set",
    details: `${previous ?? "(not set)"} → ${updated.expectedArrivalTime}`,
    metadata: {
      bookingId: id,
      previousExpectedArrivalTime: previous,
      newExpectedArrivalTime: updated.expectedArrivalTime,
      onBehalf: booking.memberId !== session.user.id,
    },
    ipAddress: getClientIp(req),
  });

  return NextResponse.json(updated);
}

/**
 * DELETE /api/bookings/[id]/arrival-time
 * Clear the expected arrival time.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    // Guards only; the cleared value is read inside the write, so the audit row
    // names the value this request really removed.
    select: {
      memberId: true,
      checkIn: true,
      status: true,
      // #2674: see `refuseDeletedBooking` above. The clear needs it as much as
      // the set — it DESTROYS the previous value, so it is the half where a
      // write on a record the club considers gone would be least recoverable.
      deletedAt: true,
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Issue #1313 (option A2): owner, Full Admin, or Booking Officer
  // (bookings:edit) may set/clear the expected arrival time on any booking.
  if (
    booking.memberId !== session.user.id &&
    !hasAdminAccess(session.user) &&
    !hasAdminAreaAccess(session.user, { area: "bookings", level: "edit" })
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const deleted = refuseDeletedBooking(booking);
  if (deleted) return deleted;

  if (booking.status === "CANCELLED" || booking.status === "COMPLETED") {
    return NextResponse.json(
      { error: "Cannot update arrival time for cancelled or completed bookings" },
      { status: 400 }
    );
  }

  // Same two concepts as the set path above: the stored check-in day is decoded
  // in UTC, "today" comes from the persisted club zone (CT-4, #2870).
  const today = (await clubTime()).today();
  const checkInDay = calendarDateOfDateOnlyInstant(booking.checkIn);
  if (compareCalendarDates(checkInDay, today) < 0) {
    return NextResponse.json(
      { error: "Cannot update arrival time after check-in date has passed" },
      { status: 400 }
    );
  }

  // Same reasoning as the set: the value being cleared is read inside the write
  // so the recorded "old" is the one this clear really removed, not whatever a
  // concurrent request saw a moment earlier.
  const { previous, updated } = await prisma.$transaction(async (tx) => {
    const current = await tx.booking.findUnique({
      where: { id },
      select: { expectedArrivalTime: true },
    });
    const written = await tx.booking.update({
      where: { id },
      data: { expectedArrivalTime: null },
      select: { id: true, expectedArrivalTime: true },
    });
    return { previous: current?.expectedArrivalTime ?? null, updated: written };
  });

  // #2621: a clear is recorded on the same terms as a set — the same action
  // family and the same metadata keys, so one query over
  // `booking.expected_arrival_time.*` returns the whole history of the field on a
  // booking rather than only the halves that added a value.
  //
  // The clear is the more consequential of the two, because it DESTROYS the
  // previous value: after this commits, `previousExpectedArrivalTime` on this row
  // is the only surviving record that a time was ever set, and the only place to
  // learn what it was. That is why the value is captured transactionally rather
  // than from the guard read above — see the header note.
  logAudit({
    action: "booking.expected_arrival_time.cleared",
    memberId: session.user.id,
    targetId: id,
    subjectMemberId: booking.memberId,
    entityType: "Booking",
    entityId: id,
    category: "booking",
    outcome: "success",
    summary: "Expected arrival time cleared",
    details: `${previous ?? "(not set)"} → (not set)`,
    metadata: {
      bookingId: id,
      previousExpectedArrivalTime: previous,
      newExpectedArrivalTime: null,
      onBehalf: booking.memberId !== session.user.id,
    },
    ipAddress: getClientIp(req),
  });

  return NextResponse.json(updated);
}
