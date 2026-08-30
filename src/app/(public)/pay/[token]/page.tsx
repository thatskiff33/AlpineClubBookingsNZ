"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import StripeProvider from "@/components/stripe/StripeProvider";
import PaymentForm from "@/components/stripe/PaymentForm";
import { useClubIdentity } from "@/components/club-identity-provider";
import {
  renderClientBookingMessage,
  type BookingMessageClubTokens,
} from "@/lib/booking-message-definitions";
import { useClubTime } from "@/components/club-time-provider";
import { formatCents } from "@/lib/utils";
import { FocusedActionError } from "@/components/focused-action-error";
import {
  EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_MESSAGE,
  isExistingCardTransactionStatusUnconfirmed,
  isPaymentReceivedFinalisationPending,
  isPaymentReceivedStatusUnconfirmed,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE,
} from "@/lib/payment-recovery-contract";
// The presentation layer this page renders through, split out when the club-time
// migration carried this file past its 500-line route-page budget. See that
// file's header for why an allowance was not the answer.
import {
  FinancialReviewNotice,
  formatLinkExpiry,
  formatStayDay,
  NarrativeCard,
  toneForState,
  type Narrative,
  type PaymentLinkContext,
  type PaymentRecovery,
} from "./pay-link-presentation";
/*
  #3194 (epic #2797): the sentences a member reads when their saved change is
  still being priced. Imported, never restated — the booking-detail banner
  composes the same ones, and two surfaces holding their own copy of a claim
  about a member's money is the defect this closes (`INV-SSOT`).
*/
import {
  financialReviewNote,
  financialReviewNoteBesideAnAmount,
} from "@/lib/booking-financial-review-copy";

