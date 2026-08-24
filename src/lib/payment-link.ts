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
} from "@/lib/booking-narrative";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { getDefaultLodgeId } from "@/lib/lodges";
import { endOfDateOnlyForTimeZone, formatDateOnly } from "@/lib/date-only";
import {
  sendAdminPaymentFailureAlert,
  sendBookingRequestApprovedEmail,
  sendSplitGuestPaymentLinkEmail,
} from "@/lib/email";
import { formatCents } from "@/lib/utils";
import { recordWithheldBookingEmail } from "@/lib/booking-email-suppression";
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
  /** NZT end-of-check-in-day expiry, ISO. */
  expiresAt: string;
}

export interface PaymentLinkContext {
  state: BookingNarrativeState;
  /** Rich, plain-language wording shared with the admin booking history. */
  narrative: BookingNarrative;
  firstName: string;
  /** Present only when the booking can still be paid via this link. */
  payable: PaymentLinkPayable | null;
  /** True when the page should offer the "email me a fresh link" action. */
  canRequestFreshLink: boolean;
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
export async function getPaymentLinkContext(token: string): Promise<PaymentLinkContext> {
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

  const narrative = resolveBookingNarrative({
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
  });

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
    narrative.state === "payable" ? await loadEffectiveModuleFlags() : null;
  const internetBankingEnabled = Boolean(
    ibModules?.xeroIntegration && ibModules?.internetBankingPayments
  );

  const payable: PaymentLinkPayable | null =
    narrative.state === "payable"
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
    canRequestFreshLink: narrative.state === "expired_payable",
    lodgeName: booking.lodge.name,
  };
}

/**
 * Re-issue a payment link for an expired-but-payable booking and email the
 * requester a fresh one (the self-service "fresh link" action offered on the
 * expired-link page). Revokes any prior unused links for the booking. The new
 * link expires at the end of the check-in day in NZT.
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

  const expiresAt = endOfDateOnlyForTimeZone(formatDateOnly(booking.checkIn));
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

/** A freshly minted split-guest link: the raw token (emailable exactly once)
 * plus the row id so a caller whose email fails can revoke THIS link — and
 * only this link — without touching a newer one minted concurrently. */
export type MintedSplitGuestPaymentLink = {
  token: string;
  paymentLinkId: string;
};

/**
 * The on-demand "re-send" affordance treats an active link minted within this
 * window as just-sent and refuses to replace it, so a double-click (or two
 * racing POSTs) cannot fan out two emails. Older active links ARE replaced —
 * revoke-and-remint is the only way to re-send, because raw tokens are never
 * stored at rest.
 */
const SPLIT_LINK_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Revoke every unused, unrevoked link for the booking and mint a fresh one.
 * MUST be called inside a transaction holding the booking's per-lodge advisory
 * lock — the revoke-then-create pair is what preserves the at-most-one-live-
 * token invariant across the cron, the on-demand button, and /pay reissue.
 */
async function mintFreshSplitGuestPaymentLink(
  tx: Prisma.TransactionClient,
  bookingId: string,
  expiresAt: Date,
  now: Date
): Promise<MintedSplitGuestPaymentLink> {
  await tx.paymentLink.updateMany({
    where: { bookingId, revokedAt: null, usedAt: null },
    data: { revokedAt: now },
  });
  const { token, tokenHash } = issueActionToken();
  const created = await tx.paymentLink.create({
    data: { bookingId, tokenHash, expiresAt },
  });
  return { token, paymentLinkId: created.id };
}

