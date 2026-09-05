import { auth } from "@/lib/auth";
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
import { BookingEditor } from "@/components/booking-editor";
import { AdditionalPaymentCard } from "@/components/additional-payment-card";
import { BookingAdditionalPaymentPanel } from "@/components/admin/booking-additional-payment-panel";
import {
  additionalPaymentEpisodeStartedAt,
  isAdditionalPayableBookingStatus,
} from "@/lib/additional-payment-chase";
import { ConfirmDraftButton } from "@/components/confirm-draft-button";
import { AdminBookingToolsCard } from "@/components/admin/admin-booking-tools-card";
import { BookingBedAllocationPanel } from "@/components/admin/booking-bed-allocation-panel";
import { BookingWithheldEmailsBanner } from "@/components/admin/booking-withheld-emails-banner";
import { ScrollToHash } from "@/components/scroll-to-hash";
import { SectionNav, type SectionNavItem } from "@/components/section-nav";
import { ArrivalTimeEditor } from "@/components/arrival-time-editor";
import { RequestedRoomEditor } from "@/components/requested-room-editor";
import { WaitlistOfferCard } from "@/components/waitlist-offer-card";
import { DeleteBookingButton } from "@/components/delete-booking-button";
import { getBookingPaymentMode } from "@/lib/booking-payment-flow";
import { RefundAppealButton } from "@/components/refund-appeal-button";
import { humanizeStatus, paymentStatusClass } from "@/lib/status-colors";
import { BookingHelpExtras } from "./_components/booking-help-extras";
import { BookingCancellationOutcome } from "./_components/booking-cancellation-outcome";
import { BookingLifecycleActions } from "./_components/booking-lifecycle-actions";
import { BookingPaymentCards } from "./_components/booking-payment-cards";
import { BookingStayPreferences } from "./_components/booking-stay-preferences";
import { BookingReviewNotices } from "./_components/booking-review-notices";
import { BookingLinkedPartySections } from "./_components/booking-linked-party-sections";
import { BookingConsentCards } from "./_components/booking-consent-cards";
import { BookingStatusBanners } from "./_components/booking-status-banners";
import { BookingAdminToolsSection } from "./_components/booking-admin-tools-section";
import { loadBookingDetail } from "./_lib/load-booking-detail";
import { resolveBookingDetailViewer } from "./_lib/booking-detail-viewer";
import { resolveBookingDetailConsent } from "./_lib/booking-detail-consent";
import { loadBookingDetailHistory } from "./_lib/booking-detail-history";
import { resolveBookingDetailEditAccess } from "./_lib/booking-detail-edit-access";
import { resolveBookingDetailPayment } from "./_lib/booking-detail-payment";
import { resolveBookingDetailLinkedParty } from "./_lib/booking-detail-linked-party";
import { buildBookingDetailEditorData } from "./_lib/booking-detail-editor-data";
import { renderBookingDetailMessages } from "./_lib/booking-detail-messages";
import { loadBookingDetailAdminTools } from "./_lib/booking-detail-admin-tools";
import { NonMemberGuestsSection } from "@/app/(authenticated)/bookings/_components/non-member-guests-section";
import { loadCancellationPolicy } from "@/lib/cancellation";
import { describeCancellationSchedule } from "@/lib/cancellation-schedule";
import { WAITLIST_OFFER_HOURS } from "@/lib/waitlist";
import type { BookingHistoryTone } from "@/lib/booking-history";
import type { BookingNarrativeState } from "@/lib/booking-narrative";
import { resolveCreditElectionNoticeAudience } from "@/lib/booking-credit-election";
import {
  bookingHoldsCapacity,
  isPaymentOwedBookingStatus,
} from "@/lib/booking-status";
import { formatDateOnly } from "@/lib/date-only";
import {
  calendarDateOfDateOnlyInstant,
  countClubNights,
  dateOnlyInstantOf,
} from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { loadEmailMessageSettingsForLodge } from "@/lib/email-message-settings";
import { loadPublicBookingMessages } from "@/lib/booking-message-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { resolveInternalReturnPath } from "@/lib/internal-return-path";
import { SelfRemoveFromBookingCard } from "@/components/self-remove-from-booking-card";
import { MemberGuestConsentCard } from "@/components/member-guest-consent-card";
import {
  describeConsentDeclineRefusal,
  describeConsentNightsCount,
  formatConsentFullDate,
  formatConsentNightsLabel,
  formatConsentStayLabel,
  formatConsentWeekdayDate,
} from "@/lib/member-guest-consent-card";
// Kept as its OWN single-line import, deliberately: a source contract in
// arrival-instructions-consent-gate.test.ts matches this line verbatim, because
// D-12's exclusion has to be visibly the SHARED predicate on this page rather
// than a hand-rolled filter. Folding it into the import below would satisfy the
// compiler and break the guard.
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import { OrganiserGroupBookingCard } from "@/components/group-booking/organiser-group-booking-card";

