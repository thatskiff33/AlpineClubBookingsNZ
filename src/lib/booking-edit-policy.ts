import { BookingStatus } from "@prisma/client";
import { addDaysDateOnly } from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";

const MEMBER_FUTURE_EDIT_STATUSES = new Set<string>([
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  // #2266: a member may edit their OWN draft. The dashboard's Resume button has
  // always landed on the booking page, but the page offered a plain member no
  // Edit button at all — the reporter only reached the editor because they were
  // an admin. A draft edit moves no money and claims no capacity: it has no
  // change fee (calculateModificationChangeFee), writes no hold dates
  // (applyLifecycleTransitions), and has no settlement — confirm-draft / the
  // pay step enforce capacity and holds when the draft becomes real. A member
  // draft edit still gets the same over-capacity CHECK the wizard applies
  // before saving a draft (#1767), because member edits do not skip the
  // lifecycle machinery the way admin edits of non-lifecycle statuses do.
  BookingStatus.DRAFT,
]);

const ADMIN_FUTURE_EDIT_STATUSES = new Set<string>([
  ...MEMBER_FUTURE_EDIT_STATUSES,
  BookingStatus.WAITLISTED,
  BookingStatus.WAITLIST_OFFERED,
  BookingStatus.BUMPED,
]);

const IN_PROGRESS_EDIT_STATUSES = new Set<string>([
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
]);

type BookingEditMode = "future" | "in-progress" | "admin-override";

export interface BookingEditPolicy {
  canModify: boolean;
  mode: BookingEditMode | null;
  today: Date;
  editableFrom: Date | null;
  checkInEditable: boolean;
  reason: string | null;
}

export interface BookingEditPolicyInput {
  status: string;
  role: string;
  checkIn: Date;
  checkOut: Date;
  // Admin-only escape hatch (issue #1668): when an admin (Full Admin or Booking
  // Officer) explicitly requests an override, the date-window locks (in-progress
  // check-in lock, fully-past refusal) are lifted so they can move any booking's
  // dates. Ignored for non-admin roles — they fall through to the normal
  // branches, so member/officer-without-bookings:edit output is byte-for-byte
  // unchanged whether or not this flag is set.
  adminOverride?: boolean;
  /**
   * The club's TODAY, as the UTC-midnight instant a `@db.Date` round-trips
   * through. REQUIRED since #3123 — see {@link getBookingEditPolicy}.
   */
  today: Date;
}

function isAdmin(role: string) {
  return role === "ADMIN";
}

function isFutureEditStatusAllowed(status: string, role: string): boolean {
  return isAdmin(role)
    ? ADMIN_FUTURE_EDIT_STATUSES.has(status)
    : MEMBER_FUTURE_EDIT_STATUSES.has(status);
}

function isInProgressEditStatusAllowed(status: string): boolean {
  return IN_PROGRESS_EDIT_STATUSES.has(status);
}

/**
 * Classify what may be edited on a booking, and from which date.
 *
 * `input.today` is the CLUB's day, from its persisted `ClubTimeSettings.timeZone`
 * (`INV-CONFIG-002`), and it is REQUIRED (#3123).
 *
 * It used to be read here from the zone-defaulting `date-only` helper, whose
 * default is `APP_TIME_ZONE` —
 * `TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"` (`src/config/operational.ts`) —
 * so with `NEXT_PUBLIC_TZ=America/Denver` in a UTC container, the exact
 * deployment shape epic #2988 exists for, this was Denver's day, and with
 * neither variable set it was Auckland's whatever the host was.
 *
 * The previous version of this comment said the plumbing to fix that was CT-6's
 * (#2991). It is this issue's, and it is a THREADED REQUIRED PARAMETER rather
 * than an `await` in here, deliberately: this function is synchronous and pure,
 * it is called from eleven places including inside a `prisma.$transaction` (the
 * guest-removal service) where an uncached `ClubTimeSettings` read would take a
 * second pooled connection under held locks, and two of its callers invoke it
 * TWICE and must get one answer both times. Making it `async` would have
 * infected all eleven and bought nothing.
 *
 * `checkIn`/`checkOut` are stored `@db.Date` CALENDAR DAYS and take no zone at
 * all — they are decoded zone-free through `storedDateOnly` (`INV-DATE-026`).
 * `today` is the other side of those comparisons and must arrive on the same
 * UTC-midnight frame, which is what every caller's `clubTodayDateOnlyInstant()`
 * or `dateOnlyInstantOf(clubToday(zone))` produces.
 */
