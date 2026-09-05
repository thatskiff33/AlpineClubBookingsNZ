import type { FeatureFlags } from "@/config/schema";
import type { Instant } from "@/lib/club-time";
import type { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import { getBookingEditPolicy, bookingStayHasStarted } from "@/lib/booking-edit-policy";
import { isBookingFullyPaidForGuestNameEdits } from "@/lib/booking-modify";
import {
  isBookingBedAllocationLocked,
} from "@/lib/bed-allocation-approval";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import type { BookingDetailRecord } from "./load-booking-detail";

/**
 * WHAT THIS VIEWER MAY DO TO THIS BOOKING (#2958): the lifecycle flags, the
 * started-stay test, the cancel / modify / admin-override / requested-room /
 * guest-name gates, and the two named panel gates the section rail is built
 * from. Every predicate mirrors the route that backs its control, so a button
 * is never offered that its route would refuse; the edit policy itself is the
 * canonical `getBookingEditPolicy`, called as before.
 *
 * `modules` is the page's one read of the module flags, handed in.
 *
 * Moved verbatim from `page.tsx`, comments included.
 */
export async function resolveBookingDetailEditAccess({
  booking,
  modules,
  clubTodayDateOnly,
  viewerAuthorizationRole,
  isAdmin,
  isBookingOwner,
  canManageBooking,
  canAdminEditBookings,
  canSeeAdminTools,
}: {
  booking: BookingDetailRecord;
  modules: FeatureFlags;
  clubTodayDateOnly: Instant;
  viewerAuthorizationRole: ReturnType<typeof bookingManagementAuthorizationRole>;
  isAdmin: boolean;
  isBookingOwner: boolean;
  canManageBooking: boolean;
  canAdminEditBookings: boolean;
  canSeeAdminTools: boolean;
}) {
  const isDraft = booking.status === "DRAFT";
  const isWaitlisted = booking.status === "WAITLISTED";
  const isWaitlistOffered = booking.status === "WAITLIST_OFFERED";
  const isDeleted = Boolean(booking.deletedAt);
  // #2029: a self-service actor (booking owner or Booking Officer) can no longer
  // cancel a stay that has already started (NZ check-in on or before today) —
  // the service enforces this behind enforceStartedStayBlock. Mirror it here so
  // the button is honest and never 400s (same "no button that fails" pattern as
  // the view-only work). A Full Admin (isAdmin) keeps the button; they leave
  // early via edit/shrink otherwise.
  const stayHasStarted = bookingStayHasStarted(booking.checkIn, clubTodayDateOnly);
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) may cancel any
  // booking; the /api/bookings/[id]/cancel route authorizes bookings:edit and the
  // notes editor below is gated on this same predicate.
  const canCancel =
    (canManageBooking || canAdminEditBookings) &&
    !isDeleted &&
    (isAdmin || !stayHasStarted) &&
    ["PAYMENT_PENDING", "CONFIRMED", "PAID", "PENDING", "WAITLISTED", "WAITLIST_OFFERED"].includes(booking.status);
  const showArrivalTime = !isDeleted && !["CANCELLED", "COMPLETED"].includes(booking.status);
  const showRequestedRoom =
    !isDeleted && (modules.bedAllocation || Boolean(booking.requestedRoomId));
  // Issue #776: the booking owner may request a room until an admin confirms
  // (locks) the bed allocation; admins can always edit while the booking is
  // modifiable. Only check the lock when the editor will actually render and
  // the module is on (the admin route also gates on bedAllocation).
  const bedAllocationLocked =
    showRequestedRoom && modules.bedAllocation
      ? await isBookingBedAllocationLocked({ bookingId: booking.id })
      : false;
  /*
   * In-booking bed allocation card (#2252). One named gate, used by BOTH the
   * render site below and the section rail above it, so the rail can be built
   * from the truth rather than pruned back to it after hydration (#2252
   * review): a member's server-rendered HTML used to carry a "Bed Allocation"
   * link that only disappeared once the client had mounted.
   */
  const showBedAllocationPanel = canSeeAdminTools && modules.bedAllocation;
  /*
   * Whether this booking's STATUS may own bed allocations at all. The panel must
   * not infer this from the booking's absence from a window read — a booking
   * with no guest night inside the page on screen is absent too, and calling
   * that "cannot hold beds" was both false and hid the officer's rows (#2252
   * review). BED_ALLOCATABLE_BOOKING_STATUSES lives in a prisma-importing
   * module, so the answer is computed here and passed down.
   */
  const bookingCanHoldBeds = showBedAllocationPanel
    ? (BED_ALLOCATABLE_BOOKING_STATUSES as readonly string[]).includes(
        booking.status,
      )
    : false;
  const requestedRoomEditableStatus =
    booking.status !== "CANCELLED" && booking.status !== "COMPLETED";
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: viewerAuthorizationRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    today: clubTodayDateOnly,
  });
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) resolves to ADMIN
  // in viewerAuthorizationRole above, so editPolicy is the admin-on-behalf policy
  // and this predicate admits them exactly as the widened modify route does.
  const canModify = (canManageBooking || canAdminEditBookings) && !isDeleted && editPolicy.canModify;
  // Issue #1668: admins (Full Admin or Booking Officer) get an explicit override
  // path that can move a booking's dates regardless of the edit-policy window
  // (in-progress and fully-past). Quote-priced bookings are blocked server-side,
  // so no precompute is needed here. The override policy lifts only the date
  // gates — status eligibility is still enforced.
  const overridePolicy = getBookingEditPolicy({
    status: booking.status,
    role: viewerAuthorizationRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    adminOverride: true,
    today: clubTodayDateOnly,
  });
  const canAdminOverride =
    viewerAuthorizationRole === "ADMIN" &&
    !isDeleted &&
    overridePolicy.canModify;
  const canEditRequestedRoom = isDeleted
    ? false
    : isAdmin
      ? canModify
      : canAdminEditBookings
        ? // Issue #1313: Booking Officers set the requested room through the
          // admin route (/api/admin/bookings/[id]/requested-room, bookings:edit),
          // which mirrors these exact conditions and ignores the member-facing
          // allocation lock.
          modules.bedAllocation && requestedRoomEditableStatus
        : // Members (owners) may request a room before and after payment, until
          // the lodge confirms beds. Not tied to the paid/edit policy.
          isBookingOwner &&
          modules.bedAllocation &&
          requestedRoomEditableStatus &&
          !bedAllocationLocked;
  const canEditNonMemberGuestNames =
    canModify && !isBookingFullyPaidForGuestNameEdits(booking);
  // Once fully paid, the paid-name lock permits ONLY an identity-preserving
  // spelling correction on a free-text non-member guest (#1386). The similarity
  // guard is enforced server-side; this flag only opens the field with a hint.
  const canFixNonMemberGuestNameTypos =
    canModify && isBookingFullyPaidForGuestNameEdits(booking);

  return {
    isDraft,
    isWaitlisted,
    isWaitlistOffered,
    isDeleted,
    canCancel,
    showArrivalTime,
    showRequestedRoom,
    bedAllocationLocked,
    showBedAllocationPanel,
    bookingCanHoldBeds,
    editPolicy,
    canModify,
    canAdminOverride,
    canEditRequestedRoom,
    canEditNonMemberGuestNames,
    canFixNonMemberGuestNameTypos,
  };
}
