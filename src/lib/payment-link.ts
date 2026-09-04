/**
 * Tokenised public payment links (issue #707).
 *
 * A PaymentLink lets a verified, approved booking requester pay for their
 * booking without an account. Only SHA-256 token hashes are stored; the raw
 * token is emailed once. Every resolution path refuses politely without
 * leaking whether a token, booking, or request exists.
 */
import { BookingStatus, PaymentStatus, PaymentTransactionKind, Prisma } from "@prisma/client";
import {
  hashActionToken,
  isActionTokenFormat,
  issueActionToken,
} from "@/lib/action-tokens";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import {
  resolveBookingNarrative,
  type BookingNarrative,
  type BookingNarrativeState,
  type NarrativeEvent,
  type ResolveBookingNarrativeInput,
} from "@/lib/booking-narrative";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { getDefaultLodgeId } from "@/lib/lodges";
import { bindClubTime } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { paymentLinkExpiryForCheckIn } from "@/lib/payment-link-expiry";
import {
  sendAdminPaymentFailureAlert,
  sendBookingRequestApprovedEmail,
  sendSplitGuestPaymentLinkEmail,
} from "@/lib/email";
import { formatCents } from "@/lib/utils";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import {
  findPaymentTransactionByIntentId,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import { isHostingCoverageParticipantRetry } from "@/lib/adult-member-hosting-queue-participants";
import { queueSupersededPrimaryIntentCancellations } from "@/lib/booking-payment-cleanup";
import { prisma } from "@/lib/prisma";
import {
  createPaymentIntent,
  findOrCreateCustomer,
  getPaymentIntent,
} from "@/lib/stripe";
import { queueXeroInvoiceForPaidBooking } from "@/lib/xero-booking-invoice-queue";

/** A paid booking and a completed stay are both "already paid" for link purposes. */
const PAID_LIKE_STATUSES: readonly BookingStatus[] = [
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
];

function isPaidLikeStatus(status: BookingStatus): boolean {
  return PAID_LIKE_STATUSES.includes(status);
}

/** Booking statuses a payment link can still pay for. */
const PAYMENT_LINK_PAYABLE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
] as const;

export class PaymentLinkError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PaymentLinkError";
    this.status = status;
  }
}

export type PaymentLinkPaymentRecoveryKind =
  | "payment_received_finalisation_pending"
  | "payment_received_status_unconfirmed"
  | "existing_card_status_unconfirmed"
  | "cancelled_refunded"
  | "cancelled_refund_pending";

/**
 * Provider-safe recovery signal for failures after Stripe reports a successful
 * intent. The public route maps only these fixed phases and never exposes the
 * intent id or the underlying provider/database error.
 */
export class PaymentLinkPaymentRecoveryError extends Error {
  constructor(readonly kind: PaymentLinkPaymentRecoveryKind) {
    super("Payment-link card status requires recovery");
    this.name = "PaymentLinkPaymentRecoveryError";
  }
}

const INVALID_LINK_MESSAGE = "This payment link is not valid.";
const EXPIRED_LINK_MESSAGE =
  "This payment link has expired. Please contact the club if you still wish to pay for your stay.";
const USED_LINK_MESSAGE = "This payment link has already been used.";
const REVOKED_LINK_MESSAGE =
  "This payment link is no longer active. Please contact the club for help.";
const NOT_PAYABLE_MESSAGE =
  "This booking can no longer be paid online. Please contact the club for help.";
/**
 * #2265 (#2319 door 1). Deliberately vague to the payer, who is often not the
 * member whose credit is involved: it says the booking needs to be paid another
 * way and points at the club, without disclosing that a member holds an account
 * credit balance or how much of it they elected to spend. The operator alert
 * raised alongside carries the full detail.
 */
const CREDIT_ELECTION_PENDING_MESSAGE =
  "This booking has to be paid from the member's own account rather than through this link. Please contact the club and they'll sort it out.";

/**
 * Signals the unconsumed-credit-election refusal from inside the revalidation
 * transaction (#2265). Thrown, rather than returned, so the transaction rolls
 * back; caught immediately outside it, where the operator alert can be sent
 * without an SES call sitting inside an open transaction.
 */
class UnconsumedCreditElectionError extends Error {
  constructor(readonly electionCents: number) {
    super("Booking carries an unconsumed credit election");
    this.name = "UnconsumedCreditElectionError";
  }
}


