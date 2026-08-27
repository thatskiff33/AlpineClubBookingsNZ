import { BookingStatus, type Prisma } from "@prisma/client";
import { isQuotePricedBooking } from "@/lib/booking-modify-validation";
import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import type { MemberGuestConsentBlockedReason } from "@/lib/member-guest-consent-service";
import {
  predictConsentDeclineRefusal,
} from "@/lib/member-guest-consent-card";
import { prisma } from "@/lib/prisma";

/**
 * The admin exception list and its two filter-chip counts ("+ Add Member
 * Guest", epic #2305, MG2 #2307, owner decisions D-15 and MG2-M-3 as ticked).
 *
 * MG2-M-3: the exception list is a FILTER on the existing Admin › Bookings
 * list, not a new page. Two chips: "Waiting for consent · N" narrows the
 * ordinary bookings table to bookings holding an unanswered request;
 * "Consent needs attention · N" swaps the table for the rows below — the
 * requests that resolved (said no, or lapsed) but whose guest could NOT be
 * removed automatically.
 *
 * EACH CHIP'S NUMBER IS THE NUMBER OF ROWS CLICKING IT REVEALS. The waiting
 * count is BOOKINGS (that is what the filtered table lists — one booking may
 * hold several pending requests); the attention count is GUEST ROWS (that is
 * what the attention table lists, one row per stuck guest).
 *
 * WHY THE "why it is stuck" COLUMN IS RE-DERIVED FROM THE LIVE BOOKING rather
 * than read from a stored reason: the blocked reason is not a column (the
 * consent model's DECLINED/EXPIRED rows carry no reason field — the audit log
 * has it, but audit entries are not operational state), and the booking may
 * have CHANGED since the block: a second guest added since the LAST_GUEST
 * refusal means the real remedy today is "just retry", not "cancel the
 * booking". Deriving from the same facts the removal service would enforce
 * NOW keeps the operator's table honest about the present, exactly as the
 * member-facing card derives its warnings.
 */

export interface MemberGuestConsentQueueCounts {
  /** Bookings holding at least one unanswered (PENDING) consent request. */
  waitingBookings: number;
  /** Stuck guest rows: resolved requests whose removal was refused (D-15). */
  attentionGuests: number;
}

/**
 * Bookings the "waiting" chip's filtered table will actually show: the same
 * baseline the bookings list applies with no explicit status filter — DRAFT
 * excluded, deleted hidden — so the chip's count and the click's result agree.
 */
const WAITING_BOOKING_WHERE: Prisma.BookingWhereInput = {
  deletedAt: null,
  status: { not: BookingStatus.DRAFT },
  guests: { some: { consentStatus: "PENDING" } },
};

/**
 * Stuck rows needing a human. A CANCELLED booking is excluded: cancelling
 * released everything the stuck row was holding, so there is nothing left to
 * fix. DRAFT is excluded to match the list baseline the chip filters.
 */
const ATTENTION_GUEST_WHERE: Prisma.BookingGuestWhereInput = {
  consentStatus: { in: ["DECLINED", "EXPIRED"] },
  booking: {
    deletedAt: null,
    status: { notIn: [BookingStatus.DRAFT, BookingStatus.CANCELLED] },
  },
};

/**
 * `waitingScope` IS WHAT MAKES THE WAITING CHIP'S NUMBER TRUE. Clicking that
 * chip does not replace the operator's filters, it STACKS with them (the chip
 * is AND-composed into the bookings query, by design), so a global count over
 * every booking in the club would promise rows that the operator's own date,
 * status, lodge or search filter is about to hide. The page therefore hands in
 * the SQL filter its current URL already applies — with the consent chips
 * themselves removed, or the waiting count would be narrowed by whichever chip
 * happens to be open — and the count is taken inside it.
 *
 * ONE CAVEAT, STATED RATHER THAN HIDDEN: three of the bookings list's filters
 * (Xero state, bed state, change state) are derived in JavaScript after the
 * query, so no `where` clause can express them. While one of those three is
 * active the waiting count is an upper bound on what the click will show. It is
 * the price of not running the whole heavy list pipeline a second time just to
 * number a chip.
 *
 * The attention count needs no scope: clicking that chip SWAPS the table for
 * the per-guest exception list, which is deliberately unfiltered — a stuck row
 * needs a human whatever the operator was looking at — so a global count is
 * exactly what the click reveals.
 */
