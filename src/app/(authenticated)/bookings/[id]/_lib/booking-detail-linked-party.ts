import type { FeatureFlags } from "@/config/schema";
import { formatDateOnly } from "@/lib/date-only";
import { OPENABLE_ORGANISER_STATUSES } from "@/lib/group-booking";
import type { NonMemberGuestChild } from "@/app/(authenticated)/bookings/_components/non-member-guests-section";
import type { OrganiserGroupState } from "@/components/group-booking/organiser-group-booking-card";
import type { BookingDetailRecord } from "./load-booking-detail";
import type { BookingDetailViewer } from "./booking-detail-viewer";
import type { BookingDetailEditAccess } from "./booking-detail-edit-access";
import { reconcileStoredBookingMoney } from "@/lib/booking-money-reconciliation-store";
import { bookingMoneyReconciliationForViewer } from "@/lib/booking-money-reconciliation-audience";

/**
 * THE REST OF THE PARTY (#2958): the bookings LINKED to this one — the #738
 * split children holding a member's non-member guests, the #1975 "Your
 * non-member guests" rows, the flagged-provisional shape, and the #796 group
 * this booking's owner organises. Pure projection over the loaded record; the
 * send route, the group API and the organiser card keep their own gates.
 *
 * Moved verbatim from `page.tsx`, comments included.
 */