type ResolvedPaymentLink = Prisma.PaymentLinkGetPayload<{
  include: {
    booking: {
      include: {
        member: true;
        guests: true;
        payment: true;
        groupBookingJoin: { select: { id: true } };
        lodge: { select: { name: true } };
      };
    };
  };
}>;

/**
 * Structural lookup of a payment link by raw token. Throws only for a token
 * that cannot map to a live booking (bad format, unknown token, soft-deleted
 * booking). The link may be revoked/used/expired and the booking may be in any
 * state — callers decide what to do with it. Used by the narrative context
 * path, which renders a clear message for every link/booking state rather than
 * a generic error.
 */
async function loadPaymentLinkRecord(token: string): Promise<ResolvedPaymentLink> {
  const trimmed = token.trim();
  if (!isActionTokenFormat(trimmed)) {
    throw new PaymentLinkError(INVALID_LINK_MESSAGE, 404);
  }

  const link = await prisma.paymentLink.findUnique({
    where: { tokenHash: hashActionToken(trimmed) },
    include: {
      booking: {
        include: {
          member: true,
          guests: true,
          payment: true,
          // #1967: lets link flows tell a genuine split child (#738) apart
          // from a #796 group joiner (which always has a join row).
          groupBookingJoin: { select: { id: true } },
          // #2919: the public pay page names the lodge the booking is actually
          // at. Name only - never the door code or travel note, which this
          // token-authenticated public surface has no business carrying.
          lodge: { select: { name: true } },
        },
      },
    },
  });

  if (!link || link.booking.deletedAt) {
    throw new PaymentLinkError(INVALID_LINK_MESSAGE, 404);
  }

  return link;
}

// test seam
/**
 * Look up and validate a payment link by raw token for the payment path
 * (intent creation). Throws PaymentLinkError with a polite message for every
 * failure mode. Returns the link with its booking when the link is still
 * usable (the booking may already be paid/completed — callers handle that
 * explicitly). A paid or completed booking is treated alike (issue #740).
 */
export async function resolvePaymentLink(token: string): Promise<ResolvedPaymentLink> {
  const link = await loadPaymentLinkRecord(token);

  if (link.revokedAt) {
    throw new PaymentLinkError(REVOKED_LINK_MESSAGE, 410);
  }
  if (link.usedAt && !isPaidLikeStatus(link.booking.status)) {
    throw new PaymentLinkError(USED_LINK_MESSAGE, 410);
  }
  if (link.expiresAt < new Date() && !isPaidLikeStatus(link.booking.status)) {
    throw new PaymentLinkError(EXPIRED_LINK_MESSAGE, 410);
  }

  return link;
}

/** The data the public page needs to actually take a payment. */
interface PaymentLinkPayable {
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: BookingStatus;
  amountCents: number;
  /**
   * The bank-transfer reference, present only when the optional Internet
   * Banking module is on. Omitted when the module is off so the public pay
   * page never offers a payment method the club hasn't enabled.
   */
  internetBankingReference?: string;
  /**
   * The link's hard expiry, ISO. The END OF THE CHECK-IN DAY in the club's
   * PERSISTED timezone (`payment-link-expiry.ts`, `INV-CONFIG-002`) — not the
   * container's, and not spelled as an abbreviation, which `INV-CONFIG-002`
   * forbids and which names one country's zone in a generic product
   * (`INV-CONFIG-001`). The pay page renders this value in that same zone.
   */
  expiresAt: string;
}

export interface PaymentLinkContext {
  state: BookingNarrativeState;
  /** Rich, plain-language wording shared with the admin booking history. */
  narrative: BookingNarrative;
  firstName: string;
  /** Present only when the booking can still be paid via this link. */
  payable: PaymentLinkPayable | null;
  /**
   * True when the page should offer the "email me a fresh link" action.
   *
   * READ THIS RATHER THAN `state === "expired_payable"` (#3194): `state` is the
   * WORDING state and this is the LINK state, and on a booking under review they
   * differ. `payable` above is the same shape of fact, read the same way.
   */
  canRequestFreshLink: boolean;
  /**
   * #3194 (epic #2797): this booking has an OPEN financial review — a saved
   * stay or guest change whose refund or charge the club is still working out.
   *
   * The pay page shows the review wording from this, composed from
   * `booking-financial-review-copy.ts` — the booking-detail banner's own home
   * for those sentences. Before this field the two pages answered one question
   * differently, and the payment link was the one that had not checked.
   */
  financialReviewPending: boolean;
  /**
   * Name of the lodge THIS booking is at (#2919), so the public pay page's
   * confirmation copy names the right property in a multi-lodge club instead of
   * falling back to the club's default lodge. Single-lodge clubs see no change.
   */
  lodgeName: string;
}

