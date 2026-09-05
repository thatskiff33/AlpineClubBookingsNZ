import { prisma } from "@/lib/prisma";
import type { Instant } from "@/lib/club-time";
// `eachDateOnlyInRange` is pure UTC calendar arithmetic feeding
// `formatConsentNightsLabel`, which takes `Date[]`. It reads no timezone, so it
// is not a second temporal authority; CT-6 (#2991) retires the module.
import { eachDateOnlyInRange } from "@/lib/date-only";
import type { EmailMessageSettings } from "@/lib/email-message-settings";
import { resolveBookingSelfRemovalCard } from "@/lib/booking-guest-self-removal";
import { isQuotePricedBooking } from "@/lib/booking-modify-validation";
import {
  resolveBookingConsentCard,
  type MemberGuestConsentBadgeAudience,
} from "@/lib/member-guest-consent-card";
import type { auth } from "@/lib/auth";
import type { BookingDetailRecord } from "./load-booking-detail";
import type { BookingDetailViewer } from "./booking-detail-viewer";

/**
 * THE VIEWER'S OWN PLACE ON SOMEBODY ELSE'S BOOKING (#2958): the #2250
 * self-removal card, the #2307 member-guest consent card (ask, or told-not-asked
 * notice), the nights that card quotes, and the per-guest consent badge inputs
 * every viewer of the guest list receives. One domain — member-guest consent —
 * so one module; the resolvers it calls are the shared server-side rules and
 * nothing here re-derives them.
 *
 * `bookingLodgeEmailSettings` is the page's one load of THIS booking's lodge
 * identity, handed in rather than loaded twice; the page reads it before
 * calling here, which is the same query it always ran, one await earlier.
 *
 * Moved verbatim from `page.tsx`, comments included.
 */
