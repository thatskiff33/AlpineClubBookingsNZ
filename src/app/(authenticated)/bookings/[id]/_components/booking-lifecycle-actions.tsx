import { CancelBookingButton } from "@/components/cancel-booking-button";
import { DeleteBookingButton } from "@/components/delete-booking-button";
import { RefundAppealButton } from "@/components/refund-appeal-button";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BookingDetailViewer } from "../_lib/booking-detail-viewer";
import type { BookingDetailEditAccess } from "../_lib/booking-detail-edit-access";
import type { BookingDetailPayment } from "../_lib/booking-detail-payment";
import type { BookingDetailMessages } from "../_lib/booking-detail-messages";

/**
 * THE LIFECYCLE ACTIONS (#2958): cancel, delete (draft or soft-delete
 * cancelled) and the refund appeal. Each button fronts a server route that
 * authorizes for itself; the gates here are the page's own, unchanged, so no
 * button is offered that its route would refuse. Moved verbatim from
 * `page.tsx`.
 */
export function BookingLifecycleActions({
  booking,
  viewer,
  access,
  payment,
  messages,
  canDeleteDraft,
  canSoftDeleteCancelled,
  backHref,
}: {
  booking: BookingDetailRecord;
  viewer: BookingDetailViewer;
  access: BookingDetailEditAccess;
  payment: BookingDetailPayment;
  messages: BookingDetailMessages;
  canDeleteDraft: boolean;
  canSoftDeleteCancelled: boolean;
  backHref: string;
}) {
  const { viewerAuthorizationRole, actingOnBehalf, canManageBooking } = viewer;
  const { canCancel, isDeleted } = access;
  const { maxRefundableCents } = payment;
  const { refundAppealDescription } = messages;
  return (
    <>
      {canCancel && (
        <CancelBookingButton
          bookingId={booking.id}
          refundAppealDescription={refundAppealDescription}
          onBehalfOfMember={actingOnBehalf}
          // Issue #1705: the notify dialog shows iff the cancel route will
          // honour the choice — viewerAuthorizationRole is the same
          // booking-management role the route resolves for its 403 gate.
          canChooseMemberEmail={viewerAuthorizationRole === "ADMIN"}
          canOverrideHostingCoverage={viewerAuthorizationRole === "ADMIN"}
          // #2259: with the switch on there is no email choice to honour, so
          // the dialog states that instead of asking. Spread rather than a
          // conditional value, so a member's payload carries no `noEmails` KEY
          // at all — React Flight serialises the key too, and `noEmails:false`
          // would still tell a member the switch exists.
          {...(viewerAuthorizationRole === "ADMIN"
            ? { noEmails: booking.noEmails }
            : {})}
        />
      )}

      {canDeleteDraft ? (
        <DeleteBookingButton
          bookingId={booking.id}
          mode="draft"
          returnHref={backHref}
        />
      ) : null}

      {canSoftDeleteCancelled ? (
        <DeleteBookingButton
          bookingId={booking.id}
          mode="cancelled"
          returnHref={backHref}
        />
      ) : null}

      {/* Refund appeal: owner-or-Full-Admin only, matching its backing route
          (/api/bookings/[id]/refund-request, owner-or-hasAdminAccess). The
          #1289 read-only guard now admits Booking Officers / read-only admins to
          this page, and this control previously carried no viewer gate, so it
          would have shown them a button that 403s. canManageBooking restores the
          intended owner + Full-Admin audience. */}
      {canManageBooking &&
        !isDeleted &&
        booking.status === "CANCELLED" &&
        booking.payment &&
        booking.payment.status !== "REFUNDED" &&
        maxRefundableCents > 0 && (
          <RefundAppealButton
            bookingId={booking.id}
            maxRefundableCents={maxRefundableCents}
            description={refundAppealDescription}
          />
        )}
    </>
  );
}