/**
 * Build the public payment page context for a raw token. Resolves the booking's
 * narrative from its durable events so guests see the same wording as admins,
 * for every state — payable, expired-but-payable, paid, bumped, cancelled,
 * declined — never a generic error. Marks the link used (idempotently) once the
 * booking is paid/completed so it cannot be replayed.
 */
export interface PaymentLinkContextReaders {
  /**
   * Whether this booking has an OPEN financial review.
   *
   * INJECTED, and required with no default (#3194). The one canonical answer
   * lives in `booking-financial-review-visibility.ts`, which carries
   * `import "server-only"` — and this module deliberately does not: it takes the
   * club's timezone through `readClubTimeZoneOutsideRequest` for exactly that
   * reason, and `cli-server-only-reach-census.test.ts` fails any operator script
   * that regains such an edge. So the read is done by the caller that is
   * unambiguously a server request — `src/app/api/pay/[token]/route.ts` — and
   * handed down, the same way `resolveBookingNarrative` takes the answer as data
   * rather than reading it.
   *
   * No default, so a second caller has to answer the question rather than
   * inherit a silent "no" about a member's money (`INV-SSOT`, "prefer
   * unrepresentable over policed").
   */
  readOpenFinancialReview: (bookingId: string) => Promise<boolean>;
}

export async function getPaymentLinkContext(
  token: string,
  { readOpenFinancialReview }: PaymentLinkContextReaders,
): Promise<PaymentLinkContext> {
  const link = await loadPaymentLinkRecord(token);
  const booking = link.booking;
  const now = new Date();

  const events = await prisma.bookingEvent.findMany({
    where: { bookingId: booking.id },
    orderBy: { occurredAt: "asc" },
    select: {
      type: true,
      occurredAt: true,
      amountCents: true,
      reason: true,
      snapshot: true,
    },
  });

  // The narrative names the day a payment, cancellation or settlement landed
  // AT THE CLUB, so it is read in the club's persisted zone rather than the
  // container's (#3123). The runtime reader, not `clubTime()`: this module is
  // reachable from `src/instrumentation.node.ts`, where `server-only` throws at
  // import. Its stay dates are @db.Date lodge nights and take no zone.
  const club = bindClubTime(await readClubTimeZoneOutsideRequest());

  const financialReviewPending = await readOpenFinancialReview(booking.id);

  const narrativeInput = {
    club,
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
    events: events.map(
      (event): NarrativeEvent => ({
        type: event.type,
        occurredAt: event.occurredAt,
        amountCents: event.amountCents,
        reason: event.reason,
        snapshot: event.snapshot,
      })
    ),
    link: {
      expiresAt: link.expiresAt,
      usedAt: link.usedAt,
      revokedAt: link.revokedAt,
    },
    now,
  } satisfies ResolveBookingNarrativeInput;

  /*
    ONE PURE FUNCTION, ASKED TWO DIFFERENT QUESTIONS (#3194) — not a duplicated
    call, and the difference between the two is what keeps a reviewed booking
    payable.

    `narrative` is WHAT THE MEMBER IS TOLD. It is review-aware, so a paid booking
    under review stops saying "nothing more to do" and a payable one gains the
    review sentences alongside its amount — which is the whole of this issue.

    `paymentState` is WHAT THIS LINK CAN STILL DO, and a review changes nothing
    about that: the review is about an adjustment to a change, while the link
    collects the booking's own STORED price.

    That stored price is the PRE-CHANGE one, and saying so is the point rather
    than a caveat (#3194 fix round). Both services that can park an edit write
    `finalPriceCents` back unchanged - deliberately, so nothing settles on a
    change whose money nobody could work out - while saving the new dates and
    deleting the departing guest's row. So `payable` below is built from a
    post-edit stay and a pre-edit amount, and the note the page renders directly
    under that amount says exactly that
    (`FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE`). The link stays armed
    because the member still has to be able to pay and a hold that expires costs
    them the booking - not because the figure is final.

    Deriving `payable` from the review-aware
    state instead would have handed a CONFIRMED-unpaid member a page that says
    "pay by card or internet banking below" with nothing below it, and an
    expired-link member a page with no "email me a new link" button — they would
    then pay nothing, the hold would expire, and the booking would cancel. That
    is precisely the harm `FINANCIAL_REVIEW_NOTHING_TO_DO` is scoped to avoid,
    reintroduced one layer down.

    The second call is free of side effects and of I/O: `resolveBookingNarrative`
    reads only its input (see its file header), so asking it twice costs one
    object walk and cannot diverge from the first answer.
  */
  const narrative = resolveBookingNarrative({
    ...narrativeInput,
    financialReviewPending,
  });
  const paymentState = financialReviewPending
    ? resolveBookingNarrative(narrativeInput).state
    : narrative.state;

  // A paid/completed booking burns the link so it cannot be replayed.
  if (isPaidLikeStatus(booking.status) && !link.usedAt) {
    await prisma.paymentLink
      .update({ where: { id: link.id }, data: { usedAt: now } })
      .catch((err) =>
        logger.error({ err, paymentLinkId: link.id }, "Failed to mark payment link used")
      );
  }

  // Internet Banking is an optional module; only surface the bank-transfer
  // reference on the public pay page when the club has it enabled.
  const ibModules =
    paymentState === "payable" ? await loadEffectiveModuleFlags() : null;
  const internetBankingEnabled = Boolean(
    ibModules?.xeroIntegration && ibModules?.internetBankingPayments
  );

  const payable: PaymentLinkPayable | null =
    paymentState === "payable"
      ? {
          checkIn: booking.checkIn.toISOString(),
          checkOut: booking.checkOut.toISOString(),
          guestCount: booking.guests.length,
          status: booking.status,
          amountCents: booking.finalPriceCents,
          ...(internetBankingEnabled
            ? {
                internetBankingReference: buildInternetBankingPaymentReference(
                  booking.id
                ),
              }
            : {}),
          expiresAt: link.expiresAt.toISOString(),
        }
      : null;

  return {
    state: narrative.state,
    narrative,
    firstName: booking.member.firstName,
    payable,
    canRequestFreshLink: paymentState === "expired_payable",
    lodgeName: booking.lodge.name,
    financialReviewPending,
  };
}