export async function loadMemberGuestConsentQueueCounts(
  db: typeof prisma = prisma,
  options: { waitingScope?: Prisma.BookingWhereInput } = {},
): Promise<MemberGuestConsentQueueCounts> {
  const waitingWhere: Prisma.BookingWhereInput = options.waitingScope
    ? {
        AND: [
          options.waitingScope,
          { guests: { some: { consentStatus: "PENDING" } } },
        ],
      }
    : WAITING_BOOKING_WHERE;
  const [waitingBookings, attentionGuests] = await Promise.all([
    db.booking.count({ where: waitingWhere }),
    db.bookingGuest.count({ where: ATTENTION_GUEST_WHERE }),
  ]);
  return { waitingBookings, attentionGuests };
}

/**
 * What the exception list reports, which is D-15's five reasons PLUS one the
 * removal path itself can never report.
 *
 * `NO_LONGER_BLOCKED` exists because this column is re-derived from the live
 * booking (see the module docblock) and the booking moves on. A row refused as
 * LAST_GUEST whose booker has since added a second guest is not stuck any more
 * — nothing about the booking blocks the removal today. Nothing re-attempts it
 * either: the nightly sweep scans PENDING rows only, so a resolved-but-refused
 * row sits here until a human touches it. Reporting that row as `OTHER` told
 * the operator the booking "could not be repriced automatically", which was
 * simply false, and pointed them at the wrong remedy.
 */
export type LiveConsentExceptionReason =
  | MemberGuestConsentBlockedReason
  | "NO_LONGER_BLOCKED";

export interface MemberGuestConsentExceptionRow {
  bookingId: string;
  /** The stuck `BookingGuest` row's own id — the stable identity of this row. */
  guestId: string;
  lodgeName: string | null;
  checkIn: Date;
  checkOut: Date;
  bookerName: string;
  guestFirstName: string;
  guestLastName: string;
  /** "Said no" vs "lapsed, never answered". */
  status: "DECLINED" | "EXPIRED";
  /** When they said no (DECLINED) or when the request lapsed (EXPIRED). */
  statusAt: Date | null;
  reason: LiveConsentExceptionReason;
  /** The "Why it is stuck" column. */
  why: string;
  /** The "What fixes it" column — always the real remedy, never "ask the club". */
  fix: string;
}

/**
 * The two columns, per D-15's four reasons plus the two fallbacks. The
 * LAST_GUEST and QUOTE_PRICED sentences are the mockup's table copy verbatim;
 * BOOKING_STATUS, STAY_NOT_FUTURE and OTHER restate
 * `describeConsentBlockedRemedy`'s wording split into the same why/fix shape;
 * NO_LONGER_BLOCKED is composed in the same voice for the case only the live
 * re-derivation can find (see `LiveConsentExceptionReason`).
 *
 * Every pair is pinned word for word by the tests, both ways round. Two of
 * these sentences swapped would read perfectly and send an operator to
 * re-quote a booking whose real problem is its status, so "the copy is
 * present" is not a strong enough assertion to protect them.
 */
export function describeConsentExceptionColumns(params: {
  reason: LiveConsentExceptionReason;
  guestFirstName: string;
}): { why: string; fix: string } {
  const { reason, guestFirstName } = params;
  switch (reason) {
    case "LAST_GUEST":
      return {
        why: `${guestFirstName} is the only guest on this booking, so taking them off would leave it empty.`,
        fix: "Cancel the booking, or add another guest first.",
      };
    case "QUOTE_PRICED":
      return {
        why: "This booking was priced by hand, so the system will not reprice it.",
        fix: `Re-quote the request without ${guestFirstName}.`,
      };
    case "BOOKING_STATUS":
      return {
        why: "This booking's status does not allow guest changes.",
        fix: "Move it to a status that does, or cancel it.",
      };
    case "STAY_NOT_FUTURE":
      return {
        why: "This stay has already started, so the place cannot be released.",
        fix: "Check who actually arrived and adjust the booking directly.",
      };
    case "OTHER":
      return {
        why: "The booking could not be repriced automatically.",
        fix: `Open the booking and take ${guestFirstName} off through the edit flow.`,
      };
    case "NO_LONGER_BLOCKED":
      return {
        why: "Nothing is blocking this now — the booking has changed since the removal was refused.",
        fix: `Open the booking and take ${guestFirstName} off; it should go through this time.`,
      };
  }
}

