import { BookingStatus } from "@prisma/client";
import { storedDateOnly } from "@/lib/stored-calendar-day";

/**
 * Booking statuses a linked guest may take themselves off (#2250).
 *
 * This is the single source of truth for the status half of the self-removal
 * rule. `removeBookingGuestInTransaction` (the authoritative gate in
 * `booking-guest-removal-service.ts`) imports it, and so does the advisory
 * `canSelfRemove` computed by `findBookingMemberNightConflicts` and the booking
 * detail page's affordance — so a member is never shown a control the removal
 * service would refuse, and never denied one it would allow.
 */
export const SELF_REMOVABLE_GUEST_BOOKING_STATUSES: ReadonlySet<string> =
  new Set<string>([
    BookingStatus.DRAFT,
    BookingStatus.PENDING,
    BookingStatus.PAYMENT_PENDING,
    BookingStatus.CONFIRMED,
    BookingStatus.PAID,
    BookingStatus.WAITLISTED,
    BookingStatus.WAITLIST_OFFERED,
    BookingStatus.AWAITING_REVIEW,
  ]);

/**
 * Why a linked guest may NOT take themselves off a booking. Ordered exactly as
 * `removeBookingGuestInTransaction` evaluates its gates, so the reason shown to
 * the member is the same one the server would have raised.
 */
export type GuestSelfRemovalBlocker =
  | "NOT_THEIR_OWN_GUEST"
  | "OWN_BOOKING"
  | "BOOKING_STATUS"
  | "STAY_NOT_FUTURE"
  | "LAST_GUEST"
  | "QUOTE_PRICED";

export type GuestSelfRemovalEligibility = {
  canSelfRemove: boolean;
  blocker: GuestSelfRemovalBlocker | null;
};

/**
 * The self-removal rule, evaluated server-side and shared by every surface that
 * offers (or explains the absence of) the action.
 *
 * One refusal stays server-only: a SETTLED booking whose reduction needs an
 * explicit refund-vs-account-credit election, which the owner (not a departing
 * guest) must make. Predicting it would mean knowing the price delta of
 * removing this guest, and that is the full repricing pass — season rates,
 * group discount, promo revalidation — which only runs inside the removal
 * transaction. Guessing from "has a captured payment" would hide the action
 * from members the server would in fact allow (a cancellation tier that
 * returns nothing needs no election), so the page shows the action and the
 * card surfaces the service's plain-English 400 verbatim if it is refused.
 *
 * The quote-priced refusal (`isQuotePricedBooking`) IS predictable — one
 * indexed lookup — and callers that can afford it pass `isQuotePriced`. It
 * defaults to false so the callers that cannot (the member-night guard, which
 * runs inside the booking-write transaction and must not add a per-conflict
 * query) behave exactly as before.
 */
export function evaluateGuestSelfRemoval({
  actorMemberId,
  guestMemberId,
  bookingOwnerMemberId,
  bookingStatus,
  bookingCheckIn,
  bookingGuestCount,
  isQuotePriced = false,
  today,
}: {
  actorMemberId: string;
  /** `memberId` on the guest row being removed (null for a non-member guest). */
  guestMemberId: string | null;
  bookingOwnerMemberId: string;
  bookingStatus: string;
  bookingCheckIn: Date;
  bookingGuestCount: number;
  /**
   * The booking keeps a negotiated booking-request price
   * (`isQuotePricedBooking`). Defaults to false — "not known to be quote
   * priced" — for callers that cannot afford the lookup.
   */
  isQuotePriced?: boolean;
  /**
   * The club's today, as the UTC-midnight `@db.Date` encoding
   * (`clubTodayDateOnlyInstant()` on a request, or
   * `dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()))` in a
   * module a CLI or the instrumentation graph can reach).
   *
   * REQUIRED, and that is the fix rather than an inconvenience (#3123). It used
   * to default to `getTodayDateOnly()`, which answers from the container's
   * timezone rather than the club's persisted one, so a club whose configured
   * zone differed from its deployment's judged "has the stay started yet" on the
   * wrong day — and no call site could see that it was doing so. Making it
   * required lets the typechecker enumerate every caller instead.
   */
  today: Date;
}): GuestSelfRemovalEligibility {
  // Self-removal is the path for someone ELSE's booking. An owner (and an
  // admin) edits the guest list through the full booking edit flow instead.
  if (bookingOwnerMemberId === actorMemberId) {
    return { canSelfRemove: false, blocker: "OWN_BOOKING" };
  }
  if (!guestMemberId || guestMemberId !== actorMemberId) {
    return { canSelfRemove: false, blocker: "NOT_THEIR_OWN_GUEST" };
  }
  if (!SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(bookingStatus)) {
    return { canSelfRemove: false, blocker: "BOOKING_STATUS" };
  }
  // `bookingCheckIn` is a stored `@db.Date` lodge night
  // (`prisma/schema.prisma:1662`), so it is DECODED rather than projected: a
  // calendar day takes no timezone, and projecting the UTC-midnight encoding
  // through one reads the previous day for any club behind Greenwich — which
  // would refuse self-removal a day early. `today` arrives in the same
  // UTC-midnight day encoding, so both sides of this comparison are in one
  // frame (#3123, INV-DATE-026).
  if (storedDateOnly(bookingCheckIn) <= today) {
    return { canSelfRemove: false, blocker: "STAY_NOT_FUTURE" };
  }
  if (bookingGuestCount <= 1) {
    return { canSelfRemove: false, blocker: "LAST_GUEST" };
  }
  // Last, exactly where `removeBookingGuestInTransaction` runs
  // `assertBookingNotQuotePriced` — so the reason a member is shown is the one
  // the server would actually have raised.
  if (isQuotePriced) {
    return { canSelfRemove: false, blocker: "QUOTE_PRICED" };
  }
  return { canSelfRemove: true, blocker: null };
}