export default function PayByLinkPage() {
  const club = useClubIdentity();
  /*
    `expiresAt` is a real INSTANT — the moment the link stops working — so it has
    no civil date until a zone is chosen, and the one to choose is the club's
    PERSISTED setting (CT-4, #2870; INV-CONFIG-002). Deliberately NOT the same
    route as the stay dates rendered beside it: those are calendar days and take
    no zone at all. Merging the two is the defect this epic exists to end.
  */
  const clubTime = useClubTime();
  const { token } = useParams<{ token: string }>();
  const [context, setContext] = useState<PaymentLinkContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [intentLoading, setIntentLoading] = useState(false);
  const [paymentRecovery, setPaymentRecovery] =
    useState<PaymentRecovery | null>(null);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [refreshState, setRefreshState] = useState<"idle" | "sending" | "sent">(
    "idle"
  );
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [bookingMessages, setBookingMessages] = useState<Record<string, string>>({});
  // #2919 review: the club-level values this page's message tokens resolve to.
  // Without them an operator's {{CLUB_LODGE_NAME}} reached the member as
  // literal braces.
  const [messageTokens, setMessageTokens] =
    useState<BookingMessageClubTokens | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/pay/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data.error || "This payment link is not valid.");
        } else {
          setContext(data);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError("Unable to load this payment link right now.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    fetch("/api/booking-messages")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setBookingMessages(data?.messages ?? {});
        setMessageTokens(data?.tokens ?? null);
      })
      .catch(() => {
        setBookingMessages({});
        setMessageTokens(null);
      });
  }, []);

  async function startCardPayment() {
    setIntentLoading(true);
    setIntentError(null);
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(token)}/payment-intent`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (
          res.status === 409 &&
          data.status === "CANCELLED" &&
          typeof data.refunded === "boolean"
        ) {
          setPaymentRecovery(
            data.refunded
              ? {
                  heading: "Booking cancelled - payment refunded",
                  message:
                    "The booking was cancelled because lodge capacity was no longer available, and the card payment was refunded. Reload the payment link to check the latest booking status. Do not try another payment.",
                }
              : {
                  heading: "Booking cancelled - refund needs attention",
                  message:
                    "The booking was cancelled because lodge capacity was no longer available, but the refund could not be confirmed. Reload the payment link and contact the club if the refund is not confirmed. Do not try another payment.",
                },
          );
          return;
        }
        if (
          res.status === 409 &&
          isPaymentReceivedFinalisationPending(data)
        ) {
          setPaymentRecovery({
            heading: "Payment received - finalisation pending",
            message:
              "Your card payment was received, but booking finalisation is still pending. Reload the payment link and check the booking status before trying any payment again.",
          });
          return;
        }
        if (res.status === 409 && isPaymentReceivedStatusUnconfirmed(data)) {
          setPaymentRecovery({
            heading: "Payment received - check booking status",
            message: PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE,
          });
          return;
        }
        if (
          res.status === 409 &&
          isExistingCardTransactionStatusUnconfirmed(data)
        ) {
          setPaymentRecovery({
            heading: "Card transaction found - check payment status",
            message: EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_MESSAGE,
          });
          return;
        }
        throw new Error(data.error || "Unable to start payment");
      }
      if (data.alreadyPaid) {
        setPaymentComplete(true);
        return;
      }
      setClientSecret(data.clientSecret);
    } catch (err) {
      setIntentError(err instanceof Error ? err.message : "Unable to start payment");
    } finally {
      setIntentLoading(false);
    }
  }

  async function requestFreshLink() {
    setRefreshState("sending");
    setRefreshError(null);
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(token)}/refresh`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to send a new link right now.");
      }
      if (data.emailed === false) {
        // The link was re-issued but nothing was delivered — either the address
        // previously bounced or complained (#1885), or the club has this booking
        // set to receive no email (#2258). Never claim an email is on the way,
        // and never say WHICH: the wording stays neutral so it is honest in both
        // cases and never reveals the per-booking switch to the member.
        setRefreshState("idle");
        setRefreshError(
          `We weren't able to email the link. Please contact ${club.lodgeName} and we'll help you complete payment.`
        );
        return;
      }
      setRefreshState("sent");
    } catch (err) {
      setRefreshState("idle");
      setRefreshError(
        err instanceof Error ? err.message : "Unable to send a new link right now."
      );
    }
  }

  if (loading) {
    return (
      <Card className="w-full max-w-lg">
        <CardContent className="py-8 text-center text-muted-foreground">Loading...</CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Payment Link</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2 text-warning-11">
            <AlertTriangle className="h-6 w-6 shrink-0" />
            <p className="font-medium">{loadError}</p>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Please check you copied the whole link from your email. If it still
            doesn&apos;t work, contact {club.lodgeName} and we&apos;ll send a fresh one.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!context) return null;

  /*
    #3194: the club is still working out an amount on this booking. Every branch
    below either renders `context.narrative` — which the server has already
    composed with the review sentences in it — or, where the branch renders a
    card of its own instead, shows the notice explicitly. There is no branch on
    this page that can reach a member without telling them.
  */
  const financialReviewPending = context.financialReviewPending === true;

  // A completed card payment lands here before the page is re-fetched.
  if (paymentComplete || context.state === "paid") {
    const serverNarrative = context.state === "paid";
    const narrative: Narrative = serverNarrative
      ? context.narrative
      : {
          state: "paid",
          headline: "Payment received",
          message: `Thanks ${context.firstName} — your payment is complete.`,
          // #2919: name the booking's OWN lodge, not the club default. The two
          // "contact us if this link fails" lines above stay club-level on
          // purpose — those are about the club, not about a stay.
          nextStep: `Your booking with ${context.lodgeName ?? club.lodgeName} is confirmed. We look forward to seeing you.`,
        };
    return (
      <NarrativeCard narrative={narrative} tone="success">
        {/*
          #3194: the member has just paid IN THIS SESSION, so the context on
          screen predates the payment and the card above is composed here rather
          than by the server. A booking under review reaches this branch — a
          CONFIRMED-unpaid booking can carry an open review and still be paid —
          and without this notice the last thing it would say is "your booking is
          confirmed, we look forward to seeing you", which is the same false
          reassurance in a different sentence.

          `moneyAlreadyMoved: false` is a fact, not a default: what moved here is
          the booking's OWN price, which the member just paid. Nothing has been
          refunded or charged FOR THE CHANGE, and a parked review settles nothing
          by construction.

          Not shown when the server supplied the narrative (`state === "paid"`),
          because the server composes the review sentences into it already and
          this would say them twice. That pairing does not arise from this
          repository's own server at all — a reviewed booking resolves to
          `financial_review_pending`, never to `paid` — but nothing validates
          this payload on the way in, so the guard stays rather than relying on
          that.
        */}
        {!serverNarrative && financialReviewPending ? (
          <FinancialReviewNotice
            note={financialReviewNote({ moneyAlreadyMoved: false })}
          />
        ) : null}
      </NarrativeCard>
    );
  }

  /*
    #3194: `canRequestFreshLink`, not `state === "expired_payable"`. On a booking
    under review the state is the WORDING state (`financial_review_pending`)
    while the link is still expired-but-payable, and the member still needs the
    button that emails them a new one. This field is the link's own fact and is
    identical to the old test on every booking that is not under review. The
    narrative rendered here is the server's, which already carries the review
    sentences.
  */
  if (context.canRequestFreshLink) {
    return (
      <NarrativeCard narrative={context.narrative} tone="info">
        {refreshState === "sent" ? (
          <div className="flex items-start gap-2 rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            <p>We&apos;ve emailed you a fresh payment link. Please check your inbox.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <Button onClick={requestFreshLink} disabled={refreshState === "sending"}>
              {refreshState === "sending" ? "Sending..." : "Email me a new link"}
            </Button>
            {refreshError ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {refreshError}
              </div>
            ) : null}
          </div>
        )}
      </NarrativeCard>
    );
  }

  /*
    #3194: `!context.payable`, not `state !== "payable"`, for the same reason as
    the branch above — `payable` is present exactly when this link can still take
    money, which a review does not change. Identical to the old test on every
    booking that is not under review.
  */
  if (!context.payable) {
    // bumped / cancelled / declined / under_review / financial_review_pending /
    // unknown — a clear, specific message with a concrete next step, and on a
    // reviewed booking the narrative the server composed carries the review
    // sentences, so no separate notice is needed here.
    //
    // A PAID booking under review lands HERE rather than in the paid branch
    // above, because its wording state is the review's. That is the path a
    // member takes when they paid by internet banking, or when a redirect-based
    // card method returns them to this URL and the page re-fetches — so the
    // narrative it renders has to confirm the payment as well as disclose the
    // review, and since #3194 it does (`buildPaidWithFinancialReviewNarrative`).
    const tone = toneForState(context.state);
    const showRebook =
      context.state === "bumped" ||
      context.state === "cancelled_pre_payment" ||
      context.state === "cancelled_post_payment" ||
      context.state === "declined";
    return (
      <NarrativeCard narrative={context.narrative} tone={tone}>
        {showRebook ? (
          <Link href="/booking-requests">
            <Button variant="outline">Book these dates again</Button>
          </Link>
        ) : null}
      </NarrativeCard>
    );
  }

  const payable = context.payable;

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Complete Your Payment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
          <p>
            Dates: {formatStayDay(payable.checkIn)} to{" "}
            {formatStayDay(payable.checkOut)}
          </p>
          <p className="mt-1">Guests: {payable.guestCount}</p>
          <p className="mt-1 font-semibold text-foreground">
            Amount due: {formatCents(payable.amountCents)}
          </p>
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            This payment link expires on{" "}
            {formatLinkExpiry(payable.expiresAt, clubTime)}.
          </p>
        </div>

        {/*
          #3194: directly under the amount, because the first sentence of the
          note is about that amount — the change being priced is not inside it.
          Above the pay controls rather than below them, so it is read before the
          member decides, and the controls stay armed: this booking's own price is
          genuinely due, and hiding the button would cost them the booking when
          the hold expired without moving a cent of the money under review.
        */}
        {financialReviewPending ? (
          <FinancialReviewNotice note={financialReviewNoteBesideAnAmount()} />
        ) : null}

        <FocusedActionError
          id="payment-link-recovery-error"
          error={paymentRecovery?.message ?? ""}
          heading={paymentRecovery?.heading}
          action={
            paymentRecovery ? (
              <Button variant="outline" onClick={() => window.location.reload()}>
                Reload payment status
              </Button>
            ) : undefined
          }
        />

        {paymentRecovery ? null : clientSecret ? (
          <StripeProvider clientSecret={clientSecret}>
            <PaymentForm
              amountCents={payable.amountCents}
              returnUrl={typeof window !== "undefined" ? window.location.href : ""}
              onSuccess={() => setPaymentComplete(true)}
              onError={() => undefined}
            />
          </StripeProvider>
        ) : (
          <div className="space-y-3">
            <Button onClick={startCardPayment} disabled={intentLoading}>
              {intentLoading ? "Preparing..." : "Pay by card"}
            </Button>
            {intentError ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {intentError}
              </div>
            ) : null}

            {payable.internetBankingReference ? (
              <div className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium text-foreground">Or pay by internet banking</p>
                <p className="mt-1 text-muted-foreground">
                  {/* #2919 review: every token this body may carry, not just the
                      payment reference — and the lodge is THIS booking's. */}
                  {renderClientBookingMessage({
                    template:
                      bookingMessages["paymentLink.internetBanking.description"],
                    fallback:
                      "Use reference {{paymentReference}} when making a direct transfer. The booking will be confirmed after the Xero invoice payment is reconciled.",
                    clubTokens: messageTokens,
                    lodgeName: context.lodgeName ?? null,
                    data: {
                      paymentReference: payable.internetBankingReference,
                    },
                  })}
                </p>
                <p className="mt-2 font-mono text-foreground">{payable.internetBankingReference}</p>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