const historyToneClasses: Record<BookingHistoryTone, string> = {
  default: "border-border bg-muted text-muted-foreground",
  success: "border-success-6 bg-success-3 text-success-11",
  warning: "border-warning-6 bg-warning-3 text-warning-11",
  danger: "border-danger-6 bg-danger-3 text-danger-11",
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
  /*
    THE CLUB'S OWN CLOCK, once, for the whole page (CT-4, #2870; INV-CONFIG-002).

    Everything below that renders a real INSTANT — an audit stamp, a draft
    expiry, an internet-banking hold, a deletion time — goes through this
    binding, and so does the "today" the consent card is told. Both used to come
    from `APP_TIME_ZONE`, so on a deployment whose container disagrees with the
    club's recorded setting this page answered with the machine's day.

    The stay dates DO NOT: `checkIn` and `checkOut` are `@db.Date` lodge nights,
    which are calendar days and take no zone at all (INV-DATE-010).
  */
  const club = await clubTime();
  // #3123 — the club's today, as the UTC-midnight instant a `@db.Date` bound
  // round-trips through, derived from the SAME binding this page already holds.
  // THE ONLY RESOLUTION OF THE CLUB'S DAY ON THIS PAGE: it is threaded into
  // every question below — the started-stay test, the edit policy, the
  // admin-override policy, the self-removal card and the consent card — so none
  // of them can answer on a different day. Two of those cards used to take a
  // second `club.today()` of their own, which across club midnight would have
  // offered a member a self-removal control the very next check refused.
  const clubTodayDateOnly = dateOnlyInstantOf(club.today());

  const booking = await loadBookingDetail(id);

  if (!booking) notFound();
  const viewer = resolveBookingDetailViewer({ session, booking });
  const {
    isAdmin,
    viewerAuthorizationRole,
    isBookingOwner,
    viewerGuestRow,
    isLinkedGuestViewer,
    canManageBooking,
    canViewAsAdmin,
    canAdminEditBookings,
    canSeeAdminTools,
    actingOnBehalf,
    nonOwnerAdminViewer,
  } = viewer;
  if (booking.deletedAt && !isAdmin) notFound();
  if (!canManageBooking && !isLinkedGuestViewer && !canViewAsAdmin) {
    redirect("/bookings");
  }
  // THIS booking's lodge identity, not the club default's. The ask card, the
  // arrival instructions and the booking-message merge data (#2919) all want it
  // and the last is unconditional, so it is loaded once rather than twice.
  const bookingLodgeEmailSettings = await loadEmailMessageSettingsForLodge(
    booking.lodgeId,
  );
  const consent = await resolveBookingDetailConsent({
    session,
    booking,
    viewer,
    clubTodayDateOnly,
    bookingLodgeEmailSettings,
  });
  const {
    selfRemovalCard,
    consentCard,
    consentIsQuotePriced,
    consentLodgeName,
    viewerConsentGuest,
    viewerConsentNights,
  } = consent;

  const history = await loadBookingDetailHistory({ booking, club, viewer });
  const { bookingNarrative, bookingHistory } = history;

  // Nights are CALENDAR arithmetic over the half-open `[checkIn, checkOut)`
  // night range, never elapsed milliseconds divided by 24 hours: across a DST
  // transition a night is 23 or 25 hours and that division is wrong (the kernel
  // has a case where it returns 0 for a stay the calendar says is 1). Exact for
  // the UTC-midnight encoding this replaces, so the value is unchanged here —
  // what changes is that the wrong idiom is gone (INV-DATE-002, INV-DATE-003).
  const nights = countClubNights(
    calendarDateOfDateOnlyInstant(booking.checkIn),
    calendarDateOfDateOnlyInstant(booking.checkOut),
  );

  const modules = await loadEffectiveModuleFlags();
  const bookingMessages = await loadPublicBookingMessages();
  const access = await resolveBookingDetailEditAccess({
    booking,
    modules,
    clubTodayDateOnly,
    viewer,
  });
  const {
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
    canEditRequestedRoom,
  } = access;
  const editorData = await buildBookingDetailEditorData({
    session,
    booking,
    club,
    nights,
    viewer,
    consent,
    access,
  });
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

  const party = resolveBookingDetailLinkedParty({
    booking,
    modules,
    viewer,
    access,
  });
  const payment = resolveBookingDetailPayment({
    booking,
    modules,
    viewer,
    access,
    party,
  });
  const {
    provisionalChildGuestCount,
    hasProvisionalChildren,
    isProvisionalChild,
    showNonMemberGuestsSection,
    nonMemberGuestChildren,
    isFlaggedProvisional,
    organiserGroupState,
    canOpenGroup,
    showGroupSection,
  } = party;
  const {
    cancellationSettlement,
    paymentDisplay,
    internetBankingPayment,
    canSwitchToInternetBanking,
    originalPaymentCaptured,
    retainedAfterCancellationCents,
    latestRefundAppeal,
    maxRefundableCents,
    showGuestPaymentLinkStandalone,
    showSavePaymentMethodCard,
    showPaymentOnHoldNotice,
    showCompletePaymentCard,
    creditAppliedCents,
    showCreditApplied,
    amountDueAfterCreditCents,
  } = payment;
  const messages = renderBookingDetailMessages({
    booking,
    club,
    modules,
    bookingMessages,
    bookingLodgeEmailSettings,
    payment,
  });
  const {
    paymentRequiredDescription,
    internetBankingPendingDescription,
    switchToInternetBankingDescription,
    financialReviewPendingDescription,
    refundAppealDescription,
  } = messages;

  const adminTools = await loadBookingDetailAdminTools({
    booking,
    modules,
    viewer,
    access,
    history,
  });
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

      <BookingAdminToolsSection
        booking={booking}
        editorData={editorData}
        modules={modules}
        viewer={viewer}
        access={access}
        adminTools={adminTools}
      />

      <BookingStatusBanners
        booking={booking}
        club={club}
        viewer={viewer}
        access={access}
        party={party}
        payment={payment}
        history={history}
        messages={messages}
      />

      <section id="details" className="scroll-mt-20">
        <BookingEditor
          booking={editorData}
          canModify={canModify}
          canAdminOverride={canAdminOverride}
        />
      </section>

      <BookingConsentCards
        booking={booking}
        club={club}
        consent={consent}
      />

      <BookingLinkedPartySections
        booking={booking}
        viewer={viewer}
        party={party}
        bookingLodgeEmailSettings={bookingLodgeEmailSettings}
      />

      <BookingReviewNotices
        booking={booking}
        club={club}
      />

      <BookingStayPreferences
        booking={booking}
        viewer={viewer}
        access={access}
        memberArrivalInstructions={memberArrivalInstructions}
      />

      <BookingPaymentCards
        booking={booking}
        club={club}
        viewer={viewer}
        access={access}
        party={party}
        payment={payment}
        messages={messages}
      />

      <BookingLifecycleActions
        booking={booking}
        viewer={viewer}
        access={access}
        payment={payment}
        messages={messages}
        canDeleteDraft={canDeleteDraft}
        canSoftDeleteCancelled={canSoftDeleteCancelled}
        backHref={backHref}
      />

      <BookingCancellationOutcome
        booking={booking}
        payment={payment}
      />

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
                      {club.instantDateTime(item.occurredAt)}
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