/**
 * Plain-English reason a linked guest cannot take themselves off the booking
 * they are looking at, written for the member rather than the operator.
 */
export function describeGuestSelfRemovalBlocker(
  blocker: GuestSelfRemovalBlocker,
): string {
  switch (blocker) {
    case "BOOKING_STATUS":
      return "This booking is no longer in a state you can take yourself off. Ask the person who made the booking, or the club, if you need to come off it.";
    case "STAY_NOT_FUTURE":
      return "This stay starts today or has already started, so you can no longer take yourself off it here. Ask the person who made the booking, or the club, if your plans have changed.";
    case "LAST_GUEST":
      return "You are the only person on this booking, so taking yourself off would leave it empty. Ask the person who made the booking, or the club, to cancel it instead.";
    case "OWN_BOOKING":
      return "This is your own booking — edit the guest list, or cancel it, from the booking details above.";
    case "NOT_THEIR_OWN_GUEST":
      return "Only the person named on a place can take themselves off a booking.";
    case "QUOTE_PRICED":
      return "This booking was priced by the club as a quote, so its places cannot be changed here. Ask the person who made the booking, or the club, to take you off it.";
  }
}

export type BookingSelfRemovalCard = {
  /** The viewer's own `BookingGuest` row on this booking. */
  guestId: string;
  canSelfRemove: boolean;
  blockedReason: string | null;
};

/**
 * Whether the booking detail page shows the self-removal card at all, and with
 * what — the page-level gate, extracted so it is testable rather than living
 * inline in a server component nobody can render in a unit test.
 *
 * Returns null (no card, not even an explanation) for anyone the action is not
 * FOR: the booking's own owner and a full admin both edit the guest list
 * through the booking edit flow instead, a viewer with no guest row on this
 * booking has no place to give up, and a soft-deleted booking is admin-only
 * archaeology. Everyone else gets the card, with the action itself driven by
 * the shared `evaluateGuestSelfRemoval` predicate.
 */
export function resolveBookingSelfRemovalCard({
  actorMemberId,
  isBookingOwner,
  isAdminViewer,
  bookingDeletedAt,
  bookingOwnerMemberId,
  bookingStatus,
  bookingCheckIn,
  guests,
  isQuotePriced,
  today,
}: {
  actorMemberId: string;
  isBookingOwner: boolean;
  /** A full admin, who manages the guest list through the admin tooling. */
  isAdminViewer: boolean;
  bookingDeletedAt: Date | null;
  bookingOwnerMemberId: string;
  bookingStatus: string;
  bookingCheckIn: Date;
  guests: readonly { id: string; memberId: string | null }[];
  /** See `evaluateGuestSelfRemoval` — the booking detail page supplies this. */
  isQuotePriced?: boolean;
  /** The club's today. See `evaluateGuestSelfRemoval`; required for its reasons. */
  today: Date;
}): BookingSelfRemovalCard | null {
  if (isBookingOwner || isAdminViewer) return null;
  if (bookingDeletedAt) return null;
  // `guests` carries non-member rows with a null `memberId`, so an absent actor
  // id would match the first of them by equality and put somebody else's guest
  // id on the page (the action itself would still be refused).
  if (!actorMemberId) return null;

  const viewerGuest = guests.find((guest) => guest.memberId === actorMemberId);
  if (!viewerGuest) return null;

  const { canSelfRemove, blocker } = evaluateGuestSelfRemoval({
    actorMemberId,
    guestMemberId: viewerGuest.memberId,
    bookingOwnerMemberId,
    bookingStatus,
    bookingCheckIn,
    bookingGuestCount: guests.length,
    isQuotePriced: isQuotePriced ?? false,
    today,
  });

  return {
    guestId: viewerGuest.id,
    canSelfRemove,
    blockedReason: blocker ? describeGuestSelfRemovalBlocker(blocker) : null,
  };
}