export async function resolveBookingDetailConsent({
  session,
  booking,
  viewer,
  clubTodayDateOnly,
  bookingLodgeEmailSettings,
}: {
  session: NonNullable<Awaited<ReturnType<typeof auth>>>;
  booking: BookingDetailRecord;
  viewer: BookingDetailViewer;
  clubTodayDateOnly: Instant;
  bookingLodgeEmailSettings: EmailMessageSettings;
}) {
  const { isBookingOwner, isAdmin, canViewAsAdmin } = viewer;
  // Issue #2250: a member put on somebody else's booking must be able to take
  // themselves off it from the booking itself, not only from the wizard's
  // night-conflict card while attempting a clashing booking of their own.
  // Eligibility is the shared server-side rule (evaluateGuestSelfRemoval), the
  // same one that produces `canSelfRemove` on a night conflict and whose status
  // gate the removal service enforces — never re-derived in the browser.
  // The gate itself lives in `resolveBookingSelfRemovalCard` so it is unit
  // testable: rendering this card for an owner, a full admin, a non-participant,
  // or a soft-deleted booking must fail a test, not just review.
  const selfRemovalInput = {
    actorMemberId: session.user.id,
    isBookingOwner,
    isAdminViewer: isAdmin,
    bookingDeletedAt: booking.deletedAt,
    bookingOwnerMemberId: booking.memberId,
    bookingStatus: booking.status,
    bookingCheckIn: booking.checkIn,
    guests: booking.guests,
    // The club's today, resolved ONCE for this page above and threaded here
    // rather than defaulted inside the predicate (#3123). It is the same binding
    // the started-stay test and both edit policies take, and the consent card
    // below takes it too — so no two answers on this page can straddle midnight
    // and disagree about whether the stay has started.
    today: clubTodayDateOnly,
  };
  const selfRemovalCandidate = resolveBookingSelfRemovalCard(selfRemovalInput);
  // The removal service also refuses a quote-priced booking
  // (assertBookingNotQuotePriced), and unlike its settled-payment election that
  // refusal is one indexed lookup — so predict it here rather than offering a
  // control the server would reject. Only run when the action would otherwise
  // be offered, so an ordinary booking view adds no query.
  const selfRemovalCard = selfRemovalCandidate?.canSelfRemove
    ? resolveBookingSelfRemovalCard({
        ...selfRemovalInput,
        isQuotePriced: await isQuotePricedBooking(prisma, booking.id),
      })
    : selfRemovalCandidate;

  // #2307: the viewer's own member-guest consent state — the ask card while
  // their consent is PENDING (owner decision D-11 gives that row this whole
  // page, so the card sits inside it), or the told-not-asked notice for a
  // notify-only add. Two-phase like the self-removal card above: the
  // quote-priced lookup (one indexed query) only runs when the ask card will
  // actually render, because its refusal prediction is the only consumer.
  const consentCardInput = {
    actorMemberId: session.user.id,
    bookingDeletedAt: booking.deletedAt,
    bookingStatus: booking.status,
    bookingCheckIn: booking.checkIn,
    guests: booking.guests,
    selfRemovalCardPresent: Boolean(selfRemovalCard),
    // The day is stated HERE, by name, and passed down: the card resolver and
    // its refusal prediction are pure, so "today" is this page's fact to state
    // rather than something a helper quietly looks up for itself. Stating it is
    // not the same as RESOLVING it — this is the page's one resolved value from
    // above, not a second reading of the clock.
    today: clubTodayDateOnly,
  };
  const consentCandidate = resolveBookingConsentCard({
    ...consentCardInput,
    isQuotePriced: false,
  });
  const consentIsQuotePriced =
    consentCandidate?.kind === "PENDING_ASK"
      ? await isQuotePricedBooking(prisma, booking.id)
      : false;
  const consentCard =
    consentCandidate?.kind === "PENDING_ASK"
      ? resolveBookingConsentCard({
          ...consentCardInput,
          isQuotePriced: consentIsQuotePriced,
        })
      : consentCandidate;
  // The ask card names the lodge the way the request email does.
  const consentLodgeName =
    consentCard?.kind === "PENDING_ASK"
      ? bookingLodgeEmailSettings.lodgeName
      : null;
  const viewerConsentGuest =
    consentCard?.kind === "PENDING_ASK"
      ? booking.guests.find((guest) => guest.id === consentCard.guestId) ?? null
      : null;
  const viewerConsentNights = viewerConsentGuest
    ? viewerConsentGuest.nights.length > 0
      ? viewerConsentGuest.nights.map((night) => night.stayDate)
      : eachDateOnlyInRange(viewerConsentGuest.stayStart, viewerConsentGuest.stayEnd)
    : [];

  // #2307 (owner decision MG2-M-2): the per-guest consent badge, shown to
  // everyone who can see the guest list — member and admin read the same page.
  // Family and non-member rows get no badge and no layout change.
  //
  // WHICH BADGE WORDING depends on who is reading, because the two signed-off
  // mockups differ: the member pack draws the bare "Consented" / "Added by the
  // club" forms, the admin pack the named and dated ones. The person who
  // answered is routinely a family adult with no place on this booking (D-9),
  // so their name is the club's business, not every co-guest's. For a member
  // viewer the responder names are therefore never even looked up.
  const consentBadgeAudience = isAdmin || canViewAsAdmin ? "ADMIN" : "MEMBER";
  const consentResponderIds =
    consentBadgeAudience === "ADMIN"
      ? [
          ...new Set(
            booking.guests
              .filter((guest) => guest.consentStatus !== null)
              .map((guest) => guest.consentRespondedByMemberId)
              .filter((memberId): memberId is string => Boolean(memberId)),
          ),
        ]
      : [];
  const consentResponders =
    consentResponderIds.length > 0
      ? await prisma.member.findMany({
          where: { id: { in: consentResponderIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
  const consentResponderNameById = new Map(
    consentResponders.map((member) => [
      member.id,
      `${member.firstName} ${member.lastName}`.trim(),
    ]),
  );
  return {
    selfRemovalCard,
    consentCard,
    consentIsQuotePriced,
    consentLodgeName,
    viewerConsentGuest,
    viewerConsentNights,
    // Names the union the badge helper takes; a bare `"ADMIN" | "MEMBER"`
    // literal widens to `string` when it crosses the return.
    consentBadgeAudience: consentBadgeAudience as MemberGuestConsentBadgeAudience,
    consentResponderNameById,
  };
}

export type BookingDetailConsent = Awaited<
  ReturnType<typeof resolveBookingDetailConsent>
>;
