import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  findOverlappingCapacityHoldingBookings,
  findOverlappingOverriddenNonHoldingBookings,
} from "@/lib/capacity";
import { notFound, redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { formatCents } from "@/lib/utils";
import { CancelBookingButton } from "@/components/cancel-booking-button";
import { BookingPaymentSection } from "@/components/booking-payment-section";
import { SwitchToInternetBankingButton } from "@/components/switch-to-internet-banking-button";
import { SendGuestPaymentLinkButton } from "@/components/send-guest-payment-link-button";
import { BookingNotesEditor } from "@/components/booking-notes-editor";
import { BookingEditor, type BookingEditorData } from "@/components/booking-editor";
import { AdditionalPaymentCard } from "@/components/additional-payment-card";
import { BookingAdditionalPaymentPanel } from "@/components/admin/booking-additional-payment-panel";
import {
  additionalPaymentEpisodeStartedAt,
  isAdditionalPayableBookingStatus,
} from "@/lib/additional-payment-chase";
import { ConfirmDraftButton } from "@/components/confirm-draft-button";
import { AdminBookingToolsCard } from "@/components/admin/admin-booking-tools-card";
import { getBookingManualPaymentState } from "@/lib/manual-booking-payment-state";
import { BookingBedAllocationPanel } from "@/components/admin/booking-bed-allocation-panel";
import { BookingWithheldEmailsBanner } from "@/components/admin/booking-withheld-emails-banner";
import { getWithheldBookingEmailSummary } from "@/lib/booking-email-suppression";
import { bookingHasLiveWaitlistOffer } from "@/lib/booking-no-emails-service";
import { ScrollToHash } from "@/components/scroll-to-hash";
import { SectionNav, type SectionNavItem } from "@/components/section-nav";
import { ArrivalTimeEditor } from "@/components/arrival-time-editor";
import { RequestedRoomEditor } from "@/components/requested-room-editor";
import { WaitlistOfferCard } from "@/components/waitlist-offer-card";
import { DeleteBookingButton } from "@/components/delete-booking-button";
import { getBookingEditPolicy, bookingStayHasStarted } from "@/lib/booking-edit-policy";
import { getBookingPaymentMode } from "@/lib/booking-payment-flow";
import { RefundAppealButton } from "@/components/refund-appeal-button";
import { humanizeStatus, paymentStatusClass } from "@/lib/status-colors";
import { BookingHelpExtras } from "./_components/booking-help-extras";
import {
  NonMemberGuestsSection,
  type NonMemberGuestChild,
} from "@/app/(authenticated)/bookings/_components/non-member-guests-section";
import { loadCancellationPolicy } from "@/lib/cancellation";
import { describeCancellationSchedule } from "@/lib/cancellation-schedule";
import { WAITLIST_OFFER_HOURS } from "@/lib/waitlist";
import { findUnresolvedWaitlistStrandReport } from "@/lib/waitlist-return-contract";
import {
  getCancellationSettlementBreakdown,
  getPaymentDisplayStatus,
} from "@/lib/payment-status-display";
import {
  buildBookingHistoryItems,
  type BookingHistoryTone,
} from "@/lib/booking-history";
import {
  resolveBookingNarrative,
  type BookingNarrativeState,
  type NarrativeEvent,
} from "@/lib/booking-narrative";
import {
  asDuplicateCaptureRefundSnapshot,
  isDuplicateCaptureRefundEvent,
} from "@/lib/duplicate-capture-refund-event";
import {
  getRemainingRefundableCents,
  hasCapturedPayment,
} from "@/lib/booking-payment-state";
import {
  deriveBookingAppliedCreditCents,
  getMemberCreditBalance,
} from "@/lib/member-credit";
import {
  isBookingFullyPaidForGuestNameEdits,
  isMemberWholeLodgeBooking,
} from "@/lib/booking-modify";
import { resolveCreditElectionNoticeAudience } from "@/lib/booking-credit-election";
import {
  bookingHoldsCapacity,
  isPaymentOwedBookingStatus,
} from "@/lib/booking-status";
import {
  isBookingBedAllocationLocked,
} from "@/lib/bed-allocation-approval";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import { formatDateOnly } from "@/lib/date-only";
import {
  formatNZDate,
  formatNZDateTime,
  formatNZLongDate,
} from "@/lib/nzst-date";
import { getBookingProviderMismatches } from "@/lib/booking-provider-mismatches";
import { loadEmailMessageSettingsForLodge } from "@/lib/email-message-settings";
import { loadPublicBookingMessages } from "@/lib/booking-message-settings";
import { renderBookingMessageTemplate } from "@/lib/booking-message-definitions";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { resolveInternalReturnPath } from "@/lib/internal-return-path";
import { OPENABLE_ORGANISER_STATUSES } from "@/lib/group-booking";
import { hasAdminAccess } from "@/lib/access-roles";
import { SelfRemoveFromBookingCard } from "@/components/self-remove-from-booking-card";
import { resolveBookingSelfRemovalCard } from "@/lib/booking-guest-self-removal";
import { isQuotePricedBooking } from "@/lib/booking-modify-validation";
import { MemberGuestConsentCard } from "@/components/member-guest-consent-card";
import {
  describeConsentDeclineRefusal,
  describeConsentNightsCount,
  describeMemberGuestConsentBadge,
  formatConsentFullDate,
  formatConsentNightsLabel,
  formatConsentStayLabel,
  formatConsentWeekdayDate,
  resolveBookingConsentCard,
} from "@/lib/member-guest-consent-card";
// Kept as its OWN single-line import, deliberately: a source contract in
// arrival-instructions-consent-gate.test.ts matches this line verbatim, because
// D-12's exclusion has to be visibly the SHARED predicate on this page rather
// than a hand-rolled filter. Folding it into the import below would satisfy the
// compiler and break the guard.
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import { MEMBER_GUEST_MODULE_KEY } from "@/lib/member-guest-consent";
import { classifyMemberGuestConsent } from "@/lib/member-guest-consent";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { loadMemberGuestSettings } from "@/lib/member-guest-settings";
import { resolveMemberGuestNameSearchAccess } from "@/lib/member-guest-find";
import { resolveOtherLodgeRateEligibleGuestIds } from "@/lib/membership-type-policy";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import { getSeasonYear } from "@/lib/utils";
import { getPublicOtherLodges } from "@/lib/booking-request";
import { eachDateOnlyInRange, getTodayDateOnly } from "@/lib/date-only";
import {
  bookingManagementAuthorizationRole,
  hasAdminAreaAccess,
} from "@/lib/admin-permissions";
import {
  OrganiserGroupBookingCard,
  type OrganiserGroupState,
} from "@/components/group-booking/organiser-group-booking-card";

const historyToneClasses: Record<BookingHistoryTone, string> = {
  default: "border-border bg-muted text-muted-foreground",
  success: "border-success-6 bg-success-3 text-success-11",
  warning: "border-warning-6 bg-warning-3 text-warning-11",
  danger: "border-danger-6 bg-danger-3 text-danger-11",
};

// States with a self-contained outcome worth surfacing as a banner. Active
// states (payable / under_review) already have their own dedicated UI below.
const NARRATIVE_BANNER_STATES = new Set<BookingNarrativeState>([
  "paid",
  "bumped",
  "cancelled_pre_payment",
  "cancelled_post_payment",
  "declined",
]);

const narrativeBannerClasses: Record<string, string> = {
  paid: "border-success-6 bg-success-3 text-success-11",
  bumped: "border-info-6 bg-info-3 text-info-11",
  cancelled_pre_payment: "border-warning-6 bg-warning-3 text-warning-11",
  cancelled_post_payment: "border-warning-6 bg-warning-3 text-warning-11",
  declined: "border-danger-6 bg-danger-3 text-danger-11",
};

// Candidate anchors for this long, mostly-conditional page. SectionNav prunes
// any whose target id is absent from the DOM after mount, so listing the full
// set here (rather than re-deriving each card's render condition) is safe.
const BOOKING_SECTIONS: SectionNavItem[] = [
  { id: "details", label: "Booking Details" },
  // #2307: the member-guest consent card — present only while the viewer's own
  // consent is being asked for; the request email deep-links to #consent.
  { id: "consent", label: "Consent" },
  { id: "non-member-guests", label: "Non-member Guests" },
  { id: "group", label: "Group Booking" },
  { id: "arrival", label: "Arrival Time" },
  { id: "room-request", label: "Room Request" },
  /*
   * Admin-only (#2252). Unlike every other candidate here, this one is NOT left
   * to SectionNav's post-mount pruning: pruning happens after hydration, so a
   * member's server-rendered rail really did contain a "Bed Allocation" link
   * that then vanished (#2252 review). The page knows both halves of the gate
   * server-side, so it filters this entry out before render — see
   * `showBedAllocationPanel` below. Pruning stays as the backstop for the
   * genuinely client-unknowable cases.
   */
  { id: "bed-allocation", label: "Bed Allocation" },
  { id: "directions", label: "Getting There" },
  { id: "payment", label: "Payment" },
  { id: "cancellation", label: "Cancellation" },
  { id: "notes", label: "Notes" },
  { id: "transaction-history", label: "Transaction History" },
];

export default async function BookingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ returnTo?: string | string[] }>;
}) {
  const { id } = await params;
  const query = searchParams ? await searchParams : {};
  const session = await auth();
  if (!session) redirect("/login");
  const isAdmin = hasAdminAccess(session.user);
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) resolves to ADMIN
  // so the edit policy and the BookingEditor treat them as acting on-behalf of
  // the member — matching the widened /api/bookings/[id]/modify authority. A
  // Full Admin already resolves to ADMIN; member / read-only viewers stay USER.
  const viewerAuthorizationRole = bookingManagementAuthorizationRole(session.user);

  const booking = await prisma.booking.findUnique({
    where: { id },
    include: {
      // Deterministic order (#2266 MED-4): the edit panel derives promo
      // beneficiary bindings and pricing rows from this list, so it must be
      // the same order the modify/modify-quote fetches use.
      guests: {
        include: { nights: { select: { stayDate: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      payment: {
        // #2350: every Payment scalar as before, plus the most recent ADDITIONAL
        // transaction so the admin panel can say when the outstanding extra was
        // raised (the summary columns only describe the latest one).
        include: {
          transactions: {
            where: { kind: "ADDITIONAL" },
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
      member: { select: { firstName: true, lastName: true } },
      lodge: { select: { name: true } },
      // Admin capacity hold (#1764): who placed it, for the admin tools card.
      adminCapacityHoldBy: { select: { firstName: true, lastName: true } },
      // Exclusive whole-lodge hold (#121): who set it, for the admin tools card.
      wholeLodgeHoldBy: { select: { firstName: true, lastName: true } },
      // "No emails" switch (#2258/#2259): who turned it on, named on the
      // admin-only control. The scalar columns come with the `include` above.
      noEmailsBy: { select: { firstName: true, lastName: true } },
      // Request-converted PENDING holds capacity (#1254); the admin hold
      // controls need the natural-holding answer to hide Release correctly.
      originBookingRequest: { select: { id: true } },
      // Cross-lodge waitlist offer (ADR-004): named on the offer card.
      waitlistOfferedLodge: { select: { name: true } },
      requestedRoom: {
        select: { id: true, name: true, active: true },
      },
      promoRedemption: {
        include: {
          promoCode: {
            select: {
              code: true,
              type: true,
              description: true,
              internal: true,
              workPartyEvent: { select: { name: true } },
            },
          },
        },
      },
      creditsFromCancellation: {
        select: {
          amountCents: true,
          description: true,
        },
      },
      modifications: {
        orderBy: { createdAt: "desc" },
      },
      refundRequests: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          reason: true,
          requestedAmountCents: true,
          approvedAmountCents: true,
          adminNotes: true,
          createdAt: true,
          reviewedAt: true,
        },
      },
      changeRequests: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          reason: true,
          adminNotes: true,
          requestedChanges: true,
          createdAt: true,
          reviewedAt: true,
        },
      },
      createdBy: {
        select: { firstName: true, lastName: true },
      },
      deletedBy: {
        select: { firstName: true, lastName: true, email: true },
      },
      adminReviewedBy: {
        select: { firstName: true, lastName: true },
      },
      // Split-booking group (#738): the member booking links to its provisional
      // non-member child(ren); the child links back to its member booking.
      parentBooking: {
        select: { id: true, status: true, finalPriceCents: true },
      },
      linkedBookings: {
        select: {
          id: true,
          status: true,
          finalPriceCents: true,
          hasNonMembers: true,
          // #1975: dates for the "Your non-member guests" section — shown only
          // when they differ from the parent's stay dates.
          checkIn: true,
          checkOut: true,
          guests: { select: { id: true } },
          // Discriminates a genuine #738 split child from a #796 group joiner
          // (joiners also carry parentBookingId but always have a join row).
          groupBookingJoin: { select: { id: true } },
        },
      },
      // Group booking the owner organises on this booking (#796+). Drives the
      // organiser management card: join code, share link, open/close and (for
      // ORGANISER_PAYS) the combined settlement.
      groupBookingAsOrganiser: {
        select: {
          joinCode: true,
          status: true,
          paymentMode: true,
          joinDeadline: true,
          maxJoiners: true,
          settlement: {
            select: { status: true, amountCents: true, paidAt: true },
          },
          joins: {
            select: {
              id: true,
              isMember: true,
              contactFirstName: true,
              contactLastName: true,
              joinerMember: { select: { firstName: true, lastName: true } },
              booking: {
                select: {
                  status: true,
                  finalPriceCents: true,
                  guests: { select: { id: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!booking) notFound();
  if (booking.deletedAt && !isAdmin) notFound();
  const isBookingOwner = booking.memberId === session.user.id;
  // The viewer's OWN guest row, kept rather than thrown away: its consent state
  // decides what operational detail (the door code, below) this viewer may see.
  const viewerGuestRow =
    booking.guests.find((guest) => guest.memberId === session.user.id) ?? null;
  const isLinkedGuestViewer = !isBookingOwner && !isAdmin && viewerGuestRow !== null;
  const canManageBooking = isBookingOwner || isAdmin;
  // Issue #1289: Booking Officer / Read-only Admin reach the admin bookings
  // list and calendar (gated on bookings-area view), so the member-facing
  // detail route must admit the same viewers read-only for list/detail parity.
  // This is a genuinely read-only path (same shape as isLinkedGuestViewer):
  // every write/cancel/pay/modify/notes/admin-tools control below stays gated
  // on canManageBooking or isAdmin, so this predicate never widens a mutation.
  const canViewAsAdmin = hasAdminAreaAccess(session.user, {
    area: "bookings",
    level: "view",
  });
  if (!canManageBooking && !isLinkedGuestViewer && !canViewAsAdmin) {
    redirect("/bookings");
  }
  // Issue #1313 (option A2): a Booking Officer (the ADMIN_BOOKINGS bundle carries
  // bookings:edit) may operate the admin-tooling cluster AND the member-facing
  // write controls on ANY booking, not just one they own. The admin-tooling
  // controls front routes under /api/admin/bookings/* (copy,
  // confirm-pending-guests, admin requested-room) that already authorize on
  // bookings:edit. The member-facing /api/bookings/[id]/* routes (cancel, modify,
  // notes, arrival-time) are now widened to also accept bookings:edit (this PR),
  // so their buttons include canAdminEditBookings and flow through the same
  // admin-on-behalf path as a Full Admin (see actingOnBehalf below) — the button
  // and its backing API widen together, never a button ahead of its route.
  const canAdminEditBookings = hasAdminAreaAccess(session.user, {
    area: "bookings",
    level: "edit",
  });
  // Full Admins and Booking Officers both see the admin-operational tooling.
  const canSeeAdminTools = isAdmin || canAdminEditBookings;
  // Issue #1313 (option A2): a non-owner Full Admin OR Booking Officer cancels /
  // modifies on behalf of the member. Both flow through the SAME admin-on-behalf
  // semantics (suppress owner second-person framing, policy wording, and the
  // suppress-customer-notification path) rather than a separate officer code
  // path — so this one predicate replaces the earlier isAdmin-only actingAsAdmin.
  const actingOnBehalf = (isAdmin || canAdminEditBookings) && !isBookingOwner;
  // A non-owner admin-type viewer (Full Admin, Booking Officer, or read-only
  // admin) must not be addressed with owner second-person copy ("your place /
  // your stay") — issue #1289. Linked guests keep the member framing.
  const nonOwnerAdminViewer = !isBookingOwner && canViewAsAdmin;
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
    // The clock is read HERE, by name, and passed down: the card resolver and
    // its refusal prediction are pure, so "today" is this page's fact to state
    // rather than something a helper quietly looks up for itself.
    today: getTodayDateOnly(),
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
  // THIS booking's lodge identity, not the club default's. The ask card, the
  // arrival instructions and the booking-message merge data (#2919) all want it
  // and the last is unconditional, so it is loaded once rather than twice.
  const bookingLodgeEmailSettings = await loadEmailMessageSettingsForLodge(
    booking.lodgeId,
  );
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

  const bookingAuditLogs = await prisma.auditLog.findMany({
    where: {
      targetId: booking.id,
      action: {
        in: [
          "booking.payment.confirmed",
          "booking.payment.failed",
          "booking.modification.payment.confirmed",
          "booking.modification.payment.failed",
          // #2397: the cash / off-Xero settlement of an outstanding price
          // increase, so the extra is never absorbed silently.
          "booking-payment.manual-payment.additional-settled",
          // #2265 (#2319 door 2): the settle-time note telling the member their
          // saved credit choice was not applied and is still on their account.
          "booking.credit_election.unapplied",
          "booking.cancel",
          "booking.delete.draft",
          "booking.delete.cancelled.soft",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      action: true,
      details: true,
      createdAt: true,
    },
  });

  // Durable lifecycle events (issue #740) drive the same plain-language
  // narrative shown on the public payment-link page, so guests and admins read
  // identical wording for every booking state.
  const bookingEvents = await prisma.bookingEvent.findMany({
    where: { bookingId: booking.id },
    orderBy: { occurredAt: "asc" },
    select: {
      id: true,
      type: true,
      occurredAt: true,
      amountCents: true,
      reason: true,
      snapshot: true,
    },
  });
  const bookingNarrative = resolveBookingNarrative({
    booking: {
      status: booking.status,
      finalPriceCents: booking.finalPriceCents,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      firstName: booking.member.firstName,
      adminReviewStatus: booking.adminReviewStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewReason: booking.adminReviewReason,
    },
    events: bookingEvents.map(
      (event): NarrativeEvent => ({
        type: event.type,
        occurredAt: event.occurredAt,
        amountCents: event.amountCents,
        reason: event.reason,
        snapshot: event.snapshot,
      })
    ),
  });

  const nights = Math.ceil(
    (new Date(booking.checkOut).getTime() - new Date(booking.checkIn).getTime()) /
      (1000 * 60 * 60 * 24)
  );

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
  const stayHasStarted = bookingStayHasStarted(booking.checkIn);
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) may cancel any
  // booking; the /api/bookings/[id]/cancel route authorizes bookings:edit and the
  // notes editor below is gated on this same predicate.
  const canCancel =
    (canManageBooking || canAdminEditBookings) &&
    !isDeleted &&
    (isAdmin || !stayHasStarted) &&
    ["PAYMENT_PENDING", "CONFIRMED", "PAID", "PENDING", "WAITLISTED", "WAITLIST_OFFERED"].includes(booking.status);
  const showArrivalTime = !isDeleted && !["CANCELLED", "COMPLETED"].includes(booking.status);
  const modules = await loadEffectiveModuleFlags();
  const bookingMessages = await loadPublicBookingMessages();
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
  const cancellationSettlement = booking.payment
    ? getCancellationSettlementBreakdown(
        booking.payment.refundedAmountCents,
        booking.creditsFromCancellation
      )
    : null;
  const paymentDisplay = booking.payment
    ? getPaymentDisplayStatus({
        bookingStatus: booking.status,
        paymentStatus: booking.payment.status,
        refundedAmountCents: booking.payment.refundedAmountCents,
        credits: booking.creditsFromCancellation,
      })
    : null;
  const internetBankingPayment =
    booking.payment?.source === "INTERNET_BANKING" ? booking.payment : null;
  // Switch-at-pay: a card PAYMENT_PENDING booking can move to Internet Banking
  // when the module is on (an organiser-settled or already-IB booking cannot).
  const canSwitchToInternetBanking =
    modules.xeroIntegration &&
    modules.internetBankingPayments &&
    !isDeleted &&
    canManageBooking &&
    !internetBankingPayment &&
    booking.status === "PAYMENT_PENDING" &&
    !booking.organiserSettled &&
    booking.finalPriceCents > 0;
  const originalPaymentCaptured = hasCapturedPayment(booking.payment);
  const retainedAfterCancellationCents = booking.payment
    ? Math.max(
        booking.payment.amountCents - booking.payment.refundedAmountCents,
        0
      )
    : 0;
  const latestRefundAppeal = booking.refundRequests[0] ?? null;
  const maxRefundableCents = getRemainingRefundableCents(booking.payment);
  // #2008 — the #1992 duplicate-capture auto-refund is an ADMIN-ONLY history
  // entry: it never enters the shared member/guest narrative, and only admin
  // viewers see it on the timeline. Gating the data feed (not just the render)
  // keeps it off member-facing surfaces entirely.
  const duplicateCaptureRefunds = canSeeAdminTools
    ? bookingEvents
        .filter((event) => isDuplicateCaptureRefundEvent(event))
        .map((event) => ({
          id: event.id,
          occurredAt: event.occurredAt,
          amountCents: event.amountCents ?? 0,
          duplicatePaymentIntentId:
            asDuplicateCaptureRefundSnapshot(event.snapshot)
              ?.duplicatePaymentIntentId ?? null,
        }))
    : [];

  const bookingHistory = buildBookingHistoryItems({
    createdAt: booking.createdAt,
    payment: booking.payment
      ? {
          status: booking.payment.status,
          amountCents: booking.payment.amountCents,
          refundedAmountCents: booking.payment.refundedAmountCents,
          additionalAmountCents: booking.payment.additionalAmountCents,
          additionalPaymentStatus: booking.payment.additionalPaymentStatus,
          // #2350: dates the "additional payment requested" timeline entry from
          // the obligation itself rather than the payment row's last touch.
          latestAdditionalTransactionCreatedAt:
            booking.payment.transactions[0]?.createdAt ?? null,
          createdAt: booking.payment.createdAt,
          updatedAt: booking.payment.updatedAt,
        }
      : null,
    modifications: booking.modifications,
    refundRequests: booking.refundRequests,
    auditLogs: bookingAuditLogs,
    duplicateCaptureRefunds,
  });

  // #2266: the edit panel's account-credit card (its own card above the
  // Return-method radio — owner-decided placement). Only statuses whose stored
  // election (#2265) a pay-time consumer will honour are eligible; PENDING is
  // deliberately out (see CREDIT_ELECTION_WRITABLE_STATUSES in
  // booking-credit-election.ts), as are organiser-settled bookings and anything
  // with captured money. The balance shown is the BOOKING OWNER's, so an admin
  // editing on behalf offers the member's credit, not their own.
  const creditElectionEligible =
    canModify &&
    !isDeleted &&
    ["DRAFT", "AWAITING_REVIEW", "PAYMENT_PENDING"].includes(booking.status) &&
    !booking.organiserSettled &&
    !hasCapturedPayment(booking.payment);
  const editorCredit = creditElectionEligible
    ? {
        availableCents: await getMemberCreditBalance(booking.memberId),
        electionCents: booking.creditElectionCents,
        appliedCents: await deriveBookingAppliedCreditCents(booking.id),
      }
    : null;

  /**
   * MG4 (#2309): the edit panel's "+ Add Member Guest" surface, decided HERE.
   *
   * SERVER-SIDE, ON PURPOSE. The module flag and the policy singleton are
   * settings reads, and `BookingEditorData` is serialised into a client
   * component's payload — so the panel is handed an answer rather than left to
   * guess one and render a finder whose routes then 404.
   *
   * ABSENT WHEN THE MODULE IS OFF, as a conditional SPREAD rather than a
   * false-valued key. React Flight serialises the key as well as the value, so
   * `memberGuest: undefined` would still ship `"memberGuest":"$undefined"` and
   * change every club's payload; omitting the key leaves a non-adopting club's
   * booking page byte-for-byte what it was.
   *
   * TWO READERS, ONE FIELD. `openSearchEnabled` answers "may THIS reader search
   * by name", which is a different question for each: the club's own privacy
   * setting for a member, and `membership:view` for an officer (owner decision
   * D-20 — an admin picker is not bound by a member-facing privacy switch, and
   * the #1376 persona without membership access falls back to exact email).
   *
   * AND "WHICH READER" IS DECIDED BY THE SAME PREDICATE THE PANEL ROUTES ON,
   * which is `viewerAuthorizationRole === "ADMIN"` — i.e. `bookings:edit`. It
   * was previously `isAdmin || canViewAsAdmin` (`bookings:view`), and the two
   * disagree over a real, shipped persona: a read-only bookings viewer. One
   * holding `membership:view` was handed a name type-ahead while the panel sent
   * them down the MEMBER routes, where the name search 404s unless the club
   * turned open search on — a search box that silently fails. One WITHOUT
   * `membership:view` was denied name search on a club that had deliberately
   * turned it on for every member, including them. Deriving both from one
   * predicate is the fix: whoever is not in admin mode is a member for this
   * purpose and gets exactly the club's member-facing answer.
   *
   * THE FAMILY BOUNDARY IS NOT SHIPPED FROM HERE, and that is deliberate rather
   * than an omission. The panel already fetches the booking owner's family list
   * for its quick-add row — `/api/members/family` for a member, the booking's
   * `eligible-family` for an officer — so it holds the same set this page would
   * have had to query for, and reading it from the row it already renders means
   * the panel's idea of "my family" cannot disagree with the buttons above it.
   * That is the create wizard's rule (`predictMemberGuestConsent`), applied to
   * the second surface rather than re-derived for it.
   */
  const memberGuestModuleEnabled = await isEffectiveModuleEnabled(
    MEMBER_GUEST_MODULE_KEY,
  );
  const memberGuestSettings = memberGuestModuleEnabled
    ? await loadMemberGuestSettings()
    : null;
  // `viewerAuthorizationRole === "ADMIN"` and nothing else: it is the exact
  // value shipped as `viewerRole` below, and the value the panel branches on to
  // choose the admin picker's routes. See the note above.
  const canSearchMembersByName = resolveMemberGuestNameSearchAccess({
    actingAsAdmin: viewerAuthorizationRole === "ADMIN",
    hasMembershipView: hasAdminAreaAccess(session.user, {
      area: "membership",
      level: "view",
    }),
    clubNameSearchEnabled: memberGuestSettings?.openMemberSearchEnabled ?? false,
  });
  /**
   * #2978: the season the other-lodge eligibility fence is judged in — resolved
   * AUTHORITATIVELY rather than from whatever happened to warm the cache.
   *
   * `getSeasonYear` reads the process-level financial-year cache in
   * `financial-year.ts`, which serves the March default until a server path
   * seeds it. Every WRITE path reaches `refreshFinancialYearConfig` through
   * `resolveSubscriptionLockoutMode`; a page render does not, so on a cold
   * process a club with any other year-end month would have this page offer
   * ticks judged in one season while `modify-quote` — which reseeds before its
   * own `getSeasonYear` — fences them in another. The officer would see a tick
   * box and be refused when they used it, which is exactly what acceptance
   * criterion 2 of #2978 exists to prevent. No money is at stake (pricing
   * re-checks eligibility itself), but `subscription-lockout-enforcement.ts` and
   * `adult-member-hosting-review.ts` both refuse to trust this cache in these
   * same words, and a season answer that depends on process history is not one
   * to trust here either.
   *
   * Reseeded only for an admin, since only the admin spread below asks the
   * question. `refreshFinancialYearConfig` reads the club's stored override and,
   * with none set, the connected organisation's year end through its own cache.
   */
  if (viewerAuthorizationRole === "ADMIN") {
    await refreshFinancialYearConfig();
  }
  const editorData: BookingEditorData = {
    id: booking.id,
    checkIn: formatDateOnly(new Date(booking.checkIn)),
    checkOut: formatDateOnly(new Date(booking.checkOut)),
    nights,
    status: booking.status,
    guests: booking.guests.map((g) => ({
      id: g.id,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId,
      stayStart: formatDateOnly(g.stayStart),
      stayEnd: formatDateOnly(g.stayEnd),
      priceCents: g.priceCents,
      // Other Lodges epic: the reciprocal other-club rate tick. Sent to every
      // viewer because it is not a secret — it is what a non-member row is being
      // charged — but only an admin is offered the control that changes it.
      otherLodgeMember: g.otherLodgeMember,
      nights: g.nights.map((n) => formatDateOnly(n.stayDate)),
      // #2307 (MG2-M-2): null for family and non-member rows — no badge, no
      // layout change. A conditional spread so those rows' serialised payload
      // carries no `consent` key at all (React Flight serialises the key too).
      ...(() => {
        const consent = describeMemberGuestConsentBadge({
          guest: g,
          audience: consentBadgeAudience,
          responderName: g.consentRespondedByMemberId
            ? (consentResponderNameById.get(g.consentRespondedByMemberId) ?? null)
            : null,
        });
        // MG4 (#2309) adds the SUB-STATE beside the badge, because the edit
        // panel needs to tell "still being asked" from "the club put them
        // here" and a tone of `"ok"` covers both plus every ordinary consent.
        // Classified here, from the persisted columns, rather than inferred
        // client-side from a label string an admin can override.
        return consent
          ? { consent: { ...consent, subState: classifyMemberGuestConsent(g, g.memberId) } }
          : {};
      })(),
    })),
    viewerRole: viewerAuthorizationRole,
    totalPriceCents: booking.totalPriceCents,
    discountCents: booking.discountCents,
    promoAdjustmentCents: booking.promoAdjustmentCents,
    finalPriceCents: booking.finalPriceCents,
    promo: booking.promoRedemption?.promoCode
      ? {
          code: booking.promoRedemption.promoCode.code,
          type: booking.promoRedemption.promoCode.type,
          description: booking.promoRedemption.promoCode.description,
          workPartyEventName:
            booking.promoRedemption.promoCode.workPartyEvent?.name ?? null,
        }
      : null,
    hasNonMembers: booking.hasNonMembers,
    nonMemberHoldUntil: booking.nonMemberHoldUntil?.toISOString() ?? null,
    canEditNonMemberGuestNames,
    canFixNonMemberGuestNameTypos,
    ...(memberGuestSettings
      ? {
          memberGuest: {
            enabled: true,
            openSearchEnabled: canSearchMembersByName,
            approvalRequired: memberGuestSettings.approvalRequired,
          },
        }
      : {}),
    // #2337: offer the placeholder→member link only to an admin/officer viewing a
    // genuine MEMBER whole-lodge booking — the exact fence the save path enforces
    // (isMemberWholeLodgeBooking, admin-only). Computed server-side so the panel
    // never shows a control the save would refuse. Absent for every other booking.
    ...(viewerAuthorizationRole === "ADMIN" &&
    (await isMemberWholeLodgeBooking(prisma, booking.id))
      ? { memberWholeLodge: true }
      : {}),
    // Other Lodges epic: the partner lodge this booking claims, plus the
    // registry the officer picks from.
    //
    // The LIST is admin-only and a conditional spread, on the same reasoning as
    // `noEmails` above: this object is serialised into the RSC payload of a
    // client component, and React Flight ships the key as well as the value, so
    // a member reading the wire would otherwise learn the whole other-lodge
    // registry exists and what is in it. The stored ELECTION rides the guest
    // rows either way, because it is what the member is being charged.
    otherLodgeId: booking.otherLodgeId,
    ...(viewerAuthorizationRole === "ADMIN"
      ? {
          otherLodges: await getPublicOtherLodges(prisma),
          // #2978: which guests may be ticked. Resolved server-side because the
          // answer needs membership types and the unpaid-subscription set, and
          // shipped in the SAME admin-only spread as the registry above for a
          // second reason: an ineligible row can be ineligible because that
          // member's subscription is unpaid, so this list must not reach an
          // ordinary viewer. Costs no query on the common all-non-members
          // booking, which the helper short-circuits.
          otherLodgeRateEligibleGuestIds: [
            ...(await resolveOtherLodgeRateEligibleGuestIds(prisma, {
              seasonYear: getSeasonYear(booking.checkIn),
              guests: booking.guests,
            })),
          ],
        }
      : {}),
    // #2104: an already-flagged/reviewed booking must not re-prompt the member
    // for a justification when the guest list shuffles — the edit panel keys the
    // proactive field on these (the server only demands a reason on the FIRST
    // trip; see resolveModifyReviewUpdate).
    requiresAdminReview: booking.requiresAdminReview,
    adminReviewStatus: booking.adminReviewStatus,
    /*
      #2259: consumed only by the edit panel's admin-only notify dialog. Gated
      on the SAME predicate the panel gates its read on, and gated HERE rather
      than only in the panel, because this object is serialised into the RSC
      payload of a client component.

      A conditional SPREAD, not a conditional value. React Flight serialises the
      KEY as well as the value, so `noEmails: undefined` ships `"noEmails":
      "$undefined"` and `noEmails: false` ships `"noEmails":false` — either way a
      member reading the wire learns the switch exists, even though they never
      learn its state. The spread omits the key entirely, so the payload of a
      member's booking is byte-for-byte what it was before this feature.
    */
    ...(viewerAuthorizationRole === "ADMIN"
      ? { noEmails: booking.noEmails }
      : {}),
    editPolicy: {
      // This is the member (non-override) policy, so mode is never
      // "admin-override" here; the ternary only narrows the widened union.
      mode: editPolicy.mode === "admin-override" ? null : editPolicy.mode,
      today: formatDateOnly(editPolicy.today),
      editableFrom: editPolicy.editableFrom
        ? formatDateOnly(editPolicy.editableFrom)
        : null,
      checkInEditable: editPolicy.checkInEditable,
      adminOverrideAvailable: canAdminOverride,
    },
    // #2266: null (rather than omitted) when ineligible, so the panel renders
    // no credit card at all for a booking whose election nothing would honour.
    credit: editorCredit,
    // #2266: the booking OWNER's member id — the shared PromoCodeInput
    // validates on-behalf promo entry against the member's assignments, not
    // the acting admin's.
    memberId: booking.memberId,
    // #2266: promo lodge restrictions validate against THIS booking's lodge.
    lodgeId: booking.lodgeId,
  };
  const backHref = resolveInternalReturnPath(
    query.returnTo,
    isAdmin ? "/admin/bookings" : "/bookings"
  );
  const canDeleteDraft =
    !isDeleted &&
    isDraft &&
    (isAdmin || booking.memberId === session.user.id);
  const canSoftDeleteCancelled =
    !isDeleted &&
    booking.status === "CANCELLED" &&
    isAdmin;
  // #2307 (domain invariant D-12): a member guest whose consent is still
  // PENDING — or who said no, or let the request lapse — is NOT operationally
  // present. D-11 lets them open this page so they can answer the question, and
  // that is all it lets them do. The arrival instructions are the club's
  // operational detail for people who are actually coming, and they carry the
  // LODGE DOOR CODE, which the repo classifies as sensitive opt-in data. So the
  // same predicate that keeps an unconsented row off the kiosk, the chore
  // roster and the arrival emails gates it here too. The booking OWNER is
  // unaffected: it is their booking, and they have no consent row of their own.
  const showMemberArrivalInstructions =
    !isDeleted &&
    (isBookingOwner ||
      (isLinkedGuestViewer &&
        isOperationallyPresentConsent(viewerGuestRow?.consentStatus))) &&
    ["CONFIRMED", "PAID"].includes(booking.status);
  // Arrival instructions must carry THIS booking's lodge identity (door
  // code, travel note), not the default lodge's — and stay null, so the door
  // code never reaches the page at all, whenever the gate above says no.
  const memberArrivalInstructions = showMemberArrivalInstructions
    ? bookingLodgeEmailSettings
    : null;

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
  // #1967: once the member's own place is settled by Internet Banking there is
  // no card on file for the later guest charge, so keep the guest-payment-link
  // affordance visible AFTER the switch too (the pre-switch warning below only
  // renders while the switch button is still available). Owner-only: the copy
  // is second-person and the emailed link goes to the member.
  const showGuestPaymentLinkStandalone =
    !isDeleted &&
    isBookingOwner &&
    hasProvisionalChildren &&
    Boolean(internetBankingPayment) &&
    booking.status !== "CANCELLED";
  const isFlaggedProvisional =
    !booking.parentBookingId &&
    booking.status === "PENDING" &&
    booking.cancelIfGuestsBumped &&
    booking.hasNonMembers;

  // Issue #777: a provisional/on-hold PENDING booking shows no pay control,
  // which left testers unsure whether one should exist. The "Save Payment
  // Method" card below already explains the save-card flow, so the on-hold
  // explanation is only needed when that card is not showing.
  // Member self-service "Save Payment Method" card (#1303): gated positively on
  // the booking owner so a non-owner admin never sees it. An admin entering
  // their own card on a member's booking is a footgun with no legitimate use,
  // and the owner-positive gate is robust to read-only admin viewers (#1289).
  const showSavePaymentMethodCard =
    isBookingOwner &&
    !isDeleted &&
    !internetBankingPayment &&
    booking.status === "PENDING" &&
    (!booking.payment || !booking.payment.stripeSetupIntentId);
  // Suppress when a more specific provisional banner already explains the
  // on-hold/no-charge state (the split-booking child and the bumped-guest
  // flagged-provisional notices both render near the top of the page). Also
  // suppress for any non-owner admin-type viewer: the notice is owner-second-
  // person ("your place/your guests/your stay"), so a Full Admin, Booking
  // Officer, or read-only admin viewing someone else's booking never sees it
  // (#1303/#1289). nonOwnerAdminViewer subsumes the earlier actingAsAdmin case.
  const showPaymentOnHoldNotice =
    !isDeleted &&
    !nonOwnerAdminViewer &&
    booking.status === "PENDING" &&
    !showSavePaymentMethodCard &&
    !isProvisionalChild &&
    !isFlaggedProvisional;

  // The Stripe payment card and the payment-required banner render under the
  // same condition so the banner can never point at a missing card. Member
  // self-service "Complete Payment" (#1303): gated positively on the booking
  // owner so a non-owner admin never sees the member pay/banner controls.
  const showCompletePaymentCard =
    isBookingOwner &&
    !isDeleted &&
    !internetBankingPayment &&
    isPaymentOwedBookingStatus(booking.status) &&
    (!booking.payment || booking.payment.status !== "SUCCEEDED");

  // Issue #778: surface auto-applied member credit (display only). Credit nets
  // off the booking price, so amount due = finalPriceCents - creditAppliedCents.
  const creditAppliedCents = booking.payment?.creditAppliedCents ?? 0;
  const showCreditApplied =
    canManageBooking &&
    creditAppliedCents > 0 &&
    isPaymentOwedBookingStatus(booking.status) &&
    booking.payment?.status !== "SUCCEEDED";
  const amountDueAfterCreditCents = Math.max(
    booking.finalPriceCents - creditAppliedCents,
    0
  );
  const bookingMessageData = {
    bookerFirstName: booking.member.firstName,
    bookerFullName: `${booking.member.firstName} ${booking.member.lastName}`,
    // Member-facing: these two land in the booking messages and the emails
    // built from them, so they keep the long "16 April 2026" form the club has
    // always sent (owner decision, #2264). Admin-side dates on this page use
    // the medium `formatNZDate`.
    checkIn: formatNZLongDate(booking.checkIn),
    checkOut: formatNZLongDate(booking.checkOut),
    guestCount: booking.guests.length,
    amountDue: formatCents(amountDueAfterCreditCents),
    amountPaid: booking.payment ? formatCents(booking.payment.amountCents) : "",
    refundAmount: cancellationSettlement
      ? formatCents(cancellationSettlement.refundToOriginalMethodCents)
      : "",
    creditAmount: cancellationSettlement
      ? formatCents(cancellationSettlement.accountCreditCents)
      : "",
    creditRestored: cancellationSettlement
      ? formatCents(cancellationSettlement.restoredAppliedCreditCents)
      : "",
    retainedAmount: cancellationSettlement
      ? formatCents(retainedAfterCancellationCents)
      : "",
    changeFee: booking.payment ? formatCents(booking.payment.changeFeeCents) : "",
    paymentReference: internetBankingPayment?.reference ?? "",
    xeroInvoiceNumber: internetBankingPayment?.xeroInvoiceNumber ?? "",
    holdUntil: internetBankingPayment?.internetBankingHoldUntil
      ? formatNZDateTime(internetBankingPayment.internetBankingHoldUntil)
      : "",
    holdDays: "",
    minimumDaysBeforeCheckIn: "",
    bookingStatus: booking.status,
    // #2919: the four club-level tokens the admin preview renders and this page
    // supplied none of, so an inserted {{CLUB_LODGE_NAME}} showed a lodge name
    // in preview and a blank to the member. Resolved from THIS booking's lodge.
    CLUB_LODGE_NAME: bookingLodgeEmailSettings.lodgeName,
    CLUB_NAME: bookingLodgeEmailSettings.clubName,
    BASE_URL: bookingLodgeEmailSettings.publicUrl,
    SUPPORT_EMAIL: bookingLodgeEmailSettings.supportEmail,
  };
  const renderBookingMessage = (key: keyof typeof bookingMessages) =>
    renderBookingMessageTemplate(bookingMessages[key], bookingMessageData);
  const paymentRequiredDescription = renderBookingMessage(
    "booking.detail.paymentRequired.description",
  );
  // #2263: only the Xero-on wording may claim an invoice was emailed. With the
  // module off nothing raises one, so the member is told the club will send it —
  // which is exactly what the delivery-locked manual-invoice admin alert asks an
  // officer to do. The reference and amount are true either way.
  const internetBankingPendingDescription = renderBookingMessage(
    modules.xeroIntegration
      ? "booking.detail.internetBanking.pending"
      : "booking.detail.internetBanking.pendingNoXero",
  );
  const switchToInternetBankingDescription = renderBookingMessage(
    "booking.detail.switchToInternetBanking",
  );
  const refundAppealDescription = renderBookingMessage(
    "cancellation.refundAppeal.description",
  );

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
        joiners: organiserGroup.joins
          .filter((join) => join.booking)
          .map((join) => ({
            id: join.id,
            name: join.joinerMember
              ? `${join.joinerMember.firstName} ${join.joinerMember.lastName}`.trim()
              : [join.contactFirstName, join.contactLastName]
                  .filter(Boolean)
                  .join(" ") || "Guest",
            guestCount: join.booking?.guests.length ?? 0,
            status: join.booking?.status ?? null,
            priceCents: join.booking?.finalPriceCents ?? null,
            isMember: join.isMember,
          })),
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

  const providerMismatches = isAdmin
    ? await getBookingProviderMismatches(booking.id)
    : [];

  /*
    #2259 (owner decision D10) — the "No emails" switch and the persistent
    record of what it has actually withheld.

    Read ONLY behind `canSeeAdminTools`, exactly like the exclusive-hold
    conflicts above, and for the same reason stated more strongly: a member must
    never learn this switch exists. Not the control, not the banner, not a
    count, not a field on anything rendered to them. Computing the list outside
    the gate would put withheld subjects one careless prop away from a member's
    screen, so the query does not run for them at all.

    The withheld rows are audit records, not a static sentence: the admin has to
    know WHICH messages the member never received in order to relay them — and
    that list includes the invoice emails Xero would have sent on our behalf,
    which are inside the same guarantee.
  */
  const withheldEmails = canSeeAdminTools
    ? await getWithheldBookingEmailSummary(booking.id)
    : { total: 0, groups: [] };
  const withheldEmailGroups = withheldEmails.groups.map((group) => ({
    templateName: group.templateName,
    label: group.label,
    count: group.count,
    subject: group.subject,
    latestAt: group.latestAt.toISOString(),
    remedy: group.remedy,
  }));
  const noEmailsState = canSeeAdminTools
    ? {
        noEmails: booking.noEmails,
        noEmailsAt: booking.noEmailsAt?.toISOString() ?? null,
        setByName: booking.noEmailsBy
          ? `${booking.noEmailsBy.firstName} ${booking.noEmailsBy.lastName}`
          : null,
        // Same predicate the setter evaluates, so the dialog's warning and the
        // route's response flag cannot disagree about what "live" means.
        hasLiveWaitlistOffer: bookingHasLiveWaitlistOffer(booking),
        // A silenced WAITLISTED entry is skipped for offers entirely, so that
        // consequence produces no withheld row and has to be stated up front.
        isWaitlisted: booking.status === "WAITLISTED",
      }
    : null;

  // B5 (#2262): cash / off-Xero payment controls. Advisory only — the settle
  // path re-derives every condition under lock(1) + the per-lodge lock — so a
  // stale page can cause a 409 and never a wrong write. Skipped for a deleted
  // booking, which settles nothing.
  const manualPaymentState =
    canSeeAdminTools && !isDeleted
      ? await getBookingManualPaymentState(booking.id)
      : null;

  /*
    #2649: the stranded zero-dollar waitlist confirm.

    The three cheap conditions — free, `PAYMENT_PENDING`, no payment record — are
    NOT the stranded shape on their own. Six other producers reach them, none of
    them a waitlist confirmation, including the `20260511113000` backfill
    migration, which has no price predicate at all. So the
    button is offered only where the route will accept it: on an unresolved
    `waitlist.confirm_offer_release_failed` report, the same provenance test the
    route re-runs under its locks (`findUnresolvedWaitlistStrandReport`). Without
    this the banner would state as fact — about an ordinary confirmed booking —
    that "the waitlist offer that created it has been used up".

    The audit read runs only when the cheap shape matches, which is rare, so an
    ordinary booking page issues no extra query. Admin-gated like every other
    tools-card input above.
  */
  const strandedWaitlistConfirmShape =
    canSeeAdminTools &&
    !isDeleted &&
    modules.waitlist &&
    booking.status === "PAYMENT_PENDING" &&
    booking.finalPriceCents === 0 &&
    !booking.payment;
  const showReturnToWaitlist = strandedWaitlistConfirmShape
    ? Boolean(await findUnresolvedWaitlistStrandReport(prisma, booking.id))
    : false;

  // Admin conflict surfacing (ADR-001 decision 1, issue #119): when this
  // booking exclusively holds the whole lodge, list the existing
  // capacity-holding bookings overlapping its nights so the officer can resolve
  // the clash. Admin-only — never computed or shown for members (decision 6).
  const exclusiveHoldConflicts =
    canSeeAdminTools && booking.wholeLodgeHold && booking.lodgeId
      ? [
          ...(await findOverlappingCapacityHoldingBookings(prisma, {
            lodgeId: booking.lodgeId,
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            excludeBookingId: booking.id,
          })),
          // Override-settle blind spot (ADR-001 decision 1, issue #177): also
          // list overridden-but-not-yet-holding overlaps (marked `overridden`)
          // so the officer keeps seeing the future settle onto the held nights,
          // matching what the exclusive-hold route surfaces at set time.
          ...(await findOverlappingOverriddenNonHoldingBookings(prisma, {
            lodgeId: booking.lodgeId,
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            excludeBookingId: booking.id,
          })),
        ]
      : [];

  // Surface the applicable cancellation refund schedule to the member up front
  // (#1371 F28): the exact per-booking amount already shows inside the cancel
  // flow, but the full tier schedule previously lived only in the admin policy
  // preview, so members first learned the refund consequences at cancel time.
  //
  // Only show the refund schedule when a payment has actually been captured —
  // otherwise the tier percentages imply a refund the member will never get.
  // For an unpaid-but-cancellable booking, say so plainly instead (owner review
  // of PR #1389).
  const showCancellationInfo = canCancel && !isDeleted;
  const cancellationSchedule =
    showCancellationInfo && originalPaymentCaptured
      ? describeCancellationSchedule(await loadCancellationPolicy(booking.checkIn))
      : undefined;
  const cancellationHasNoPayment = showCancellationInfo && !originalPaymentCaptured;

  return (
    <div className="lg:flex lg:gap-8">
      <SectionNav
        sections={BOOKING_SECTIONS.filter(
          (section) =>
            section.id !== "bed-allocation" || showBedAllocationPanel,
        )}
        className="mb-6 lg:mb-0"
      />
      {/* data-testid scopes content-only queries away from the SectionNav rail,
          whose anchor labels (e.g. "Payment") would otherwise be matched by
          loose getByText(...).first() locators. */}
      <div
        data-testid="booking-detail-content"
        className="min-w-0 max-w-2xl flex-1 space-y-6"
      >
      <ScrollToHash />
      {/* Render-null: feeds the four booking-help blocks into the global help
          widget (epic #2094 C2), replacing the retired BookingHelpDialog. */}
      <BookingHelpExtras
        cancellationSchedule={cancellationSchedule}
        cancellationHasNoPayment={cancellationHasNoPayment}
      />
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Booking Details</h1>
        <div className="flex items-center gap-2">
          <Link href={backHref}>
            <Button variant="outline">Back to Bookings</Button>
          </Link>
        </div>
      </div>

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
          hasSavedPaymentMethod={Boolean(
            booking.payment?.stripePaymentMethodId &&
              booking.payment?.stripeCustomerId,
          )}
          finalPriceCents={booking.finalPriceCents}
          providerMismatches={providerMismatches}
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

      {showCompletePaymentCard && (
        <div className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
          <p className="font-medium">Payment required</p>
          <p>{paymentRequiredDescription}</p>
          <p className="mt-1">
            <a href="#payment" className="font-medium underline">
              Go to payment
            </a>
          </p>
        </div>
      )}

      {isDeleted ? (
        <div className="rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11">
          <p className="font-medium">Deleted cancelled booking</p>
          <p>
            Deleted {booking.deletedAt ? formatNZDateTime(booking.deletedAt) : ""}
            {booking.deletedBy
              ? ` by ${booking.deletedBy.firstName} ${booking.deletedBy.lastName}`
              : ""}
            .
          </p>
          {booking.deletedReason ? (
            <p className="mt-1">Reason: {booking.deletedReason}</p>
          ) : null}
        </div>
      ) : null}

      {NARRATIVE_BANNER_STATES.has(bookingNarrative.state) ? (
        <div
          className={`space-y-1 rounded-md border px-4 py-3 text-sm ${
            narrativeBannerClasses[bookingNarrative.state] ??
            "border-border bg-muted text-foreground"
          }`}
        >
          <p className="font-medium">{bookingNarrative.headline}</p>
          <p>{bookingNarrative.message}</p>
          <p className="opacity-80">{bookingNarrative.nextStep}</p>
        </div>
      ) : null}

      {hasProvisionalChildren ? (
        <div className="space-y-1 rounded-md border border-info-6 bg-info-3 px-4 py-3 text-sm text-info-11">
          <p className="font-medium">
            {provisionalChildGuestCount} non-member guest
            {provisionalChildGuestCount === 1 ? "" : "s"} held provisionally
          </p>
          {nonOwnerAdminViewer ? (
            <p>
              The member&apos;s own place is confirmed once they pay for this
              booking. Their non-member guests are held in a linked provisional
              booking — <strong>no beds are reserved for them</strong> until
              they are confirmed and paid for closer to the stay.
            </p>
          ) : (
            <p>
              Your own place is confirmed once you pay for this booking. Your
              non-member guests are held in a linked provisional booking —{" "}
              <strong>no beds are reserved for them</strong> until they are
              confirmed and paid for closer to your stay. We&apos;ll be in touch
              before then.
            </p>
          )}
        </div>
      ) : null}

      {isProvisionalChild ? (
        <div className="space-y-1 rounded-md border border-info-6 bg-info-3 px-4 py-3 text-sm text-info-11">
          <p className="font-medium">Provisional non-member guests</p>
          <p>
            This is the non-member portion of{" "}
            {nonOwnerAdminViewer ? "the" : "your"} party, linked to{" "}
            {nonOwnerAdminViewer ? "the" : "your"}{" "}
            <Link
              href={`/bookings/${booking.parentBooking!.id}`}
              className="font-medium underline"
            >
              member booking
            </Link>
            . <strong>No beds are held</strong> for these guests until they are
            confirmed and paid for — nothing has been charged yet.
          </p>
        </div>
      ) : null}

      {isFlaggedProvisional ? (
        <div className="space-y-1 rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
          <p className="font-medium">Provisional booking — no beds held yet</p>
          {nonOwnerAdminViewer ? (
            <p>
              The member asked us to only confirm this booking if their guests
              can come, so{" "}
              <strong>no beds are held and nothing has been charged</strong>.
              The whole party — the member and their guests — is confirmed once
              the guests are confirmed and paid for closer to the stay.
            </p>
          ) : (
            <p>
              You asked us to only confirm this booking if your guests can come,
              so <strong>no beds are held and nothing has been charged</strong>.
              We&apos;ll confirm the whole party — you and your guests — once
              your guests are confirmed and paid for closer to your stay.
            </p>
          )}
        </div>
      ) : null}

      {/* #2266 (absorbing #2265's notice surface): a stored credit election is
          a promise the pay step keeps, and the member must see that promise on
          every re-entry — draft save lands here, Resume lands here. Wording is
          the owner-decided sentence from the signed-off mockup. Only shown
          while a consumer will still honour the election (the same statuses
          the edit path may write one onto), and never on a deleted booking.

          Audience (MED-2): the OWNER hears the second-person promise, an
          admin-type viewer the third-person one; a linked-guest viewer sees
          nothing at all — the election is the owner's money, and every other
          money surface on this page is likewise withheld from linked guests
          (see resolveCreditElectionNoticeAudience). */}
      {(() => {
        const creditNoticeAudience = resolveCreditElectionNoticeAudience({
          isBookingOwner,
          isNonOwnerAdminViewer: nonOwnerAdminViewer,
        });
        return !isDeleted &&
          creditNoticeAudience !== null &&
          booking.creditElectionCents != null &&
          booking.creditElectionCents > 0 &&
          ["DRAFT", "AWAITING_REVIEW", "PAYMENT_PENDING"].includes(
            booking.status,
          ) ? (
          <div className="space-y-1 rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11">
            <p className="font-medium">
              {creditNoticeAudience === "admin"
                ? `The member's ${formatCents(booking.creditElectionCents)} credit choice is saved and will be applied when they confirm.`
                : `Your ${formatCents(booking.creditElectionCents)} credit choice is saved and will be applied when you confirm.`}
            </p>
            <p className="opacity-80">
              {creditNoticeAudience === "admin"
                ? "No credit has been taken from their balance yet — it is applied at payment, against the balance and price at that moment."
                : "Nothing has been taken from your balance yet — your credit is applied when you pay, against your balance and the price at that moment."}
            </p>
          </div>
        ) : null;
      })()}

      <section id="details" className="scroll-mt-20">
        <BookingEditor
          booking={editorData}
          canModify={canModify}
          canAdminOverride={canAdminOverride}
        />
      </section>

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
                ? formatConsentFullDate(consentCard.consentExpiresAt)
                : "—"
            }
            lapseByLabel={
              consentCard.consentExpiresAt
                ? formatConsentWeekdayDate(consentCard.consentExpiresAt)
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

      {booking.createdBy && (
        <div className="rounded-md bg-muted border border-border px-4 py-3 text-sm text-muted-foreground">
          Created by <strong>{booking.createdBy.firstName} {booking.createdBy.lastName}</strong> (admin) on behalf of this member
        </div>
      )}

      {booking.requiresAdminReview && (
        <div className="space-y-2 rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
          <p>
            <strong>
              {booking.adminReviewStatus === "PENDING"
                ? "Awaiting admin review."
                : booking.adminReviewStatus === "APPROVED"
                  ? "Approved by admin."
                  : booking.adminReviewStatus === "REJECTED"
                    ? "Declined by admin."
                    : "Admin review required."}
            </strong>{" "}
            {booking.adminReviewReason ?? "This booking needs manual review by an admin."}
          </p>
          {booking.adminReviewStatus === "PENDING" && (
            <p>
              Payment cannot be taken until an admin approves. You can amend the
              booking to include an adult guest if you would like to clear this flag.
            </p>
          )}
          {booking.memberReviewJustification && (
            <p>
              <span className="font-medium">Your reason:</span>{" "}
              {booking.memberReviewJustification}
            </p>
          )}
          {booking.adminReviewNotes && booking.adminReviewStatus !== "PENDING" && (
            <p>
              <span className="font-medium">Admin note:</span> {booking.adminReviewNotes}
            </p>
          )}
        </div>
      )}

      {booking.changeRequests.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Change Requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {booking.changeRequests.map((request) => {
              const requested = request.requestedChanges as {
                requested?: { summary?: string | null };
              };
              return (
                <div key={request.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">
                      {requested.requested?.summary ?? "Booking change request"}
                    </p>
                    <Badge variant={request.status === "REQUESTED" ? "outline" : "secondary"}>
                      {humanizeStatus(request.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    Submitted{" "}
                    {formatNZDate(request.createdAt)}
                  </p>
                  {request.reason ? (
                    <p className="mt-2 text-muted-foreground">{request.reason}</p>
                  ) : null}
                  {/* The officer's MEMBER-FACING explanation (#2562), labelled so
                      the member knows who wrote it and can act on it. The officer
                      panel says this field is member-visible before they submit
                      it; the internal note is a different column and is neither
                      selected above nor rendered anywhere here. */}
                  {request.adminNotes ? (
                    <div className="mt-2">
                      <p className="font-medium">What the club said</p>
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                        {request.adminNotes}
                      </p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

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

      {/* Draft booking: $0 confirm or payment to complete */}
      {canManageBooking && !isDeleted && isDraft && booking.finalPriceCents === 0 && (
        <ConfirmDraftButton bookingId={booking.id} />
      )}

      {/* Draft booking with non-zero price: show payment section to complete.
          Member-personal payment (Stripe card entry) — owner-only so a non-owner
          admin/officer never sees the member's save-card/confirm controls
          (#1303). The $0 ConfirmDraftButton above has no card entry and stays on
          canManageBooking. */}
      {isBookingOwner && !isDeleted && isDraft && booking.finalPriceCents > 0 && (
        <Card>
          <CardHeader>
            {/* #2779 — real heading semantics on the pay door. `CardTitle`
                renders a plain <div> (src/components/ui/card.tsx), so a member
                navigating by headings never finds this card — and this is the
                one card a subscription-locked member has to reach. Marked up
                the way `roster-editor.tsx` already does it rather than as an
                <h2>: `.app-theme-scope :is(h1,h2,h3,h4)` in globals.css swaps
                real heading tags onto --font-heading, which would make this one
                card title look unlike every other card title on the page. Level
                2 sits directly under the page's single <h1> "Booking Details". */}
            <CardTitle headingLevel={2}>
              Complete Booking
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              {booking.createdBy
                ? // #2779 — the pick-up-and-pay journey. An admin saved this
                  // booking on the member's behalf; the member confirms it by
                  // paying for it, and that works even while an unpaid
                  // subscription blocks them from STARTING a booking
                  // (INV-LOCKOUT-069). Say who it came from, so the member does
                  // not read a booking they never made as somebody's mistake.
                  "The club saved this booking for you. Review the details above, then pay to confirm it."
                : "This is a saved draft. Review the details above, then confirm when you're ready to pay and finalise the booking."}
            </p>
            {booking.draftExpiresAt ? (
              // #2779 — the 72-hour draft clock. `draft-cleanup` DELETES an
              // expired draft outright (instrumentation.node.ts), so a member
              // who leaves it a week finds nothing at all. The dashboard card
              // has always shown this deadline; the page where the money is
              // actually taken did not.
              <p
                className="text-sm text-warning-11 mb-4"
                data-testid="draft-expiry-notice"
              >
                Pay by {formatNZDateTime(booking.draftExpiresAt)} or this draft
                is removed and the booking will need to be made again.
              </p>
            ) : null}
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={booking.finalPriceCents}
              paymentMode={getBookingPaymentMode(booking.status)}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
              showOnMount={false}
              gateDescription="Draft bookings stay editable until you explicitly continue to payment. Payment is still collected immediately once you choose to complete the booking."
              gateCtaLabel="Confirm & Continue to Payment"
            />
          </CardContent>
        </Card>
      )}

      {/* Waitlisted booking: show position */}
      {isWaitlisted && (
        <Card className="border-cat1-6 bg-cat1-3">
          <CardHeader>
            <CardTitle className="text-cat1-11">On the Waitlist</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {booking.waitlistPosition && (
              <p className="text-sm font-medium text-cat1-11">
                Position: #{booking.waitlistPosition}
              </p>
            )}
            <p className="text-sm text-cat1-11">
              {nonOwnerAdminViewer ? (
                <>
                  We&apos;ll email the member when a spot opens up. They&apos;ll
                  have {WAITLIST_OFFER_HOURS} hours to confirm the booking.
                </>
              ) : (
                <>
                  We&apos;ll email you when a spot opens up. You&apos;ll have{" "}
                  {WAITLIST_OFFER_HOURS} hours to confirm your booking.
                </>
              )}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Waitlist offered: show confirm button with countdown */}
      {canManageBooking && isWaitlistOffered && booking.waitlistOfferExpiresAt && (
        <WaitlistOfferCard
          bookingId={booking.id}
          expiresAt={booking.waitlistOfferExpiresAt.toISOString()}
          finalPriceCents={booking.finalPriceCents}
          offeredLodgeName={booking.waitlistOfferedLodge?.name ?? null}
          offeredPriceCents={booking.waitlistOfferedPriceCents}
        />
      )}

      {!isDeleted &&
        canManageBooking &&
        internetBankingPayment &&
        isPaymentOwedBookingStatus(booking.status) &&
        internetBankingPayment.status !== "SUCCEEDED" && (
          <Card className="border-warning-6 bg-warning-3">
            <CardHeader>
              <CardTitle className="text-warning-11">Internet Banking Payment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-warning-11">
              <p>
                {internetBankingPendingDescription}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <span className="text-warning-11">Amount due:</span>{" "}
                  <span className="font-medium">
                    {formatCents(internetBankingPayment.amountCents)}
                  </span>
                </div>
                {internetBankingPayment.reference ? (
                  <div>
                    <span className="text-warning-11">Reference:</span>{" "}
                    <span className="font-medium">{internetBankingPayment.reference}</span>
                  </div>
                ) : null}
                {internetBankingPayment.xeroInvoiceNumber ? (
                  <div>
                    <span className="text-warning-11">Xero invoice:</span>{" "}
                    <span className="font-medium">
                      {internetBankingPayment.xeroInvoiceNumber}
                    </span>
                  </div>
                ) : internetBankingPayment.xeroInvoiceId ? (
                  <div>
                    <span className="text-warning-11">Xero invoice:</span>{" "}
                    <span className="font-medium">
                      {internetBankingPayment.xeroInvoiceId.slice(0, 8)}
                    </span>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        )}

      {/* #1967: parent settled by Internet Banking with a genuine split child
          still provisional — no card on file for the guest charge, so offer
          the payment-link affordance here too (the pre-switch warning inside
          the payment card is gone once the switch has happened). */}
      {showGuestPaymentLinkStandalone && (
        <Card className="border-warning-6 bg-warning-3">
          <CardHeader>
            <CardTitle className="text-warning-11">
              Your guests still need paying for
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-warning-11">
            <p>
              You&apos;re paying for your own place by internet banking, so we
              don&apos;t have a card on file to charge for your{" "}
              {provisionalChildGuestCount} non-member guest
              {provisionalChildGuestCount === 1 ? "" : "s"} closer to your
              stay. Email yourself a secure link to pay for your guests — if a
              link was already sent, this sends a fresh one and the old link
              stops working.
            </p>
            <SendGuestPaymentLinkButton bookingId={booking.id} />
          </CardContent>
        </Card>
      )}

      {/* Provisional/on-hold booking: explain why no payment is collected yet
          (issue #777). */}
      {showPaymentOnHoldNotice && (
        <Card className="border-info-6 bg-info-3">
          <CardHeader>
            <CardTitle className="text-info-11">Payment on hold</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-info-11">
              This is a provisional booking. We&apos;ll confirm your place and
              collect payment once your guests are confirmed, closer to your
              stay.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Show payment form if payment hasn't been completed */}
      {showCompletePaymentCard && (
        <Card id="payment" className="scroll-mt-20">
          <CardHeader>
            {/* Same heading semantics as the DRAFT "Complete Booking" card
                above, and for the same reason: this is the other door a member
                pays through, and the two are mutually exclusive (DRAFT is not a
                payment-owed status), so only one level-2 heading of this kind
                is ever on the page. */}
            <CardTitle headingLevel={2}>
              Complete Payment
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              {paymentRequiredDescription}
            </p>
            {showCreditApplied && (
              <div className="mb-4 space-y-1 rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11">
                <div className="flex items-center justify-between">
                  <span>Booking total</span>
                  <span>{formatCents(booking.finalPriceCents)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Credit applied</span>
                  <span>-{formatCents(creditAppliedCents)}</span>
                </div>
                <div className="flex items-center justify-between font-medium">
                  <span>Amount due</span>
                  <span>{formatCents(amountDueAfterCreditCents)}</span>
                </div>
              </div>
            )}
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={
                showCreditApplied
                  ? amountDueAfterCreditCents
                  : booking.finalPriceCents
              }
              paymentMode={getBookingPaymentMode(booking.status)}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
            />
            {canSwitchToInternetBanking && (
              <>
                {hasProvisionalChildren ? (
                  // #1967: paying your own place by internet banking leaves no
                  // card on file for the later guest charge. Warn (do not block)
                  // and offer to email a payment link for the guest portion now,
                  // making the hedged "we'll contact you to arrange it" promise
                  // (#1942) real.
                  <div className="mt-4 space-y-2 rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
                    <p className="font-medium">
                      Paying by internet banking? Your guests still need paying
                      for
                    </p>
                    <p>
                      If you switch to internet banking we won&apos;t have a card
                      on file to charge for your{" "}
                      {provisionalChildGuestCount} non-member guest
                      {provisionalChildGuestCount === 1 ? "" : "s"} closer to
                      your stay. To keep it automatic, pay for this booking by
                      card instead so we have a card on file. Otherwise, email
                      yourself a secure link now to pay for your guests
                      separately — if we can&apos;t take payment, we&apos;ll
                      contact you to arrange it.
                    </p>
                    <SendGuestPaymentLinkButton bookingId={booking.id} />
                  </div>
                ) : null}
                <SwitchToInternetBankingButton
                  bookingId={booking.id}
                  description={switchToInternetBankingDescription}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}

      {showSavePaymentMethodCard && (
        <Card>
          <CardHeader>
            <CardTitle>Save Payment Method</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Please save a payment method. Your card will be charged when your booking is confirmed
              closer to check-in.
            </p>
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={booking.finalPriceCents}
              paymentMode={getBookingPaymentMode(booking.status)}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
            />
          </CardContent>
        </Card>
      )}

      {/* #2350: the admin-side view of the same outstanding amount. The card
          below is owner-only (it holds the member's own card controls), which
          left every other admin viewer with no sign that money was owing at all.
          Read-only, plus a re-send for admins who may write. */}
      {nonOwnerAdminViewer && !isDeleted && booking.payment ? (
        <BookingAdditionalPaymentPanel
          bookingId={booking.id}
          bookingStatus={booking.status}
          payment={booking.payment}
          requestedOn={additionalPaymentEpisodeStartedAt({
            paymentCreatedAt: booking.payment.createdAt,
            latestAdditionalTransactionCreatedAt:
              booking.payment.transactions[0]?.createdAt ?? null,
          })}
          canResend={canSeeAdminTools}
        />
      ) : null}

      {/* Additional payment required after a modification that increased the
          price. Member-personal payment (Stripe card entry) — owner-only so a
          non-owner admin/officer never sees the member's pay controls (#1303).

          The lifecycle check is load-bearing, not tidiness (#2350): cancelling a
          booking marks the additional intent FAILED and leaves the amount alone,
          so an amount-and-status-only condition kept showing the owner of a
          CANCELLED booking a "pay this extra" card — and the secret route behind
          it would still hand out a confirmable client secret. Same predicate the
          route now uses, so the card and the money agree. */}
      {booking.payment &&
        isBookingOwner &&
        !isDeleted &&
        isAdditionalPayableBookingStatus(booking.status) &&
        booking.payment.additionalAmountCents > 0 &&
        booking.payment.additionalPaymentStatus !== "SUCCEEDED" && (
          <AdditionalPaymentCard
            bookingId={booking.id}
            additionalAmountCents={booking.payment.additionalAmountCents}
          />
        )}

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

      {booking.status === "CANCELLED" && (
        <Card id="cancellation" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Cancellation Outcome</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Badge
                className={
                  paymentDisplay
                    ? paymentStatusClass(paymentDisplay.toneStatus)
                    : "bg-muted text-muted-foreground"
                }
              >
                {paymentDisplay?.label ?? "Cancelled Before Payment"}
              </Badge>
              <p className="text-sm text-muted-foreground">
                {paymentDisplay?.detail ??
                  "No original payment was captured for this booking, so nothing needed to be returned."}
              </p>
            </div>

            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">Original payment:</span>{" "}
                {originalPaymentCaptured && booking.payment
                  ? formatCents(booking.payment.amountCents)
                  : "No original payment captured"}
              </div>

              {originalPaymentCaptured && cancellationSettlement && (
                <>
                  <div>
                    <span className="text-muted-foreground">
                      Returned to original payment method:
                    </span>{" "}
                    {formatCents(
                      cancellationSettlement.refundToOriginalMethodCents
                    )}
                  </div>

                  <div>
                    <span className="text-muted-foreground">Held as account credit:</span>{" "}
                    {formatCents(cancellationSettlement.accountCreditCents)}
                  </div>

                  <div>
                    <span className="text-muted-foreground">
                      Non-refundable amount retained:
                    </span>{" "}
                    {formatCents(retainedAfterCancellationCents)}
                  </div>

                  {cancellationSettlement.restoredAppliedCreditCents > 0 && (
                    <div>
                      <span className="text-muted-foreground">
                        Previously applied credit restored (per the cancellation
                        policy):
                      </span>{" "}
                      {formatCents(
                        cancellationSettlement.restoredAppliedCreditCents
                      )}
                    </div>
                  )}

                  {booking.payment?.changeFeeCents
                    ? (
                    <div>
                      <span className="text-muted-foreground">
                        Included non-refundable change fees:
                      </span>{" "}
                      {formatCents(booking.payment.changeFeeCents)}
                    </div>
                      )
                    : null}
                </>
              )}

              {latestRefundAppeal && (
                <div>
                  <span className="text-muted-foreground">Latest refund appeal:</span>{" "}
                  <Badge
                    variant={
                      latestRefundAppeal.status === "PENDING"
                        ? "outline"
                        : latestRefundAppeal.status === "APPROVED"
                          ? "default"
                          : "destructive"
                    }
                    className="align-middle"
                  >
                    {humanizeStatus(latestRefundAppeal.status)}
                  </Badge>
                  {latestRefundAppeal.requestedAmountCents ? (
                    <span className="ml-2 text-muted-foreground">
                      Requested {formatCents(latestRefundAppeal.requestedAmountCents)}
                    </span>
                  ) : null}
                  {latestRefundAppeal.approvedAmountCents ? (
                    <span className="ml-2 text-muted-foreground">
                      Approved {formatCents(latestRefundAppeal.approvedAmountCents)}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card id="notes" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <BookingNotesEditor
            bookingId={booking.id}
            initialNotes={booking.notes ?? ""}
            canEdit={canCancel}
          />
        </CardContent>
      </Card>

      <Card id="transaction-history" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Transaction History</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {bookingHistory.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={historyToneClasses[item.tone]}
                    >
                      {item.category}
                    </Badge>
                    <span className="text-sm font-medium text-foreground">
                      {item.title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatNZDateTime(item.occurredAt)}
                    </span>
                  </div>
                  {item.detail ? (
                    <p className="text-sm text-muted-foreground">{item.detail}</p>
                  ) : null}
                </div>
                {item.amountDisplay ? (
                  <span
                    className={`text-sm font-medium ${
                      item.tone === "danger"
                        ? "text-danger-11"
                        : item.tone === "success"
                          ? "text-success-11"
                          : item.tone === "warning"
                            ? "text-warning-11"
                            : "text-muted-foreground"
                    }`}
                  >
                    {item.amountDisplay}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Waiting on a booking email? This page always shows the live status of
        your booking — the confirmation, payment, and cancellation details
        above are up to date even if an email hasn&apos;t arrived. Check your
        spam folder, and contact the club if our emails keep going missing.
      </p>
      </div>
    </div>
  );
}
