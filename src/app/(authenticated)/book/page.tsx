"use client";

import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ExternalLink, UserMinus } from "lucide-react";
import { buildProfilePathWithReturnTo } from "@/lib/internal-return-path";
import {
  describeBookingMemberNightConflictBooking,
  describeBookingMemberNightConflictNextStep,
  describeBookingMemberNightConflictNights,
} from "@/lib/booking-member-night-conflict-messages";
import { useHelpWidgetHint } from "@/components/help-widget/help-widget-context";
import { DatesStep } from "./_components/dates-step";
import { GuestsStep } from "./_components/guests-step";
import { ReviewStep } from "./_components/review-step";
import { PayStep } from "./_components/pay-step";
import {
  PROFILE_FAMILY_GROUP_RETURN_TO_BOOK,
  readSubscriptionLockoutView,
} from "./_components/types";
import { useBookingWizard } from "./_hooks/use-booking-wizard";

const PROFILE_RETURN_TO_BOOK = buildProfilePathWithReturnTo("/book");

export default function BookPage() {
  const {
    step,
    setStep,
    createdBooking,
    checkIn,
    checkOut,
    guests,
    notes,
    setNotes,
    priceQuote,
    priceLoading,
    error,
    errorPaymentTargets,
    subscriptionInvoiceUrl,
    subscriptionInvoiceNumber,
    submitting,
    savingDraft,
    showWaitlistPrompt,
    setShowWaitlistPrompt,
    waitlistFullNights,
    joiningWaitlist,
    perGuestDatesEnabled,
    handlePerGuestDatesEnabledChange,
    multiDateRangesEnabled,
    handleMultiDateRangesEnabledChange,
    appliedPromo,
    setAppliedPromo,
    requestedRoomId,
    setRequestedRoomId,
    cancelIfGuestsBumped,
    setCancelIfGuestsBumped,
    roomOptions,
    roomRequestEnabled,
    useCredit,
    setUseCredit,
    paymentMethod,
    setPaymentMethod,
    internetBankingEnabled,
    groupBookingsEnabled,
    groupTrip,
    setGroupTrip,
    groupPaymentMode,
    setGroupPaymentMode,
    internetBankingUnavailableReason,
    internetBankingHoldSummary,
    familyMembers,
    subscriptionStatus,
    subscriptionLoading,
    availablePromoCodes,
    promoCodesEnabled,
    prefillPromoCode,
    setPrefillPromoCode,
    activeWorkPartyEvents,
    attendingWorkParty,
    setAttendingWorkParty,
    selectedWorkPartyEventId,
    setSelectedWorkPartyEventId,
    workPartyError,
    setWorkPartyError,
    workPartyClearedNotice,
    setWorkPartyClearedNotice,
    guestProfileBlocks,
    memberNightConflicts,
    removingConflictGuestId,
    memberReviewJustification,
    setMemberReviewJustification,
    requiresAdminReviewLocal,
    handleGuestsChange,
    addFamilyMemberAsGuest,
    addMemberGuest,
    memberGuestConfig,
    memberGuestAddError,
    handleRemoveConflictGuest,
    handleDateSelect,
    handleGuestsDone,
    handleSubmit,
    handleJoinWaitlist,
    handleSaveAsDraft,
    exceptionOffer,
    replaceExceptionRequestId,
    submitExceptionRequest,
    getGuestProfileBlockMessage,
    getGuestProfileActionLabel,
    nights,
    availableCreditCents,
    appliedCreditCents,
    remainingToPay,
    bookingDateStrings,
    reviewGuestPayload,
    cardPaymentDescription,
    internetBankingPaymentDescription,
    internetBankingUnavailableCopy,
    subscriptionUnpaid,
    showInviteFamilyGroupMembersLink,
    showPaymentMethodChoice,
    wizardSteps,
    activeStepIndex,
    lodgeCapacity,
    lodges,
    lodgeId,
    lodgesLoading,
    handleLodgeChange,
    selectedLodge,
    lodgeLabel,
    waitlistAlternateLodgeIds,
    setWaitlistAlternateLodgeIds,
  } = useBookingWizard();

  // Hint the help widget which wizard step is active so its chips lead with the
  // questions tagged for that step (epic #2094 C2). `step` is the wizard step id
  // ("dates" | "guests" | "review" | "pay").
  useHelpWidgetHint({ group: step });

  // #2543 — the same unpaid subscription means three different things depending
  // on the club's lockout mode, so the banner below cannot keep saying "pay it
  // before booking": that is only true under HARD_BLOCK. An absent or
  // unrecognised mode resolves to HARD_BLOCK, today's copy, so an older cached
  // subscription-status response cannot silently drop a warning that still
  // holds. See `readSubscriptionLockoutView`.
  const subscriptionLockout = readSubscriptionLockoutView(subscriptionStatus);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <Link
          href="/dashboard"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          &larr; Back to Dashboard
        </Link>
        <h1 className="text-3xl font-bold">Book a Stay</h1>
      </div>

      {/* #2263 — whole-lodge entry point. A separate door, not a wizard step:
          the wizard books beds against live availability, while this asks the
          booking officer for sole occupancy and shows the member no availability
          at all (ADR-001 decision 6). Shown to every signed-in member. */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h2 className="font-semibold">Need the whole lodge?</h2>
            <p className="text-sm text-muted-foreground">
              For a course, a club trip or a family gathering, ask the booking
              officer about having the lodge to yourselves.
            </p>
          </div>
          <Button asChild variant="outline" className="shrink-0">
            <Link href="/book/whole-lodge">Book the whole lodge</Link>
          </Button>
        </CardContent>
      </Card>

      {/* Subscription warning banner.

          #2543 made this mode-aware. "Pay it before booking" / "contact the club
          before booking" is only TRUE under HARD_BLOCK. Under
          NON_MEMBER_PRICING the member may book — they are simply charged
          non-member rates — and under NO_BLOCK the subscription does not gate
          booking at all, so instructing them to settle it first is wrong in both.

          The first sentence is unchanged and stays true in all three modes: the
          subscription IS unpaid. Only the instruction after it is mode-gated,
          and the HARD_BLOCK branch is deliberately byte-identical to the
          pre-#2543 copy so no club whose mode did not move sees new wording.

          The NON_MEMBER_PRICING explanation is the SERVER's own sentence
          (`memberRateNotice`, built by `formatUnpaidSubscriptionRateReason` in
          the subscription-status route), rendered verbatim so the wizard and the
          quote cannot describe the same repricing two ways. When it is missing —
          an older cached response — the banner says nothing extra rather than
          inventing a replacement; the payment affordance below still stands.

          NO_BLOCK downgrades to the neutral `info` variant (and so to a polite
          `role="status"`): nothing is at stake for this booking, so an assertive
          alert would be noise. The payment affordance stays in every mode — a
          member who wants to settle an unpaid subscription always may. */}
      {!subscriptionLoading && subscriptionUnpaid && (
        <Alert
          variant={subscriptionLockout.mode === "NO_BLOCK" ? "info" : "warning"}
          data-testid="subscription-unpaid-banner"
        >
          <p>
            <strong>Subscription unpaid:</strong> Your subscription for the{" "}
            {subscriptionStatus!.seasonDisplay} season is unpaid.{" "}
            {subscriptionLockout.mode === "HARD_BLOCK" ? (
              subscriptionInvoiceUrl ? (
                <>Use the payment link below to pay it before booking.</>
              ) : (
                <>
                  Please{" "}
                  <Link
                    href={PROFILE_RETURN_TO_BOOK}
                    className="underline font-medium"
                  >
                    contact the club
                  </Link>{" "}
                  before booking.
                </>
              )
            ) : null}
          </p>
          {subscriptionLockout.mode === "NON_MEMBER_PRICING" &&
          subscriptionLockout.memberRateNotice ? (
            <p data-testid="subscription-non-member-pricing-notice">
              {subscriptionLockout.memberRateNotice}
            </p>
          ) : null}
          {subscriptionInvoiceUrl ? (
            <Button asChild className="mt-3">
              <a
                href={subscriptionInvoiceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Pay Your Subscription
              </a>
            </Button>
          ) : subscriptionInvoiceNumber ? (
            <p className="mt-2">
              Invoice reference: <strong>{subscriptionInvoiceNumber}</strong> — check your email from Xero for the payment link.
            </p>
          ) : null}
        </Alert>
      )}

      {error && (
        <div role="alert" className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
          <p>{error}</p>
          {guestProfileBlocks.length > 0 && (
            <div className="mt-3 space-y-3">
              {guestProfileBlocks.map((block) => {
                const actionLabel = getGuestProfileActionLabel(block);
                return (
                  <div
                    key={block.memberId}
                    className="rounded-md border border-danger-6 bg-card p-3"
                  >
                    <p className="font-medium text-danger-11">{block.name}</p>
                    <p className="mt-1">{getGuestProfileBlockMessage(block)}</p>
                    {block.missingFields.length > 0 && (
                      <p className="mt-1 text-danger-11">
                        Missing: {block.missingFields.join(", ")}
                      </p>
                    )}
                    {actionLabel && (
                      block.action === "complete_details" && block.canCurrentUserResolve ? (
                        <Link
                          href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}
                          className="mt-2 inline-flex text-sm font-medium text-danger-11 underline underline-offset-4"
                        >
                          {actionLabel}
                        </Link>
                      ) : (
                        <p className="mt-2 font-medium text-danger-11">{actionLabel}</p>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {memberNightConflicts.length > 0 && (
            <div className="mt-3 space-y-3">
              {memberNightConflicts.map((conflict) => (
                <div
                  // #2250: an unentitled row carries no booking or guest id, so
                  // the key falls back to what every row always has.
                  key={
                    conflict.guestId ??
                    `${conflict.memberId}-${conflict.conflictingNights[0]}`
                  }
                  className="rounded-md border border-danger-6 bg-card p-3"
                >
                  <p className="font-medium text-danger-11">
                    {conflict.memberName}
                  </p>
                  {/* #2250: which nights, and — only for a viewer the server
                      marked canOpenBooking — whose booking it is. A member
                      adding a guest who turns out to be on a stranger's
                      booking learns the nights are taken, not whose booking
                      took them. */}
                  <p className="mt-1">
                    {[
                      describeBookingMemberNightConflictNights(conflict),
                      describeBookingMemberNightConflictBooking(conflict),
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  </p>
                  {/* #2250: the next step is always stated, not only when no
                      button is available — a member who has never seen "Remove
                      me from this booking" needs telling what it does, so it
                      sits ABOVE the buttons it describes. This is the booking
                      wizard, the one surface whose reader is actually choosing
                      the dates, so it is also the one place allowed to offer
                      "choose different dates" (the admin booking-request routes
                      return the same 409 and cannot). */}
                  <p className="mt-2 text-danger-11">
                    {describeBookingMemberNightConflictNextStep(conflict, {
                      canChooseDifferentDates: true,
                    })}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {conflict.canOpenBooking && conflict.bookingId && (
                      <Button
                        asChild
                        size="sm"
                        variant="outline"
                        className="border-danger-6 text-danger-11 hover:bg-danger-3"
                      >
                        <Link href={`/bookings/${conflict.bookingId}`}>
                          <ExternalLink className="mr-2 h-4 w-4" />
                          Open booking
                        </Link>
                      </Button>
                    )}
                    {conflict.canSelfRemove && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="border-danger-6 text-danger-11 hover:bg-danger-3"
                        onClick={() => void handleRemoveConflictGuest(conflict)}
                        disabled={removingConflictGuestId === conflict.guestId}
                      >
                        <UserMinus className="mr-2 h-4 w-4" />
                        {removingConflictGuestId === conflict.guestId
                          ? "Removing..."
                          : "Remove me from this booking"}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {errorPaymentTargets.length > 0 && (
            <div className="mt-3 space-y-2">
              {errorPaymentTargets.map((target) => (
                <div key={`${target.name}-${target.invoiceNumber ?? target.invoiceUrl ?? "none"}`}>
                  {target.invoiceUrl ? (
                    <a
                      href={target.invoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="app-button-brand"
                    >
                      {target.name === "Your subscription"
                        ? "Pay Your Subscription"
                        : `Pay ${target.name}'s Subscription`}
                    </a>
                  ) : target.invoiceNumber ? (
                    <p className="text-sm">
                      {target.name}: invoice reference{" "}
                      <strong>{target.invoiceNumber}</strong> — check your email from Xero for the payment link.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showWaitlistPrompt && (
        <Card className="border-cat1-6 bg-cat1-3">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-cat1-3 p-2 mt-0.5">
                <svg className="h-5 w-5 text-cat1-11" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
              </div>
              <div>
                <h2 className="font-semibold text-cat1-11">
                  {lodges.length > 1 && selectedLodge
                    ? `${selectedLodge.name} is fully booked`
                    : "Lodge is fully booked"}
                </h2>
                <p className="text-sm text-cat1-11 mt-1">
                  {lodgeLabel} is at capacity on{" "}
                  {waitlistFullNights.length === 1
                    ? waitlistFullNights[0]
                    : `${waitlistFullNights.length} nights`}
                  . You can join the waitlist and we&apos;ll email you when a spot opens up.
                </p>
              </div>
            </div>
            {lodges.length > 1 && lodges.some((lodge) => lodge.id !== lodgeId) && (
              <div className="rounded-md border border-cat1-6 bg-card p-4 space-y-2">
                <p className="text-sm font-medium text-cat1-11">
                  Happy to stay at another lodge if a spot opens there first?
                </p>
                {lodges
                  .filter((lodge) => lodge.id !== lodgeId)
                  .map((lodge) => (
                    <label
                      key={lodge.id}
                      className="flex items-center gap-2 text-sm text-cat1-11 cursor-pointer"
                    >
                      <Checkbox
                        checked={waitlistAlternateLodgeIds.includes(lodge.id)}
                        onCheckedChange={(checked) =>
                          setWaitlistAlternateLodgeIds((current) =>
                            checked
                              ? [...current, lodge.id]
                              : current.filter((id) => id !== lodge.id)
                          )
                        }
                        className="border-cat1-6"
                        disabled={joiningWaitlist}
                      />
                      Also waitlist me for {lodge.name}
                    </label>
                  ))}
                <p className="text-xs text-cat1-11">
                  Prices can differ between lodges. If a spot opens at one of
                  these, we&apos;ll email you that lodge&apos;s price for your
                  stay — nothing is booked until you confirm it.
                </p>
              </div>
            )}
            <div className="flex gap-3 justify-end">
              <Button
                variant="outline"
                onClick={() => setShowWaitlistPrompt(false)}
                disabled={joiningWaitlist}
              >
                Cancel
              </Button>
              <Button
                onClick={handleJoinWaitlist}
                disabled={joiningWaitlist}
                className="bg-cat1-9 hover:bg-cat1-9"
              >
                {joiningWaitlist ? "Joining waitlist..." : "Join Waitlist"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step indicator */}
      <nav aria-label="Booking progress">
        <ol className="flex items-center gap-2 text-sm">
          {wizardSteps.map((wizardStep, index) => {
            const isActive = wizardStep.id === step;
            return (
              <li key={wizardStep.id} className="flex items-center gap-2">
                {index > 0 && (
                  <span aria-hidden="true" className="text-muted-foreground">
                    &rarr;
                  </span>
                )}
                <span
                  aria-current={isActive ? "step" : undefined}
                  className={isActive ? "app-step-active" : "text-muted-foreground"}
                >
                  {index + 1}. {wizardStep.label}
                  {isActive && <span className="sr-only"> (current step)</span>}
                </span>
              </li>
            );
          })}
        </ol>
        {/* Announce step transitions to screen readers, which otherwise get no
            signal when a step auto-advances and its focus target unmounts. */}
        <p aria-live="polite" className="sr-only">
          Step {activeStepIndex + 1} of {wizardSteps.length}:{" "}
          {wizardSteps[activeStepIndex]?.label}
        </p>
      </nav>

      {/* Step 1: Dates */}
      {step === "dates" && (
        <DatesStep
          subscriptionUnpaid={subscriptionUnpaid}
          handleDateSelect={handleDateSelect}
          checkIn={checkIn}
          checkOut={checkOut}
          lodges={lodges}
          lodgeId={lodgeId}
          lodgesLoading={lodgesLoading}
          handleLodgeChange={handleLodgeChange}
          selectedLodge={selectedLodge}
        />
      )}

      {/* Step 2: Guests */}
      {step === "guests" && (
        <GuestsStep
          checkIn={checkIn}
          checkOut={checkOut}
          nights={nights}
          familyMembers={familyMembers}
          guests={guests}
          lodgeCapacity={lodgeCapacity}
          addFamilyMemberAsGuest={addFamilyMemberAsGuest}
          showInviteFamilyGroupMembersLink={showInviteFamilyGroupMembersLink}
          handleGuestsChange={handleGuestsChange}
          perGuestDatesEnabled={perGuestDatesEnabled}
          handlePerGuestDatesEnabledChange={handlePerGuestDatesEnabledChange}
          multiDateRangesEnabled={multiDateRangesEnabled}
          handleMultiDateRangesEnabledChange={handleMultiDateRangesEnabledChange}
          priceQuote={priceQuote}
          groupBookingsEnabled={groupBookingsEnabled}
          groupTrip={groupTrip}
          setGroupTrip={setGroupTrip}
          groupPaymentMode={groupPaymentMode}
          setGroupPaymentMode={setGroupPaymentMode}
          setStep={setStep}
          handleGuestsDone={handleGuestsDone}
          priceLoading={priceLoading}
          memberGuestEnabled={memberGuestConfig.enabled}
          memberGuestOpenSearchEnabled={memberGuestConfig.openSearchEnabled}
          addMemberGuest={addMemberGuest}
          memberGuestAddError={memberGuestAddError}
        />
      )}

      {/* Step 3: Review */}
      {step === "review" && priceQuote && (
        <ReviewStep
          checkIn={checkIn}
          checkOut={checkOut}
          nights={nights}
          guests={guests}
          priceQuote={priceQuote}
          lodges={lodges}
          lodgeId={lodgeId}
          selectedLodge={selectedLodge}
          reviewGuestPayload={reviewGuestPayload}
          bookingDateStrings={bookingDateStrings}
          perGuestDatesEnabled={perGuestDatesEnabled}
          appliedPromo={appliedPromo}
          setAppliedPromo={setAppliedPromo}
          availableCreditCents={availableCreditCents}
          appliedCreditCents={appliedCreditCents}
          remainingToPay={remainingToPay}
          useCredit={useCredit}
          setUseCredit={setUseCredit}
          groupTrip={groupTrip}
          groupBookingsEnabled={groupBookingsEnabled}
          groupPaymentMode={groupPaymentMode}
          showPaymentMethodChoice={showPaymentMethodChoice}
          paymentMethod={paymentMethod}
          setPaymentMethod={setPaymentMethod}
          internetBankingEnabled={internetBankingEnabled}
          internetBankingUnavailableReason={internetBankingUnavailableReason}
          internetBankingHoldSummary={internetBankingHoldSummary}
          cardPaymentDescription={cardPaymentDescription}
          internetBankingPaymentDescription={internetBankingPaymentDescription}
          internetBankingUnavailableCopy={internetBankingUnavailableCopy}
          notes={notes}
          setNotes={setNotes}
          requiresAdminReviewLocal={requiresAdminReviewLocal}
          memberReviewJustification={memberReviewJustification}
          setMemberReviewJustification={setMemberReviewJustification}
          roomRequestEnabled={roomRequestEnabled}
          roomOptions={roomOptions}
          requestedRoomId={requestedRoomId}
          setRequestedRoomId={setRequestedRoomId}
          activeWorkPartyEvents={activeWorkPartyEvents}
          attendingWorkParty={attendingWorkParty}
          setAttendingWorkParty={setAttendingWorkParty}
          selectedWorkPartyEventId={selectedWorkPartyEventId}
          setSelectedWorkPartyEventId={setSelectedWorkPartyEventId}
          workPartyError={workPartyError}
          setWorkPartyError={setWorkPartyError}
          workPartyClearedNotice={workPartyClearedNotice}
          setWorkPartyClearedNotice={setWorkPartyClearedNotice}
          availablePromoCodes={availablePromoCodes}
          promoCodesEnabled={promoCodesEnabled}
          prefillPromoCode={prefillPromoCode}
          setPrefillPromoCode={setPrefillPromoCode}
          cancelIfGuestsBumped={cancelIfGuestsBumped}
          setCancelIfGuestsBumped={setCancelIfGuestsBumped}
          setStep={setStep}
          handleSaveAsDraft={handleSaveAsDraft}
          handleSubmit={handleSubmit}
          submitting={submitting}
          savingDraft={savingDraft}
          memberGuestPendingHoldExpiryDays={memberGuestConfig.pendingHoldExpiryDays}
          exceptionOffer={exceptionOffer}
          replaceExceptionRequestId={replaceExceptionRequestId}
          submitExceptionRequest={submitExceptionRequest}
        />
      )}

      {/* Step 4: Pay (card path only; #1084). The booking already exists in
          the same state as the old redirect flow, so abandoning this step is
          safe — the booking page's payment card and banner take over. */}
      {step === "pay" && createdBooking && (
        <PayStep createdBooking={createdBooking} />
      )}
    </div>
  );
}