/**
 * Re-issue a payment link for an expired-but-payable booking and email the
 * requester a fresh one (the self-service "fresh link" action offered on the
 * expired-link page). Revokes any prior unused links for the booking. The new
 * link expires at the end of the check-in day in the CLUB's persisted timezone
 * (`payment-link-expiry.ts`), which is where every one of this boundary's four
 * decisions now reads it from.
 *
 * Returns `emailed: false` when the requester's address is actively
 * suppressed (prior SES bounce/complaint) — nothing was delivered, so the UI
 * must not promise an email that will never arrive (F25, #1885).
 */
export async function reissuePaymentLinkForToken(
  token: string
): Promise<{ emailed: boolean }> {
  const link = await loadPaymentLinkRecord(token);
  const booking = link.booking;

  if (
    !(PAYMENT_LINK_PAYABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
      booking.status
    )
  ) {
    throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
  }

  // Zone read BEFORE the mint transaction, which holds the capacity lock.
  const clubZone = await readClubTimeZoneOutsideRequest();
  const expiresAt = paymentLinkExpiryForCheckIn(booking.checkIn, clubZone);
  if (expiresAt.getTime() < Date.now()) {
    throw new PaymentLinkError(
      "These dates have already passed, so a new payment link can't be issued.",
      410
    );
  }

  // #2258: decide BEFORE the revoke-and-mint below. This path REPLACES the
  // member's existing link (raw tokens are unrecoverable, so re-sending means
  // minting a new one and revoking the old). Discovering the withhold only at
  // send time therefore did not merely churn — it destroyed a link that still
  // worked and left an unreachable one in its place. Read from the row already
  // loaded; the authoritative, fail-closed gate still runs inside sendEmail.
  if (booking.noEmails) {
    logger.warn(
      { bookingId: booking.id },
      'Did not re-issue a payment link: the booking has "No emails" turned on'
    );
    // The member is told only that nothing could be emailed (see the outcome
    // handling below) — never why. Their existing link is left untouched.
    return { emailed: false };
  }

  const { token: freshToken, tokenHash } = issueActionToken();

  await prisma.$transaction(async (tx) => {
    // Serialise with every other mint path (#1967): the settlement cron and
    // the on-demand split-guest flow both mint under the per-lodge advisory
    // lock, so taking it here too makes revoke-then-create atomic across all
    // three writers — at most one live token can exist for the booking.
    const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);
    await tx.paymentLink.updateMany({
      where: { bookingId: booking.id, revokedAt: null, usedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.paymentLink.create({
      data: {
        bookingId: booking.id,
        bookingRequestId: link.bookingRequestId,
        tokenHash,
        expiresAt,
      },
    });
  });

  // #1967 (FIX): a split non-member child's expired link must be re-issued
  // with the split-guest wording, not the request-origin "booking request
  // approved" template — the member never made a booking request. Group
  // joiners (#796, also parent-linked but always carrying a join row) keep
  // their pre-existing behaviour.
  const isSplitGuestLink =
    booking.parentBookingId != null &&
    !booking.groupBookingJoin &&
    !link.bookingRequestId;

  const emailParams = {
    email: booking.member.email,
    firstName: booking.member.firstName,
    lodgeId: booking.lodgeId ?? null,
    token: freshToken,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestCount: booking.guests.length,
    priceCents: booking.finalPriceCents,
    bookingReference: booking.id,
    expiresAt,
    // The pay link is about this booking (#2258).
    bookingContext: {
      bookingId: booking.id,
      recipientMemberId: booking.memberId,
    } as const,
  };
  const emailOutcome = isSplitGuestLink
    ? await sendSplitGuestPaymentLinkEmail(emailParams)
    : await sendBookingRequestApprovedEmail(emailParams);

  if (emailOutcome.status === "suppressed") {
    // sendEmail delivered nothing (recipient is SES-suppressed after a prior
    // bounce/complaint). Report truthfully so the page can tell the requester
    // to contact the club instead of watching an inbox that stays empty.
    logger.warn(
      {
        bookingId: booking.id,
        emailSuppressionId: emailOutcome.emailSuppressionId,
        reason: emailOutcome.reason,
      },
      "Fresh payment link issued but the email was suppressed; recipient undeliverable"
    );
    return { emailed: false };
  }

  if (emailOutcome.status === "withheld_for_booking") {
    // #2258: nothing was sent. `emailed: false` is the ONLY thing the member is
    // told — the caller renders the same neutral "we couldn't email it, please
    // contact the club" wording it uses for an undeliverable address. The member
    // must never learn that a per-booking switch exists, let alone that theirs
    // is set; that is an internal club decision and surfacing it would both leak
    // an admin control and invite the member to argue with it.
    logger.warn(
      { bookingId: booking.id, reason: emailOutcome.reason },
      "Fresh payment link issued but the email was withheld by the booking's email gate"
    );
    return { emailed: false };
  }

  if (emailOutcome.status !== "sent") {
    /*
      FAIL CLOSED on anything else the mailer returns. This used to enumerate the
      untransmitted outcomes and then `return { emailed: true }`, which meant the
      environment-safety withhold added by #3035 would have reported a payment
      link as emailed when nothing left the building — and so would the next new
      outcome after it. The member is told the same neutral "we could not email
      it" as for an undeliverable address; which internal reason applied is never
      surfaced to them.
    */
    logger.warn(
      { bookingId: booking.id, emailStatus: emailOutcome.status },
      "Fresh payment link issued but the email was not transmitted"
    );
    return { emailed: false };
  }

  return { emailed: true };
}

export type PaymentLinkIntentResult =
  | { type: "alreadyPaid" }
  | { type: "clientSecret"; clientSecret: string; paymentIntentId: string };

/**
 * Token-authenticated Stripe payment intent creation. Runs the SAME
 * status and capacity revalidation as the session-gated
 * /api/payments/create-payment-intent path before any Stripe call:
 *   1. booking must still be payable (status check)
 *   2. existing PaymentIntents are reused/reconciled, not duplicated
 *   3. capacity is revalidated under the booking advisory lock
 * Final capacity claiming happens in markBookingPaymentSucceeded exactly
 * as it does for session payments and webhooks.
 */
export async function createPaymentIntentForPaymentLink(
  token: string
): Promise<PaymentLinkIntentResult> {
  const link = await resolvePaymentLink(token);
  const booking = link.booking;

  if (isPaidLikeStatus(booking.status)) {
    throw new PaymentLinkError(USED_LINK_MESSAGE, 410);
  }

  if (
    !(PAYMENT_LINK_PAYABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
      booking.status
    )
  ) {
    throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
  }

  // Reuse or reconcile an existing PaymentIntent before creating a new one
  // (same behaviour as the session payment-intent route).
  //
  // A refunded succeeded intent remains the current Payment pointer until the
  // fresh PRIMARY transaction below is recorded. Carry that exact intent id as
  // a repayment generation marker so the refunded intent cannot fall through
  // to the generic equal-amount/client-secret reuse arm, and so retries use a
  // Stripe idempotency key disjoint from every non-repayment generation.
  let repaySupersededIntentId: string | null = null;
  if (booking.payment?.stripePaymentIntentId) {
    const existingIntent = await getPaymentIntent(booking.payment.stripePaymentIntentId);

    if (existingIntent.status === "succeeded") {
      // A refunded PaymentIntent remains `succeeded` at Stripe. The immutable
      // local transaction row is therefore the discriminator between a
      // captured payment that needs reconciliation and refund history that
      // must lead to a fresh repayment intent.
      let refundedHistory: boolean;
      try {
        const pointedTransaction = await findPaymentTransactionByIntentId({
          paymentIntentId: existingIntent.id,
        });
        refundedHistory = pointedTransaction
          ? pointedTransaction.status === PaymentStatus.REFUNDED ||
            pointedTransaction.status === PaymentStatus.PARTIALLY_REFUNDED
          : booking.payment.status === PaymentStatus.REFUNDED ||
            booking.payment.status === PaymentStatus.PARTIALLY_REFUNDED;
      } catch (error) {
        logger.error(
          { err: error, bookingId: booking.id },
          "Could not classify an existing successful payment-link intent",
        );
        throw new PaymentLinkPaymentRecoveryError(
          "existing_card_status_unconfirmed",
        );
      }

      if (refundedHistory) {
        repaySupersededIntentId = existingIntent.id;
        await queueSupersededPrimaryIntentCancellations(prisma, {
          bookingId: booking.id,
          paymentId: booking.payment.id,
          newFinalPriceCents: booking.finalPriceCents,
        });
      } else {
      // #2265 (#2319 door 1, settle arm). The card money is already captured, so
      // a stored credit election can no longer be honoured here — but the clear
      // and its reporting live in `markBookingPaymentSucceeded` below, the single
      // settle door every card path funnels through, rather than being repeated
      // in this caller. When the payment is ALREADY SUCCEEDED this arm settles
      // nothing at all, so an earlier run through that same door has already
      // dealt with it.
        try {
          if (booking.payment.status !== PaymentStatus.SUCCEEDED) {
            const reconciliation = await markBookingPaymentSucceeded({
              bookingId: booking.id,
              paymentIntentId: existingIntent.id,
              amountCents: existingIntent.amount,
              paymentMethodId:
                typeof existingIntent.payment_method === "string"
                  ? existingIntent.payment_method
                  : existingIntent.payment_method?.id ?? null,
            });

            if (reconciliation.outcome === "cancelled_refunded") {
              throw new PaymentLinkPaymentRecoveryError("cancelled_refunded");
            }
            if (reconciliation.outcome === "cancelled_refund_failed") {
              throw new PaymentLinkPaymentRecoveryError(
                "cancelled_refund_pending",
              );
            }
          }

          await queueXeroInvoiceForPaidBooking({ bookingId: booking.id });
        } catch (error) {
          if (error instanceof PaymentLinkPaymentRecoveryError) throw error;
          logger.error(
            { err: error, bookingId: booking.id },
            "A captured payment-link payment could not finish locally",
          );
          throw new PaymentLinkPaymentRecoveryError(
            isHostingCoverageParticipantRetry(error)
              ? "payment_received_finalisation_pending"
              : "payment_received_status_unconfirmed",
          );
        }

        return { type: "alreadyPaid" };
      }
    }

    if (
      repaySupersededIntentId === null &&
      existingIntent.status !== "canceled" &&
      existingIntent.amount !== booking.finalPriceCents
    ) {
      // The booking was modified after this intent was minted (#1161): a
      // stale client_secret would capture the old total. Queue the stale
      // intent's cancellation and fall through to mint a fresh one.
      if (booking.payment) {
        await queueSupersededPrimaryIntentCancellations(prisma, {
          bookingId: booking.id,
          paymentId: booking.payment.id,
          newFinalPriceCents: booking.finalPriceCents,
        });
      }
    } else if (
      repaySupersededIntentId === null &&
      existingIntent.client_secret &&
      existingIntent.status !== "canceled"
    ) {
      return {
        type: "clientSecret",
        clientSecret: existingIntent.client_secret,
        paymentIntentId: existingIntent.id,
      };
    }
  }

  // Capacity/status revalidation under the shared booking advisory lock,
  // mirroring the session path's preflight before charging.
  await prisma.$transaction(async (tx) => {
    // Pre-lock read: only the lock key. lodgeId is immutable, so keying the
    // lock from this read is safe; the status re-validation and capacity check
    // consume ONLY the post-lock re-read below.
    const lockTarget = await tx.booking.findUnique({
      where: { id: booking.id },
      select: { lodgeId: true },
    });
    const bookingLodgeId = lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    const freshBooking = await tx.booking.findUnique({
      where: { id: booking.id },
      // Load per-night sets (issue #713) so a non-contiguous booking is
      // capacity-checked on the nights it actually occupies.
      include: { guests: { include: { nights: true } } },
    });

    if (
      !freshBooking ||
      !(PAYMENT_LINK_PAYABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
        freshBooking.status
      )
    ) {
      throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
    }

    // #2265 (#2319 door 1, minting arm). A booking still carrying a stored
    // credit election must not be charged the full price through a public link.
    //
    // Refuse rather than consume, and the reason is authorisation, not scope. The
    // election is the member's standing request to spend money out of their own
    // account-credit balance; this route is authenticated by a bearer token that
    // is routinely held by SOMEONE ELSE (a booking requester, a group joiner, a
    // non-member guest paying for their beds), carries no member session, and has
    // no surface on which to show the member that their election was clamped by a
    // balance or a price that moved. Debiting a member's balance on a
    // third-party's token, with the outcome reportable to nobody, is a worse
    // property than declining to take the payment here.
    //
    // Refuse rather than CLEAR, too: nothing is lost by refusing, because the
    // election is still perfectly honourable — the pay step and the
    // switch-to-Internet-Banking route both consume it, and every booking that
    // can carry one belongs to a member with a login. Clearing would throw away
    // the member's request to make a charge convenient, which is #2265's original
    // bug wearing a different hat. Clearing is only right once the money is
    // actually taken, which is the succeeded-intent arm above.
    //
    // Read from the post-lock re-read, so a concurrent pay step that consumed the
    // election a moment ago is seen to have done so and the payer is not refused
    // for nothing. This state is not reachable by any flow that exists today —
    // no PaymentLink mint path attaches a link to a booking that can carry an
    // election — so the guard is an assertion of that invariant rather than a
    // routine branch, and it alerts loudly instead of failing quietly if some
    // future mint path breaks it.
    // The alert and the refusal are raised OUTSIDE this transaction (the SES
    // send must not sit inside a database transaction), so signal with a private
    // error the catch below translates.
    if (freshBooking.creditElectionCents != null) {
      throw new UnconsumedCreditElectionError(freshBooking.creditElectionCents);
    }

    // Re-read the link under the same lock (#1967 FIX-6): the auto-charge cron
    // revokes a booking's links inside its claim transaction (also under this
    // lodge lock) before charging the saved card, so a /pay request that
    // resolved the link just before that claim must not go on to mint an
    // intent — the saved-card charge now owns settlement.
    const freshLink = await tx.paymentLink.findUnique({
      where: { id: link.id },
      select: { revokedAt: true },
    });
    if (!freshLink || freshLink.revokedAt) {
      throw new PaymentLinkError(REVOKED_LINK_MESSAGE, 410);
    }

    const capacity = await checkCapacityForGuestRanges(
      bookingLodgeId,
      freshBooking.checkIn,
      freshBooking.checkOut,
      freshBooking.guests,
      booking.id,
      tx
    );

    if (!capacity.available && bookingHasCapacityOverride(freshBooking)) {
      // Persisted capacity override (#1771): the booking was deliberately
      // admitted above the ceiling by an admin, so a payment link must not 409
      // it — fall through and let the payment proceed.
      logger.info(
        { bookingId: booking.id },
        "Paying an over-capacity booking with a persisted capacity override (#1771); skipping the payment-link capacity block"
      );
    }
    if (!capacity.available && !bookingHasCapacityOverride(freshBooking)) {
      throw new PaymentLinkError(
        "Not enough beds remain available for these dates. Please contact the club.",
        409
      );
    }
  }).catch(async (err: unknown) => {
    // #2265 (#2319 door 1). The unconsumed-election refusal is signalled from
    // inside the transaction so it rolls back with everything else, and is turned
    // into the payer-facing 409 out here — where the operator alert can be sent
    // without holding a database transaction open across an SES call. Every other
    // error, including the route's own PaymentLinkErrors, propagates untouched.
    if (!(err instanceof UnconsumedCreditElectionError)) throw err;

    logger.error(
      {
        bookingId: booking.id,
        paymentLinkId: link.id,
        creditElectionCents: err.electionCents,
      },
      "Refused a payment-link intent for a booking carrying an unconsumed credit election: a public link must not charge the pre-credit price, nor spend a member's credit balance on a bearer token (#2265)"
    );
    await sendAdminPaymentFailureAlert({
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      amountCents: err.electionCents,
      errorMessage: `This booking still has a saved account-credit choice of ${formatCents(err.electionCents)} on it, so the payment link declined to take a card payment: charging through the link would bill the full price and ignore the credit, and a public link must not spend a member's credit balance on its own authority. Nothing was charged and the saved choice is untouched. Ask the member to pay from their own bookings page, where the credit is applied and the card is charged only the remainder.`,
      // No intent exists — nothing was minted — so give the officer the booking
      // reference to search on instead.
      paymentIntentId: booking.id,
    }).catch((alertErr) =>
      logger.error(
        { err: alertErr, bookingId: booking.id },
        "Failed to alert admins about a payment link refused for an unconsumed credit election"
      )
    );

    throw new PaymentLinkError(CREDIT_ELECTION_PENDING_MESSAGE, 409);
  });

  // Stripe calls stay outside the database transaction.
  const customer = await findOrCreateCustomer({
    email: booking.member.email,
    name: `${booking.member.firstName} ${booking.member.lastName}`,
    memberId: booking.member.id,
  });

  const paymentIntent = await createPaymentIntent({
    amountCents: booking.finalPriceCents,
    customerId: customer.id,
    metadata: {
      bookingId: booking.id,
      memberId: booking.memberId,
      paymentLinkId: link.id,
    },
    idempotencyKey: repaySupersededIntentId
      ? `pl_pi_${booking.id}_repay_${repaySupersededIntentId}`
      : `pl_pi_${booking.id}_${booking.payment?.stripePaymentIntentId ?? "initial"}`,
  });

  const payment = await prisma.payment.upsert({
    where: { bookingId: booking.id },
    create: {
      bookingId: booking.id,
      amountCents: booking.finalPriceCents,
      stripeCustomerId: customer.id,
      status: PaymentStatus.PENDING,
    },
    update: {
      stripeCustomerId: customer.id,
    },
  });

  await upsertPaymentIntentTransaction({
    paymentId: payment.id,
    kind: PaymentTransactionKind.PRIMARY,
    paymentIntentId: paymentIntent.id,
    amountCents: booking.finalPriceCents,
    status: PaymentStatus.PROCESSING,
    reason: repaySupersededIntentId
      ? "payment_link_repay_after_refund"
      : "payment_link_booking_payment",
    stripeCustomerId: customer.id,
  });

  if (!paymentIntent.client_secret) {
    throw new PaymentLinkError("Unable to start the payment. Please try again.", 500);
  }

  return {
    type: "clientSecret",
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

/**
 * Revoke one specific payment link (by row id) if it is still unused and
 * unrevoked. Used by the mint-and-email flows when the post-commit email
 * fails or is suppressed: the raw token is unrecoverable, so the stale
 * sentinel must be cleared for the next run to re-mint and re-send. Scoped to
 * the id — never the whole booking — so a newer link minted concurrently by
 * another flow survives.
 */
export async function revokePaymentLinkById(
  paymentLinkId: string,
  db: Pick<typeof prisma, "paymentLink"> = prisma
) {
  const revoked = await db.paymentLink.updateMany({
    where: { id: paymentLinkId, revokedAt: null, usedAt: null },
    data: { revokedAt: new Date() },
  });
  return revoked.count;
}

/** Revoke all active payment links for a booking (e.g. when it is bumped). */
export async function revokePaymentLinksForBooking(
  bookingId: string,
  db: Pick<typeof prisma, "paymentLink"> = prisma
) {
  const revoked = await db.paymentLink.updateMany({
    where: { bookingId, revokedAt: null, usedAt: null },
    data: { revokedAt: new Date() },
  });
  return revoked.count;
}