/**
 * Classify why a surviving DECLINED/EXPIRED row is stuck, from the booking as
 * it stands NOW. The four predictable blockers reuse the member-card
 * prediction (same gates, same order as the removal service).
 *
 * WHEN NO PREDICTABLE BLOCKER APPLIES, `hasSettledPayment` DECIDES, and it is
 * the honest divider rather than a guess. The one refusal the prediction cannot
 * see is the settled-payment election: `removeBookingGuestInTransaction` refuses
 * when the reduction needs an explicit refund-vs-credit choice, and that
 * refusal is reachable ONLY on a booking with a captured payment — with nothing
 * captured there is nothing to elect. So a row with no predictable blocker AND
 * no captured payment is not stuck on anything at all; it is a row the booking
 * has moved past, and telling the operator it "could not be repriced
 * automatically" would be inventing a problem.
 */
export function classifyLiveConsentExceptionReason(params: {
  bookingStatus: string;
  bookingCheckIn: Date;
  bookingGuestCount: number;
  isQuotePriced: boolean;
  /** Whether the booking holds a captured payment — see above. */
  hasSettledPayment: boolean;
  today: Date;
}): LiveConsentExceptionReason {
  const { hasSettledPayment, ...prediction } = params;
  const blocker = predictConsentDeclineRefusal(prediction);
  if (blocker) return blocker;
  return hasSettledPayment ? "OTHER" : "NO_LONGER_BLOCKED";
}

/**
 * `today` is read ONCE, here, and threaded into every row's derivation — never
 * left to a default deep inside the prediction. One list must be classified
 * against one date: a sweep that straddled the club's midnight would otherwise
 * report two rows on the same booking under two different rules, and a test
 * that pins a check-in date would pass or fail depending on the day it ran.
 */
export async function listMemberGuestConsentExceptions(
  db: typeof prisma = prisma,
  options: { today?: Date } = {},
): Promise<MemberGuestConsentExceptionRow[]> {
  const today = options.today ?? (await clubTodayDateOnlyInstant());
  const rows = await db.bookingGuest.findMany({
    where: ATTENTION_GUEST_WHERE,
    orderBy: { booking: { checkIn: "asc" } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      consentStatus: true,
      consentRespondedAt: true,
      consentExpiresAt: true,
      booking: {
        select: {
          id: true,
          status: true,
          checkIn: true,
          checkOut: true,
          lodge: { select: { name: true } },
          member: { select: { firstName: true, lastName: true } },
          guests: { select: { id: true } },
          // Only to tell a genuine settled-payment refusal from a row the
          // booking has moved past — see classifyLiveConsentExceptionReason.
          payment: {
            select: {
              status: true,
              amountCents: true,
              refundedAmountCents: true,
            },
          },
        },
      },
    },
  });

  return Promise.all(
    rows.map(async (row) => {
      const status = row.consentStatus === "DECLINED" ? "DECLINED" : "EXPIRED";
      const reason = classifyLiveConsentExceptionReason({
        bookingStatus: row.booking.status,
        bookingCheckIn: row.booking.checkIn,
        bookingGuestCount: row.booking.guests.length,
        isQuotePriced: await isQuotePricedBooking(db, row.booking.id),
        hasSettledPayment: hasCapturedPayment(row.booking.payment),
        today,
      });
      const columns = describeConsentExceptionColumns({
        reason,
        guestFirstName: row.firstName,
      });
      return {
        bookingId: row.booking.id,
        guestId: row.id,
        lodgeName: row.booking.lodge?.name ?? null,
        checkIn: row.booking.checkIn,
        checkOut: row.booking.checkOut,
        bookerName:
          `${row.booking.member.firstName} ${row.booking.member.lastName}`.trim(),
        guestFirstName: row.firstName,
        guestLastName: row.lastName,
        status,
        statusAt:
          status === "DECLINED" ? row.consentRespondedAt : row.consentExpiresAt,
        reason,
        why: columns.why,
        fix: columns.fix,
      };
    }),
  );
}
