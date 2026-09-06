import { NonMemberGuestsSection } from "@/app/(authenticated)/bookings/_components/non-member-guests-section";
import { OrganiserGroupBookingCard } from "@/components/group-booking/organiser-group-booking-card";
import type { EmailMessageSettings } from "@/lib/email-message-settings";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BookingDetailViewer } from "../_lib/booking-detail-viewer";
import type { BookingDetailLinkedParty } from "../_lib/booking-detail-linked-party";

/**
 * THE LINKED BOOKINGS' SECTIONS (#2958): the #1975 "Your non-member guests"
 * card and the #796 organiser group card, from the projection in
 * `_lib/booking-detail-linked-party.ts`. Moved verbatim from `page.tsx`.
 */
export function BookingLinkedPartySections({
  booking,
  viewer,
  party,
  bookingLodgeEmailSettings,
}: {
  booking: BookingDetailRecord;
  viewer: BookingDetailViewer;
  party: BookingDetailLinkedParty;
  bookingLodgeEmailSettings: EmailMessageSettings;
}) {
  const { nonOwnerAdminViewer } = viewer;
  const {
    showNonMemberGuestsSection,
    nonMemberGuestChildren,
    showGroupSection,
    canOpenGroup,
    organiserGroupState,
  } = party;
  return (
    <>
      {/* #1975: "Your non-member guests" — the parent card surfaces each genuine
          split child inline (status, differing dates, amount, link), so the
          member reads one family stay with the guest portion nested, not a
          disconnected sibling booking. Presentation only: no pricing, capacity,
          settlement, or invoicing behaviour changes here. */}
      {showNonMemberGuestsSection && (
        <section id="non-member-guests" className="scroll-mt-20">
          <NonMemberGuestsSection
            guests={nonMemberGuestChildren}
            nonOwnerAdminViewer={nonOwnerAdminViewer}
          />
        </section>
      )}

      {showGroupSection && (
        <section id="group" className="scroll-mt-20">
          <OrganiserGroupBookingCard
            bookingId={booking.id}
            canOpenGroup={canOpenGroup}
            group={organiserGroupState}
            /* #2919: the card renders booking-message bodies of its own, so it
               needs THIS booking's lodge for {{CLUB_LODGE_NAME}} too. */
            lodgeName={bookingLodgeEmailSettings.lodgeName}
          />
        </section>
      )}
    </>
  );
}
