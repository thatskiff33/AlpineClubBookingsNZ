import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrivalTimeEditor } from "@/components/arrival-time-editor";
import { RequestedRoomEditor } from "@/components/requested-room-editor";
import { BookingBedAllocationPanel } from "@/components/admin/booking-bed-allocation-panel";
import { formatDateOnly } from "@/lib/date-only";
import type { EmailMessageSettings } from "@/lib/email-message-settings";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BookingDetailViewer } from "../_lib/booking-detail-viewer";
import type { BookingDetailEditAccess } from "../_lib/booking-detail-edit-access";

/**
 * THE STAY ITSELF (#2958): expected arrival time, the room request, the
 * admin-only in-booking bed allocation panel and the member's arrival
 * instructions. `memberArrivalInstructions` arrives already gated by the page's
 * D-12 predicate — null means the door code never reached this component.
 * Moved verbatim from `page.tsx`.
 */
export function BookingStayPreferences({
  booking,
  viewer,
  access,
  memberArrivalInstructions,
}: {
  booking: BookingDetailRecord;
  viewer: BookingDetailViewer;
  access: BookingDetailEditAccess;
  memberArrivalInstructions: EmailMessageSettings | null;
}) {
  const { canManageBooking, canAdminEditBookings, canSeeAdminTools } = viewer;
  const {
    isDeleted,
    showArrivalTime,
    editPolicy,
    showRequestedRoom,
    canEditRequestedRoom,
    bedAllocationLocked,
    showBedAllocationPanel,
    bookingCanHoldBeds,
  } = access;
  return (
    <>
      {showArrivalTime && (
        <Card id="arrival" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Expected Arrival Time</CardTitle>
          </CardHeader>
          <CardContent>
            <ArrivalTimeEditor
              bookingId={booking.id}
              initialTime={booking.expectedArrivalTime}
              canEdit={(canManageBooking || canAdminEditBookings) && editPolicy.mode === "future"}
            />
          </CardContent>
        </Card>
      )}

      {showRequestedRoom && (
        <Card id="room-request" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Room Request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {canEditRequestedRoom && !canSeeAdminTools ? (
              <p className="text-sm text-muted-foreground">
                Let us know if you&apos;d prefer a particular room. This is a
                request, not a guaranteed allocation. The lodge confirms beds
                closer to your stay.
              </p>
            ) : null}
            <RequestedRoomEditor
              bookingId={booking.id}
              initialRoom={booking.requestedRoom}
              canEdit={canEditRequestedRoom}
              endpoint={
                canSeeAdminTools
                  ? undefined
                  : `/api/bookings/${booking.id}/requested-room`
              }
              lockedNote={
                bedAllocationLocked && !canSeeAdminTools
                  ? "Your beds have been allocated by the lodge and can no longer be changed here."
                  : undefined
              }
            />
          </CardContent>
        </Card>
      )}

      {/* In-booking bed allocation (#2252). Admin-only by construction — the
          same gate as the tools card above, so a member (including the booking
          owner) never receives the component, let alone the data. The
          server-side module flag matches the routes' own gate, which 404s when
          bed allocation is off. A booking that cannot hold beds (cancelled,
          deleted, held) keeps the card and says so honestly, per the owner's
          29 Jul decision — it is never silently hidden.

          Rendered HERE, immediately after the room request, because that is the
          position BOOKING_SECTIONS declares for it (#2252 review): the rail is
          presentation-only and never reorders content, so the card must sit
          where its anchor says it does. It also reads well — the bed the lodge
          allocated sits directly under the room the member asked for. */}
      {showBedAllocationPanel && (
        <BookingBedAllocationPanel
          bookingId={booking.id}
          lodgeId={booking.lodgeId}
          lodgeName={booking.lodge.name}
          memberName={`${booking.member.firstName} ${booking.member.lastName}`}
          checkIn={formatDateOnly(booking.checkIn)}
          checkOut={formatDateOnly(booking.checkOut)}
          wholeLodgeHold={booking.wholeLodgeHold}
          bookingStatus={booking.status}
          isDeleted={isDeleted}
          canHoldBeds={bookingCanHoldBeds}
          guests={booking.guests.map((guest) => ({
            id: guest.id,
            name: `${guest.firstName} ${guest.lastName}`,
          }))}
        />
      )}

      {memberArrivalInstructions ? (
        <Card id="directions" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>How to Get to the Lodge</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p className="whitespace-pre-wrap">
              {memberArrivalInstructions.lodgeTravelNote}
            </p>
            {memberArrivalInstructions.doorCode ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Door code
                </p>
                <p className="mt-1 text-lg font-semibold tracking-wide text-foreground">
                  {memberArrivalInstructions.doorCode}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