export function resolveBookingDetailLinkedParty({
  booking,
  modules,
  viewer,
  access,
}: {
  booking: BookingDetailRecord;
  modules: FeatureFlags;
  viewer: BookingDetailViewer;
  access: BookingDetailEditAccess;
}) {
  const { canManageBooking, isBookingOwner, canSeeAdminTools } = viewer;
  const { isDeleted } = access;
  // Split-booking group presentation (#738). Genuine split children only:
  // #796 group joiners also link via parentBookingId but are presented by the
  // organiser group card, not as "your provisional non-member guests" — and
  // the guest-payment-link affordance below must match the send route's
  // filter (PENDING + hasNonMembers + no join row) so the button never
  // renders for children the route would refuse.
  const linkedProvisionalChildren = booking.linkedBookings.filter(
    (linked) =>
      linked.status === "PENDING" &&
      linked.hasNonMembers &&
      !linked.groupBookingJoin
  );
  const provisionalChildGuestCount = linkedProvisionalChildren.reduce(
    (total, linked) => total + linked.guests.length,
    0
  );
  const hasProvisionalChildren = provisionalChildGuestCount > 0;
  const isProvisionalChild = Boolean(booking.parentBooking);
  // #1975: the "Your non-member guests" section lists every genuine #738 split
  // child regardless of status (a cancelled or bumped child must still be
  // visible to the member paying for the party), unlike linkedProvisionalChildren
  // above which is PENDING-only because it gates the guest-payment-link route.
  // #796 group joiners (which carry a join row) stay excluded — the organiser
  // group card presents them. Dates are compared as date-only NZ lodge nights.
  const parentCheckInDate = formatDateOnly(booking.checkIn);
  const parentCheckOutDate = formatDateOnly(booking.checkOut);
  const nonMemberGuestChildren: NonMemberGuestChild[] = booking.linkedBookings
    .filter((linked) => linked.hasNonMembers && !linked.groupBookingJoin)
    .map((linked) => {
      const childCheckIn = formatDateOnly(linked.checkIn);
      const childCheckOut = formatDateOnly(linked.checkOut);
      return {
        id: linked.id,
        status: linked.status,
        guestCount: linked.guests.length,
        finalPriceCents: linked.finalPriceCents,
        // #3278: a split child is ANOTHER BOOKING, and this section renders to
        // the member paying for the party. The verdict is officer-only, so it
        // is gated here at the projection rather than in the component that
        // prints it — a component that declines to render it has still been
        // handed every reason.
        moneyReconciliation: bookingMoneyReconciliationForViewer(
          reconcileStoredBookingMoney(linked),
          { canSeeAdminTools },
        ),
        datesDiffer:
          childCheckIn !== parentCheckInDate ||
          childCheckOut !== parentCheckOutDate,
        checkIn: linked.checkIn,
        checkOut: linked.checkOut,
      };
    });
  // Owner and admin viewers see the section; a linked non-member guest viewer
  // (someone listed on the child) does not manage the parent, so they never
  // land on this member-facing parent card with children to present.
  const showNonMemberGuestsSection =
    !isDeleted && canManageBooking && nonMemberGuestChildren.length > 0;
  const isFlaggedProvisional =
    !booking.parentBookingId &&
    booking.status === "PENDING" &&
    booking.cancelIfGuestsBumped &&
    booking.hasNonMembers;

  // Group booking organiser card (#796+). Only the owner manages their group;
  // the API enforces ownership too. Non-member joins appear once they verify
  // (i.e. once a child booking exists), so the roster is built from joins that
  // have a booking.
  const organiserGroup = booking.groupBookingAsOrganiser;
  const organiserGroupState: OrganiserGroupState | null = organiserGroup
    ? {
        code: organiserGroup.joinCode,
        status: organiserGroup.status,
        paymentMode: organiserGroup.paymentMode,
        joinDeadline: organiserGroup.joinDeadline?.toISOString() ?? null,
        maxJoiners: organiserGroup.maxJoiners,
        settlement: organiserGroup.settlement
          ? {
              status: organiserGroup.settlement.status,
              amountCents: organiserGroup.settlement.amountCents,
              paidAt: organiserGroup.settlement.paidAt?.toISOString() ?? null,
            }
          : null,
        // A `flatMap` rather than `filter().map()` so the joiner's booking
        // NARROWS (#3278). The old shape left it optional at every read, and a
        // `join.booking ? … : null` verdict then meant two different things at
        // once: "this joiner has no booking yet" and "this viewer may not see
        // it". With the officer gate in place that null would have downgraded
        // every joiner to unmarked instead of failing visibly — the only
        // fail-open shape in the feature. There is now no null to read.
        joiners: organiserGroup.joins.flatMap((join) => {
          const joinerBooking = join.booking;
          // A non-member join becomes a roster row only once it verifies and
          // its child booking exists, which is what the old filter said.
          if (!joinerBooking) return [];
          return [
            {
              id: join.id,
              name: join.joinerMember
                ? `${join.joinerMember.firstName} ${join.joinerMember.lastName}`.trim()
                : [join.contactFirstName, join.contactLastName]
                    .filter(Boolean)
                    .join(" ") || "Guest",
              guestCount: joinerBooking.guests.length,
              status: joinerBooking.status,
              priceCents: joinerBooking.finalPriceCents,
              // Each joiner is a DIFFERENT MEMBER's booking and this card
              // renders to the organiser, so the gate matters most here.
              moneyReconciliation: bookingMoneyReconciliationForViewer(
                reconcileStoredBookingMoney(joinerBooking),
                { canSeeAdminTools },
              ),
              isMember: join.isMember,
            },
          ];
        }),
      }
    : null;
  const canOpenGroup =
    isBookingOwner &&
    !isDeleted &&
    !booking.parentBookingId &&
    !organiserGroup &&
    OPENABLE_ORGANISER_STATUSES.includes(booking.status);
  const showGroupSection =
    modules.groupBookings &&
    canManageBooking &&
    isBookingOwner &&
    (Boolean(organiserGroupState) || canOpenGroup);

  return {
    provisionalChildGuestCount,
    hasProvisionalChildren,
    isProvisionalChild,
    showNonMemberGuestsSection,
    nonMemberGuestChildren,
    isFlaggedProvisional,
    organiserGroupState,
    canOpenGroup,
    showGroupSection,
  };
}

export type BookingDetailLinkedParty = ReturnType<
  typeof resolveBookingDetailLinkedParty
>;
