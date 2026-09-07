import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";
import { BookingPaymentSection } from "@/components/booking-payment-section";
import { SwitchToInternetBankingButton } from "@/components/switch-to-internet-banking-button";
import { SendGuestPaymentLinkButton } from "@/components/send-guest-payment-link-button";
import { AdditionalPaymentCard } from "@/components/additional-payment-card";
import { BookingAdditionalPaymentPanel } from "@/components/admin/booking-additional-payment-panel";
import {
  additionalPaymentEpisodeStartedAt,
  isAdditionalPayableBookingStatus,
} from "@/lib/additional-payment-chase";
import { ConfirmDraftButton } from "@/components/confirm-draft-button";
import { WaitlistOfferCard } from "@/components/waitlist-offer-card";
import { getBookingPaymentMode } from "@/lib/booking-payment-flow";
import { WAITLIST_OFFER_HOURS } from "@/lib/waitlist";
import { isPaymentOwedBookingStatus } from "@/lib/booking-status";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BoundClubTime } from "@/lib/club-time";
import type { BookingDetailViewer } from "../_lib/booking-detail-viewer";
import type { BookingDetailEditAccess } from "../_lib/booking-detail-edit-access";
import type { BookingDetailLinkedParty } from "../_lib/booking-detail-linked-party";
import type { BookingDetailPayment } from "../_lib/booking-detail-payment";
import type { BookingDetailMessages } from "../_lib/booking-detail-messages";

/**
 * THE PAY DOORS (#2958): the draft confirm and complete-booking cards, the
 * waitlist position and offer cards, the internet-banking instructions, the
 * guest payment-link affordance, the on-hold notice, the complete-payment and
 * save-payment-method cards, and the two additional-payment surfaces (the
 * admin panel and the owner's card). Every gate is the one the page applied —
 * owner-positive where the member's own card details are involved (#1303),
 * `nonOwnerAdminViewer` for the admin-side view (#2350). Money is only ever
 * displayed here; the routes behind each control settle it. Moved verbatim
 * from `page.tsx`.
 */
export function BookingPaymentCards({
  booking,
  club,
  viewer,
  access,
  party,
  payment,
  messages,
}: {
  booking: BookingDetailRecord;
  club: BoundClubTime;
  viewer: BookingDetailViewer;
  access: BookingDetailEditAccess;
  party: BookingDetailLinkedParty;
  payment: BookingDetailPayment;
  messages: BookingDetailMessages;
}) {
  const { canManageBooking, isBookingOwner, nonOwnerAdminViewer, canSeeAdminTools } =
    viewer;
  const { isDeleted, isDraft, isWaitlisted, isWaitlistOffered } = access;
  const { hasProvisionalChildren, provisionalChildGuestCount } = party;
  const {
    internetBankingPayment,
    canSwitchToInternetBanking,
    showGuestPaymentLinkStandalone,
    showSavePaymentMethodCard,
    showPaymentOnHoldNotice,
    showCompletePaymentCard,
    creditAppliedCents,
    showCreditApplied,
    amountDueAfterCreditCents,
  } = payment;
  const {
    paymentRequiredDescription,
    internetBankingPendingDescription,
    switchToInternetBankingDescription,
  } = messages;
  return (
    <>
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
    </>
  );
}
