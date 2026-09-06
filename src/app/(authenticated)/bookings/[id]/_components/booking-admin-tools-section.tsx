import { AdminBookingToolsCard } from "@/components/admin/admin-booking-tools-card";
import { BookingWithheldEmailsBanner } from "@/components/admin/booking-withheld-emails-banner";
import { bookingHoldsCapacity } from "@/lib/booking-status";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BookingEditorData } from "@/components/booking-editor";
import type { FeatureFlags } from "@/config/schema";
import type { BookingDetailViewer } from "../_lib/booking-detail-viewer";
import type { BookingDetailEditAccess } from "../_lib/booking-detail-edit-access";
import type { BookingDetailAdminTools } from "../_lib/booking-detail-admin-tools";
import type { BookingDetailPayment } from "../_lib/booking-detail-payment";

/**
 * THE OFFICER'S TOOLS (#2958): the admin booking-tools card and the #2259
 * withheld-emails banner beneath it, both inside the same `canSeeAdminTools`
 * gate they always had. The card's inputs are the admin-gated reads in
 * `_lib/booking-detail-admin-tools.ts`; this composes them and nothing more.
 * Moved verbatim from `page.tsx`.
 */
export function BookingAdminToolsSection({
  booking,
  editorData,
  modules,
  viewer,
  access,
  adminTools,
  payment,
}: {
  booking: BookingDetailRecord;
  editorData: BookingEditorData;
  modules: FeatureFlags;
  viewer: BookingDetailViewer;
  access: BookingDetailEditAccess;
  adminTools: BookingDetailAdminTools;
  payment: BookingDetailPayment;
}) {
  const { canSeeAdminTools } = viewer;
  const { isDeleted } = access;
  const { savedCard } = payment;
  const {
    providerMismatches,
    financialReviewWarnings,
    withheldEmails,
    withheldEmailGroups,
    noEmailsState,
    manualPaymentState,
    storedNightPriceOffers,
    showReturnToWaitlist,
    exclusiveHoldConflicts,
  } = adminTools;
  return (
    <>
      {canSeeAdminTools && (
        <AdminBookingToolsCard
          bookingId={booking.id}
          memberId={booking.memberId}
          memberName={`${booking.member.firstName} ${booking.member.lastName}`}
          lodgeId={booking.lodgeId}
          checkIn={booking.checkIn}
          checkOut={booking.checkOut}
          copyProps={{
            sourceCheckIn: editorData.checkIn,
            sourceCheckOut: editorData.checkOut,
            minCheckIn: editorData.editPolicy.today,
          }}
          isDeleted={isDeleted}
          paymentId={booking.payment?.id ?? null}
          showConfirmPendingGuests={Boolean(
            !isDeleted &&
              booking.status === "PENDING" &&
              booking.hasNonMembers &&
              booking.nonMemberHoldUntil,
          )}
          // `savedCard` is the answer the confirm-pending-guests route charges
          // on (#3269, `INV-PAY-053`) and the one the "Save Payment Method" card
          // in `_components/booking-payment-cards.tsx` keys on — the same const
          // out of `_lib/booking-detail-payment.ts` — so the button never
          // promises a charge the route will not make, and never promises one
          // while the page asks for a card.
          hasSavedPaymentMethod={savedCard !== null}
          finalPriceCents={booking.finalPriceCents}
          providerMismatches={providerMismatches}
          financialReviewWarnings={financialReviewWarnings}
          features={modules}
          capacityHold={{
            hasAdminCapacityHold: Boolean(booking.adminCapacityHoldAt),
            adminCapacityHoldAt:
              booking.adminCapacityHoldAt?.toISOString() ?? null,
            heldByName: booking.adminCapacityHoldBy
              ? `${booking.adminCapacityHoldBy.firstName} ${booking.adminCapacityHoldBy.lastName}`
              : null,
            holdsCapacityNaturally: bookingHoldsCapacity({
              status: booking.status,
              isRequestConverted: Boolean(booking.originBookingRequest),
            }),
            canPlaceHold: booking.status === "PAYMENT_PENDING",
          }}
          exclusiveHold={{
            wholeLodgeHold: booking.wholeLodgeHold,
            wholeLodgeHoldAt: booking.wholeLodgeHoldAt?.toISOString() ?? null,
            heldByName: booking.wholeLodgeHoldBy
              ? `${booking.wholeLodgeHoldBy.firstName} ${booking.wholeLodgeHoldBy.lastName}`
              : null,
            // Gate the Set control (issue #173): an exclusive hold is only
            // meaningful on a capacity-holding booking (ADR-001 capacity rule).
            // Unlike holdsCapacityNaturally above, this includes the #1764
            // admin-capacity-hold disjunct so a PAYMENT_PENDING booking that
            // already carries an admin hold can take the exclusive hold too —
            // matching the route guard exactly.
            holdsCapacity: bookingHoldsCapacity({
              status: booking.status,
              isRequestConverted: Boolean(booking.originBookingRequest),
              hasAdminCapacityHold: Boolean(booking.adminCapacityHoldAt),
            }),
            conflicts: exclusiveHoldConflicts,
          }}
          noEmails={isDeleted ? undefined : (noEmailsState ?? undefined)}
          manualPayment={manualPaymentState ?? undefined}
          storedNightPriceOffers={storedNightPriceOffers}
          // #2649: the stranded zero-dollar waitlist confirm. Derived above,
          // where the provenance check that makes the banner's claim true can
          // be awaited; the route re-checks every condition under its locks.
          showReturnToWaitlist={showReturnToWaitlist}
          // #2649 review S3: the repair releases any admin capacity hold with
          // the transition, so the dialog has to say so before the officer
          // presses it rather than leave it to the audit row afterwards.
          returnToWaitlistReleasesHold={Boolean(
            showReturnToWaitlist &&
              (booking.adminCapacityHoldAt || booking.wholeLodgeHold),
          )}
        />
      )}

      {/* #2259 (owner decision D10): the persistent warning listing what the
          "No emails" switch has actually withheld, and the admin's standing
          obligation to relay it. Inside the same admin gate as the tools card
          above — never rendered, and never even computed, for a member. */}
      {canSeeAdminTools && noEmailsState && (
        <BookingWithheldEmailsBanner
          noEmails={noEmailsState.noEmails}
          isWaitlisted={noEmailsState.isWaitlisted}
          total={withheldEmails.total}
          groups={withheldEmailGroups}
        />
      )}
    </>
  );
}
