import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MemberGuestConsentCard } from "@/components/member-guest-consent-card";
import { SelfRemoveFromBookingCard } from "@/components/self-remove-from-booking-card";
import {
  describeConsentDeclineRefusal,
  describeConsentNightsCount,
  formatConsentFullDate,
  formatConsentNightsLabel,
  formatConsentStayLabel,
  formatConsentWeekdayDate,
} from "@/lib/member-guest-consent-card";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BoundClubTime } from "@/lib/club-time";
import type { BookingDetailConsent } from "../_lib/booking-detail-consent";

/**
 * THE VIEWER'S OWN CARDS (#2958): the #2307 consent ask card or told-not-asked
 * notice, and the #2250 self-removal card beneath it, rendered from the
 * resolutions in `_lib/booking-detail-consent.ts`. Moved verbatim from
 * `page.tsx`.
 */
export function BookingConsentCards({
  booking,
  club,
  consent,
}: {
  booking: BookingDetailRecord;
  club: BoundClubTime;
  consent: BookingDetailConsent;
}) {
  const {
    consentCard,
    viewerConsentGuest,
    viewerConsentNights,
    consentLodgeName,
    consentIsQuotePriced,
    selfRemovalCard,
  } = consent;
  return (
    <>
      {/* #2307: the viewer's own member-guest consent. The ask card sits
          immediately above the #2250 self-removal card, under the #consent
          anchor the request email deep-links to; the notify-only notice has no
          question to answer and only points at the #2250 card below it. */}
      {consentCard?.kind === "PENDING_ASK" && viewerConsentGuest ? (
        <section id="consent" className="scroll-mt-20">
          <MemberGuestConsentCard
            bookingId={booking.id}
            guestId={consentCard.guestId}
            bookerName={`${booking.member.firstName} ${booking.member.lastName}`.trim()}
            bookerFirstName={booking.member.firstName}
            lodgeName={consentLodgeName ?? ""}
            stayLabel={formatConsentStayLabel(booking.checkIn, booking.checkOut)}
            nightsLabel={formatConsentNightsLabel(viewerConsentNights)}
            nightsCountLabel={describeConsentNightsCount(viewerConsentNights.length)}
            answerByLabel={
              consentCard.consentExpiresAt
                ? formatConsentFullDate(consentCard.consentExpiresAt, club.zone)
                : "—"
            }
            lapseByLabel={
              consentCard.consentExpiresAt
                ? formatConsentWeekdayDate(consentCard.consentExpiresAt, club.zone)
                : "the deadline"
            }
            party={booking.guests.map((guest) => ({
              name: `${guest.firstName} ${guest.lastName}`.trim(),
              isViewer: guest.id === consentCard.guestId,
            }))}
            quotePriced={consentIsQuotePriced}
            refusalWarning={
              consentCard.refusalBlocker
                ? describeConsentDeclineRefusal({
                    blocker: consentCard.refusalBlocker,
                    voice: { kind: "TARGET" },
                    bookerFirstName: booking.member.firstName,
                  })
                : null
            }
          />
        </section>
      ) : consentCard?.kind === "NOTIFY_ONLY_NOTICE" ? (
        <Card>
          <CardHeader className="space-y-2">
            <div>
              <Badge
                variant="outline"
                className="border-success-6 bg-success-3 text-success-11"
              >
                You&apos;re on this booking
              </Badge>
            </div>
            <CardTitle>
              {`${booking.member.firstName} ${booking.member.lastName}`.trim()}{" "}
              added you to this booking
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Your place is already held — the club does not ask first for
              member guests. If you would rather not go, take yourself off
              below.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* #2250: the member's own way off somebody else's booking. Only ever
          rendered for a linked guest viewer (never the owner, never an admin —
          they change the guest list through the booking edit flow above), and
          the action itself is hidden, with the reason stated, whenever the
          shared server-side rule says the removal service would refuse. No
          BOOKING_SECTIONS anchor: this is a short action card, not a section. */}
      {selfRemovalCard ? (
        <SelfRemoveFromBookingCard
          bookingId={booking.id}
          guestId={selfRemovalCard.guestId}
          ownerFirstName={booking.member.firstName}
          canSelfRemove={selfRemovalCard.canSelfRemove}
          blockedReason={selfRemovalCard.blockedReason}
        />
      ) : null}
    </>
  );
}
