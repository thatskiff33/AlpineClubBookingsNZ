"use client";

import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ExternalLink, UserMinus } from "lucide-react";
import { buildProfilePathWithReturnTo } from "@/lib/internal-return-path";
import { DatesStep } from "./_components/dates-step";
import { GuestsStep } from "./_components/guests-step";
import { ReviewStep } from "./_components/review-step";
import { PayStep } from "./_components/pay-step";
import { PROFILE_FAMILY_GROUP_RETURN_TO_BOOK } from "./_components/types";
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
    expectedArrivalTime,
    setExpectedArrivalTime,
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
    handleRemoveConflictGuest,
    handleDateSelect,
    handleGuestsDone,
    handleSubmit,
    handleJoinWaitlist,
    handleSaveAsDraft,
    getGuestProfileBlockMessage,
    getGuestProfileActionLabel,
    formatConflictNights,
    formatConflictStatus,
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

      {/* Subscription warning banner */}
      {!subscriptionLoading && subscriptionUnpaid && (
        <Alert variant="warning">
          <p>
            <strong>Subscription unpaid:</strong> Your subscription for the{" "}
            {subscriptionStatus!.seasonDisplay} season is unpaid.{" "}
            {subscriptionInvoiceUrl ? (
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
            )}
          </p>
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
        <Alert variant="error" role="alert">
          <p>{error}</p>
          {guestProfileBlocks.length > 0 && (
            <div className="mt-3 space-y-3">
              {guestProfileBlocks.map((block) => {
                const actionLabel = getGuestProfileActionLabel(block);
                return (
                  <div
                    key={block.memberId}
                    className="rounded-md border border-red-200 bg-white/70 p-3"
                  >
                    <p className="font-medium text-red-800">{block.name}</p>
                    <p className="mt-1">{getGuestProfileBlockMessage(block)}</p>
                    {block.missingFields.length > 0 && (
                      <p className="mt-1 text-red-600">
                        Missing: {block.missingFields.join(", ")}
                      </p>
                    )}
                    {actionLabel && (
                      block.action === "complete_details" && block.canCurrentUserResolve ? (
                        <Link
                          href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}
                          className="mt-2 inline-flex text-sm font-medium text-red-800 underline underline-offset-4"
                        >
                          {actionLabel}
                        </Link>
                      ) : (
                        <p className="mt-2 font-medium text-red-800">{actionLabel}</p>
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
                  key={`${conflict.bookingId}-${conflict.guestId}`}
                  className="rounded-md border border-red-200 bg-white/70 p-3"
                >
                  <p className="font-medium text-red-800">
                    {conflict.memberName}
                  </p>
                  <p className="mt-1">
                    Already booked on {formatConflictNights(conflict.conflictingNights)} in a{" "}
                    {formatConflictStatus(conflict.bookingStatus)} booking owned by{" "}
                    {conflict.bookingOwnerName}.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {conflict.canOpenBooking && (
                      <Button
                        asChild
                        size="sm"
                        variant="outline"
                        className="border-red-200 text-red-800 hover:bg-red-100"
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
                        className="border-red-200 text-red-800 hover:bg-red-100"
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
                  {!conflict.canOpenBooking && !conflict.canSelfRemove && (
                    <p className="mt-2 text-red-600">
                      Ask the booking owner or an admin to update that booking before continuing.
                    </p>
                  )}
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
        </Alert>
      )}

      {showWaitlistPrompt && (
        <Card className="border-purple-200 bg-purple-50">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-purple-100 p-2 mt-0.5">
                <svg className="h-5 w-5 text-purple-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
              </div>
              <div>
                <h2 className="font-semibold text-purple-900">
                  {lodges.length > 1 && selectedLodge
                    ? `${selectedLodge.name} is fully booked`
                    : "Lodge is fully booked"}
                </h2>
                <p className="text-sm text-purple-700 mt-1">
                  {lodgeLabel} is at capacity on{" "}
                  {waitlistFullNights.length === 1
                    ? waitlistFullNights[0]
                    : `${waitlistFullNights.length} nights`}
                  . You can join the waitlist and we&apos;ll email you when a spot opens up.
                </p>
              </div>
            </div>
            {lodges.length > 1 && lodges.some((lodge) => lodge.id !== lodgeId) && (
              <div className="rounded-md border border-purple-200 bg-white p-4 space-y-2">
                <p className="text-sm font-medium text-purple-900">
                  Happy to stay at another lodge if a spot opens there first?
                </p>
                {lodges
                  .filter((lodge) => lodge.id !== lodgeId)
                  .map((lodge) => (
                    <label
                      key={lodge.id}
                      className="flex items-center gap-2 text-sm text-purple-800 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={waitlistAlternateLodgeIds.includes(lodge.id)}
                        onChange={(e) =>
                          setWaitlistAlternateLodgeIds((current) =>
                            e.target.checked
                              ? [...current, lodge.id]
                              : current.filter((id) => id !== lodge.id)
                          )
                        }
                        className="rounded border-purple-300"
                        disabled={joiningWaitlist}
                      />
                      Also waitlist me for {lodge.name}
                    </label>
                  ))}
                <p className="text-xs text-purple-700">
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
                className="bg-purple-600 hover:bg-purple-700"
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
                  <span aria-hidden="true" className="text-gray-300">
                    &rarr;
                  </span>
                )}
                <span
                  aria-current={isActive ? "step" : undefined}
                  className={isActive ? "app-step-active" : "text-gray-600"}
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
          expectedArrivalTime={expectedArrivalTime}
          setExpectedArrivalTime={setExpectedArrivalTime}
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
