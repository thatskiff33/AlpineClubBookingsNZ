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
                    {club.instantDate(request.createdAt)}
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
                Pay by {club.instantDateTime(booking.draftExpiresAt)} or this draft
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
