import { BookingStatus } from "@prisma/client";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";
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

export function getBookingEditPolicy(
  input: BookingEditPolicyInput
): BookingEditPolicy {
  // STILL THE CONTAINER'S DAY, deliberately, and callers must not claim
  // otherwise. `getTodayDateOnly()` reads `APP_TIME_ZONE` (`process.env.TZ`),
  // where `INV-CONFIG-002` makes the persisted `ClubTimeSettings.timeZone` the
  // only authority. Moving it means resolving the zone from the database, which
  // makes this synchronous, pure, widely-called function `async`; that plumbing
  // is CT-6's (#2991), not CT-4's. The `@db.Date` decodes below are a different
  // question with a local answer, and they are fixed.
  const today = getTodayDateOnly();
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
 * the Cancel button can never disagree about when a stay has begun. `today` is
 * injectable purely for deterministic tests; production resolves it via
 * `getTodayDateOnly()`, which is still the CONTAINER's day for the reason given
 * in `getBookingEditPolicy` above. `checkIn` is a `@db.Date` calendar day and is
 * read as one (CT-4, #2870).
 */
export function bookingStayHasStarted(
  checkIn: Date,
  today: Date = getTodayDateOnly(),
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