export function getBookingEditPolicy(
  input: BookingEditPolicyInput
): BookingEditPolicy {
  const today = input.today;
  const tomorrow = addDaysDateOnly(today, 1);
  const checkIn = storedDateOnly(input.checkIn);
  const checkOut = storedDateOnly(input.checkOut);

  // Admin override (issue #1668): lift the date-window locks entirely. Status
  // eligibility is still enforced (canModifyBookingStatusForRole); only the
  // in-progress/fully-past date gates are bypassed. Non-admin roles skip this
  // branch and fall through unchanged.
  if (input.adminOverride && isAdmin(input.role)) {
    const canModify = canModifyBookingStatusForRole(input.status, input.role);
    return {
      canModify,
      mode: canModify ? "admin-override" : null,
      today,
      editableFrom: null,
      checkInEditable: canModify,
      reason: canModify
        ? null
        : "This booking cannot be modified in its current status",
    };
  }

  if (checkIn > today) {
    const canModify = isFutureEditStatusAllowed(input.status, input.role);
    return {
      canModify,
      mode: canModify ? "future" : null,
      today,
      editableFrom: checkIn,
      checkInEditable: canModify,
      reason: canModify
        ? null
        : "This booking cannot be modified in its current status",
    };
  }

  // In-progress window (issue #2029): a stay is still amendable/extendable
  // through the ENTIRE check-out day (NZ), not just up to it. `checkOut` is the
  // departure date, so guests can be at the lodge on the morning of `checkOut`
  // and must be able to extend then — the booking also stays PAID that whole
  // day (the completion cron only flips once `checkOut < today`). The window is
  // therefore `checkIn <= today <= checkOut`. `editableFrom` stays `tomorrow`:
  // an extension moves check-out forward (new check-out >= tomorrow adds the
  // check-out-day night and beyond), while today and earlier remain locked.
  if (checkIn <= today && checkOut >= today) {
    const canModify = isInProgressEditStatusAllowed(input.status);
    return {
      canModify,
      mode: canModify ? "in-progress" : null,
      today,
      editableFrom: tomorrow,
      checkInEditable: false,
      reason: canModify
        ? null
        : "This in-progress booking cannot be modified in its current status",
    };
  }

  return {
    canModify: false,
    mode: null,
    today,
    editableFrom: null,
    checkInEditable: false,
    reason: "This booking has no future nights available for self-service changes",
  };
}

/**
 * #2029: a stay has "started" once its NZ check-in date is today or earlier.
 * The single source of truth shared by the self-service started-stay cancel
 * block (`booking-cancel.ts`) and the booking-detail UI, so the cancel route and
 * the Cancel button can never disagree about when a stay has begun.
 *
 * `today` is REQUIRED since #3123. It was a default, and the default read the
 * ENVIRONMENT's day rather than the club's persisted one — so a club configured
 * behind its container's zone called a stay started a day early, blocking a
 * self-service cancellation the member was still entitled to. `checkIn` is a
 * `@db.Date` calendar day and is read as one (CT-4, #2870); `today` is the other
 * side of that comparison and arrives on the same UTC-midnight frame.
 */
export function bookingStayHasStarted(
  checkIn: Date,
  today: Date,
): boolean {
  return storedDateOnly(checkIn) <= today;
}

export function canModifyBookingStatusForRole(status: string, role: string): boolean {
  return isFutureEditStatusAllowed(status, role) || isInProgressEditStatusAllowed(status);
}

// #2266: frozen to an explicit list rather than derived from
// MEMBER_FUTURE_EDIT_STATUSES, which now includes DRAFT. A DRAFT booking must
// stay lifecycle-INERT however it is edited (no capacity re-check on apply for
// admins, no hold recompute, no zero-dollar auto-pay, no credit clamp) — it
// holds no capacity and owes no money until confirm-draft or the pay step makes
// it real, and those doors enforce capacity/holds themselves. Deriving this set
// would have silently flipped admin draft edits from "skip lifecycle rules" to
// "run them" the day DRAFT joined the member set.
const ACTIVE_BOOKING_EDIT_LIFECYCLE_STATUSES = new Set<string>([
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
]);

export function usesActiveBookingEditLifecycle(status: string): boolean {
  return ACTIVE_BOOKING_EDIT_LIFECYCLE_STATUSES.has(status);
}
