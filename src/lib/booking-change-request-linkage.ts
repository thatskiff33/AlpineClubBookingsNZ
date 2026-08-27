import type { Prisma } from "@prisma/client";

import {
  calendarDateOfDateOnlyInstant,
  requireStoredCalendarDay,
} from "@/lib/club-time";
import logger from "@/lib/logger";

type LinkageDb = Pick<Prisma.TransactionClient, "bookingChangeRequest">;

/**
 * The `requestedChanges.requested` payload persisted by
 * POST /api/bookings/[id]/change-requests. Parsed defensively: rows written by
 * older code (or hand-edited) that don't fit simply never match.
 */
type RequestedChangesShape = {
  requested?: {
    checkIn?: unknown;
    checkOut?: unknown;
    addGuests?: unknown;
    guestStayRanges?: unknown;
    removeGuests?: unknown;
  };
};

function isEmptyArray(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0);
}

/**
 * True when an APPROVED change request is fulfilled by the date move the
 * admin just applied — the request asked ONLY for a date change (no guest
 * additions/removals/range edits) and every date it named equals the applied
 * value. A request the move does not actually satisfy must never be marked
 * applied: a wrong link is worse than no link.
 */
function requestFulfilledByDateMove(
  requestedChanges: unknown,
  applied: { checkIn: string; checkOut: string },
): boolean {
  const requested = (requestedChanges as RequestedChangesShape | null)
    ?.requested;
  if (!requested || typeof requested !== "object") return false;

  // Date-only requests only: a request that also asks for guest changes is at
  // most partially fulfilled by a date move.
  if (
    !isEmptyArray(requested.addGuests) ||
    !isEmptyArray(requested.guestStayRanges) ||
    !isEmptyArray(requested.removeGuests)
  ) {
    return false;
  }

  const requestedCheckIn =
    typeof requested.checkIn === "string" ? requested.checkIn : null;
  const requestedCheckOut =
    typeof requested.checkOut === "string" ? requested.checkOut : null;
  // A request naming no dates (e.g. an effective-date-only marker) is not a
  // date-move request at all.
  if (!requestedCheckIn && !requestedCheckOut) return false;

  // Every date the member named must equal what was applied; a date they left
  // unspecified is unconstrained.
  if (requestedCheckIn && requestedCheckIn !== applied.checkIn) return false;
  if (requestedCheckOut && requestedCheckOut !== applied.checkOut) return false;

  return true;
}

/**
 * Link an admin-override booking modification to the booking's most recent
 * APPROVED-but-unlinked change request THAT THE MOVE ACTUALLY FULFILS
 * (issue #1668), closing the approve → apply audit trail the change-request
 * panel exposes. Matching is semantic, not recency-only: the request must be
 * date-only and its requested dates must equal the applied dates, so an
 * unrelated override move can never mark a different ask as applied.
 *
 * Best-effort and post-transaction: a booking may have no outstanding request
 * at all, so a missing / non-matching / already-linked request is a normal
 * no-op, never a failure. Any error is logged and swallowed so it can never
 * roll back a completed date move.
 */
export async function linkModificationToOutstandingChangeRequest(
  db: LinkageDb,
  {
    bookingId,
    modificationId,
    appliedCheckIn,
    appliedCheckOut,
  }: {
    bookingId: string;
    modificationId: string;
    appliedCheckIn: Date;
    appliedCheckOut: Date;
  },
): Promise<string | null> {
  try {
    // The applied dates are stored `@db.Date` lodge nights (`Booking.checkIn` /
    // `checkOut`, `prisma/schema.prisma:1662-1663`), and the values they are
    // matched against are the `yyyy-MM-dd` strings the member submitted. A
    // calendar day takes no timezone at all, so the day is DECODED from the
    // column's UTC-midnight encoding rather than projected through one: a
    // projection reads the previous day for any club behind Greenwich and would
    // silently stop an approved date request from ever linking (#3123,
    // INV-DATE-026).
    const applied = {
      checkIn: calendarDateOfDateOnlyInstant(
        requireStoredCalendarDay(appliedCheckIn, {
          subject: "The applied check-in",
          instead: "Pass the booking's stored @db.Date checkIn.",
        }),
      ),
      checkOut: calendarDateOfDateOnlyInstant(
        requireStoredCalendarDay(appliedCheckOut, {
          subject: "The applied check-out",
          instead: "Pass the booking's stored @db.Date checkOut.",
        }),
      ),
    };

    const candidates = await db.bookingChangeRequest.findMany({
      where: {
        bookingId,
        status: "APPROVED",
        linkedModificationId: null,
      },
      orderBy: { reviewedAt: "desc" },
      select: { id: true, requestedChanges: true },
    });

    for (const candidate of candidates) {
      if (!requestFulfilledByDateMove(candidate.requestedChanges, applied)) {
        continue;
      }
      // Conditional claim: a concurrent override (or the admin's manual link
      // PATCH) may have linked this request between the find and the write —
      // never overwrite an existing linkedModificationId.
      const claim = await db.bookingChangeRequest.updateMany({
        where: { id: candidate.id, linkedModificationId: null },
        data: { linkedModificationId: modificationId },
      });
      if (claim.count === 1) return candidate.id;
      // Claimed concurrently; try the next matching candidate.
    }
    return null;
  } catch (err) {
    logger.error(
      { err, bookingId, modificationId },
      "Failed to link booking modification to approved change request",
    );
    return null;
  }
}