/**
 * Mint a tokenised PaymentLink for a split non-member child booking (#1967) IF
 * it has no active (un-revoked, un-used, un-expired) link yet, returning the
 * raw token + row id so the caller can email it and, if that email fails,
 * revoke it. Returns null when an active link already exists — that
 * absence/presence is the idempotency sentinel that stops the settlement cron
 * re-emailing the member on every extension run (only the raw token minted
 * here can be emailed; a pre-existing link's token is unrecoverable by
 * design). An EXPIRED link is deliberately NOT active (#707's expired_payable
 * convention): it is revoked and replaced, so a booking whose dates were
 * pushed out after its link lapsed gets a fresh, working link. Returns null
 * without minting when the check-in day has already ended — a link that would
 * be born expired must never be emailed.
 *
 * DB-only and safe to call inside a capacity-lock transaction; the email MUST
 * be sent by the caller OUTSIDE the transaction. The link expires at the end of
 * the check-in day in NZT, matching the #707/#740 request-origin convention.
 */
export async function mintSplitGuestPaymentLinkIfAbsent(
  tx: Prisma.TransactionClient,
  booking: { id: string; checkIn: Date }
): Promise<MintedSplitGuestPaymentLink | null> {
  const now = new Date();
  const expiresAt = endOfDateOnlyForTimeZone(formatDateOnly(booking.checkIn));
  if (expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  const existing = await tx.paymentLink.findFirst({
    where: {
      bookingId: booking.id,
      revokedAt: null,
      usedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (existing) return null;

  return mintFreshSplitGuestPaymentLink(tx, booking.id, expiresAt, now);
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

/** Registry template the split-guest pay-link email ships as (#1967). */
const SPLIT_GUEST_PAYMENT_LINK_TEMPLATE = "split-guest-payment-link";

export type IssueSplitGuestPaymentLinkResult =
  | { outcome: "sent" }
  | { outcome: "just_sent" }
  | { outcome: "suppressed" }
  // #2258: the booking carries the "No emails" switch, so no link was minted
  // and nothing was sent. Distinct from `suppressed` (an undeliverable address,
  // an operator problem) — this one is deliberate.
  | { outcome: "withheld" }
  // #2258: the booking's email setting could not be READ, so the send failed
  // closed. Kept apart from `suppressed` because that outcome means "this
  // address is undeliverable" — telling a member that about a transient
  // database fault is misinformation, and it points an officer at the wrong
  // diagnosis. Retryable: the next attempt sends normally.
  | { outcome: "transient_failure" }
  | { outcome: "not_payable" };

/**
 * On-demand sibling of the settlement-cron path (#1967): mint and email a
 * split non-member child's guest-portion payment link. Backs the
 * booking-detail affordance a member uses when paying their own place by
 * Internet Banking (no card on file for the later guest charge).
 *
 * This is a true send/RE-SEND: because a stored link's raw token is
 * unrecoverable, an existing active link is revoked and replaced with a fresh
 * one (revocation + mint atomically under the per-lodge advisory lock, so two
 * live tokens can never coexist). The only exception is an active link minted
 * within the last minute, which is treated as just-sent — that sentinel plus
 * the lock is the double-click guard. If the email is suppressed or the send
 * throws, the just-minted link is revoked again so no unreachable token stays
 * active. Refuses (`not_payable`) for anything that is not a genuine PENDING
 * split child (#738) — #796 group joiners are excluded by their join row — and
 * whenever a saved card exists on the child or its parent, because the
 * settlement cron will auto-charge that card and a parallel link would open a
 * second live settlement path.
 */
export async function issueSplitGuestPaymentLink(
  childBookingId: string
): Promise<IssueSplitGuestPaymentLinkResult> {
  const booking = await prisma.booking.findUnique({
    where: { id: childBookingId },
    include: {
      member: true,
      guests: { select: { id: true } },
      payment: true,
      parentBooking: { include: { payment: true } },
      groupBookingJoin: { select: { id: true } },
    },
  });

  if (
    !booking ||
    booking.deletedAt ||
    booking.status !== BookingStatus.PENDING ||
    !booking.parentBookingId ||
    // #796 group joiners share parentBookingId but always carry a join row;
    // they settle via their own join-time link or organiser settlement, never
    // via the split-guest flow.
    booking.groupBookingJoin ||
    !booking.hasNonMembers ||
    booking.finalPriceCents <= 0
  ) {
    return { outcome: "not_payable" };
  }

  // #2258: check the "No emails" switch BEFORE minting. Minting first and
  // discovering the withhold at send time would revoke-and-re-mint on every
  // attempt — unbounded PaymentLink and EmailLog churn whose repeats bury, in
  // the booking's withheld list, the very withholds an operator needs to see. A
  // withheld send is NOT a revoke-and-retry condition: nothing changes until an
  // admin clears the switch.
  //
  // Read from the row already loaded above rather than issuing a second query:
  // if that read had failed we would not be here at all, and the authoritative,
  // fail-closed gate still runs inside sendEmail at send time. The withhold is
  // recorded at most once per booking so repeat attempts stay quiet.
  if (booking.noEmails) {
    await recordWithheldBookingEmail({
      bookingId: booking.id,
      templateName: SPLIT_GUEST_PAYMENT_LINK_TEMPLATE,
      subject: "Pay for your guests to confirm their place",
      to: booking.member.email,
      detail:
        'Withheld: this booking has the "No emails" switch turned on. No payment link was created.',
      once: true,
      // Scope the once-check to THIS episode, so a re-enable records afresh.
      sinceAt: booking.noEmailsAt,
    });
    logger.warn(
      { bookingId: booking.id },
      'Did not mint a split guest payment link: the booking has "No emails" turned on',
    );
    return { outcome: "withheld" };
  }

  // #1967 FIX-5: a saved card (its own, or inherited from the parent payment)
  // means the settlement cron will auto-charge this child — issuing a manual
  // pay link alongside would create a second live settlement path.
  const hasSavedCard = Boolean(
    (booking.payment?.stripeCustomerId &&
      booking.payment.stripePaymentMethodId) ||
      (booking.parentBooking?.payment?.stripeCustomerId &&
        booking.parentBooking.payment.stripePaymentMethodId)
  );
  if (hasSavedCard) {
    return { outcome: "not_payable" };
  }

  const minted = await prisma.$transaction(
    async (
      tx
    ): Promise<
      | { kind: "not_payable" }
      | { kind: "just_sent" }
      | ({ kind: "minted" } & MintedSplitGuestPaymentLink)
    > => {
      const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);
      // Re-read status under the lock; a concurrent settle/cancel is only
      // visible here. Never mint a link for a booking that has left PENDING.
      const locked = await tx.booking.findUnique({
        where: { id: booking.id },
        select: { status: true },
      });
      if (!locked || locked.status !== BookingStatus.PENDING) {
        return { kind: "not_payable" };
      }

      const now = new Date();
      const expiresAt = endOfDateOnlyForTimeZone(
        formatDateOnly(booking.checkIn)
      );
      if (expiresAt.getTime() <= now.getTime()) {
        // The check-in day has ended; a fresh link would be born expired.
        return { kind: "not_payable" };
      }

      const active = await tx.paymentLink.findFirst({
        where: {
          bookingId: booking.id,
          revokedAt: null,
          usedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true, createdAt: true },
      });
      if (
        active &&
        now.getTime() - active.createdAt.getTime() <
          SPLIT_LINK_RESEND_COOLDOWN_MS
      ) {
        // Just minted (double-click, or a race with the settlement cron):
        // an email carrying this link is already on its way.
        return { kind: "just_sent" };
      }

      // Revoke-and-remint: the active link's raw token is unrecoverable at
      // rest, so re-sending means replacing it. Atomic under the lodge lock.
      return {
        kind: "minted",
        ...(await mintFreshSplitGuestPaymentLink(
          tx,
          booking.id,
          expiresAt,
          now
        )),
      };
    }
  );

  if (minted.kind === "not_payable") return { outcome: "not_payable" };
  if (minted.kind === "just_sent") return { outcome: "just_sent" };

  let emailOutcome;
  try {
    emailOutcome = await sendSplitGuestPaymentLinkEmail({
      bookingContext: {
        bookingId: booking.id,
        recipientMemberId: booking.memberId,
      },
      email: booking.member.email,
      firstName: booking.member.firstName,
      token: minted.token,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guestCount: booking.guests.length,
      priceCents: booking.finalPriceCents,
      bookingReference: booking.id,
      expiresAt: endOfDateOnlyForTimeZone(formatDateOnly(booking.checkIn)),
      lodgeId: booking.lodgeId ?? null,
    });
  } catch (err) {
    // The raw token dies with this request; clear the sentinel so a retry
    // (button or cron) re-mints instead of pointing at an unreachable link.
    await revokePaymentLinkById(minted.paymentLinkId).catch((revokeErr) =>
      logger.error(
        { err: revokeErr, bookingId: booking.id, paymentLinkId: minted.paymentLinkId },
        "Failed to revoke split guest payment link after email send error"
      )
    );
    throw err;
  }

  if (emailOutcome.status === "withheld_for_booking") {
    // The unreachable token is revoked either way, but the OUTCOME depends on
    // WHY (#2258): `booking_no_emails` is a deliberate, standing decision with
    // nothing to retry until an admin clears it, whereas
    // `booking_flag_unreadable` is a transient database fault — treating that
    // as "the switch is on" would tell an operator (and, through the route
    // above, a member) something false about a booking whose switch is OFF.
    await revokePaymentLinkById(minted.paymentLinkId).catch((revokeErr) =>
      logger.error(
        { err: revokeErr, bookingId: booking.id, paymentLinkId: minted.paymentLinkId },
        "Failed to revoke split guest payment link after an undelivered email"
      )
    );
    if (emailOutcome.reason === "booking_flag_unreadable") {
      logger.error(
        { bookingId: booking.id },
        "Split guest payment link email failed closed (the booking's email setting could not be read); link revoked so a later attempt re-mints"
      );
      // Retryable, and NOT `suppressed`: nothing is wrong with the address.
      return { outcome: "transient_failure" };
    }
    logger.warn(
      { bookingId: booking.id },
      'Split guest payment link email withheld: the booking has "No emails" turned on; link revoked'
    );
    return { outcome: "withheld" };
  }

  if (emailOutcome.status !== "sent") {
    // Nothing was delivered, so the link must not stay active suppressing every
    // future send (F25, #1885). Revoked either way; only the OUTCOME differs.
    await revokePaymentLinkById(minted.paymentLinkId).catch((revokeErr) =>
      logger.error(
        { err: revokeErr, bookingId: booking.id, paymentLinkId: minted.paymentLinkId },
        "Failed to revoke split guest payment link after an undelivered email"
      )
    );
    logger.warn(
      {
        bookingId: booking.id,
        emailStatus: emailOutcome.status,
        emailReason:
          "reason" in emailOutcome ? emailOutcome.reason : undefined,
      },
      "Split guest payment link email not delivered; link revoked so a later attempt re-mints"
    );

    /*
      AN ENVIRONMENT WITHHOLD IS NOT AN UNDELIVERABLE ADDRESS (#3035 review), and
      bucketing it as `suppressed` was wrong in the most expensive place this
      epic has. The route turns `suppressed` into a 502 reading "your email
      address is undeliverable" — shown to a MEMBER — and it does that on the
      epic's own headline case: a live club upgraded without the declaration.
      The member's address is perfectly fine, the club has just not told the
      software what it is; and the same file already states this rule twenty lines
      above for the unreadable-switch case, where it says in as many words that
      "this address is undeliverable" is misinformation that points an officer at
      the wrong diagnosis.

      So the two faults map to `transient_failure` (503, "try again shortly"),
      which is what they are — they clear the moment a person corrects the
      deployment — and the confirmed COPY maps to `withheld`, which is the
      deliberate, non-transient bucket. Neither tells a member anything untrue
      about their own mailbox.
    */
    if (emailOutcome.status === "withheld_for_environment") {
      return emailOutcome.reason === "environment_non_production"
        ? { outcome: "withheld" }
        : { outcome: "transient_failure" };
    }

    // Suppressed (or placeholder) recipient: the address really is the problem.
    return { outcome: "suppressed" };
  }

  return { outcome: "sent" };
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
