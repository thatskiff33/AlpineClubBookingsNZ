import { NextRequest, NextResponse } from "next/server";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { createPaymentIntent, findOrCreateCustomer, getPaymentIntent } from "@/lib/stripe";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { CreatePaymentIntentSchema } from "@/types/payments";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { BookingEventType, BookingStatus, PaymentSource } from "@prisma/client";
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { canCreateImmediatePaymentIntent } from "@/lib/booking-payment-flow";
import {
  findPaymentTransactionByIntentId,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  queueSupersededPrimaryIntentCancellations,
  type SupersededPrimaryPaymentIntent,
} from "@/lib/booking-payment-cleanup";
import { drainSupersededPrimaryIntents } from "@/lib/booking-modification-settlement";
import { queueXeroInvoiceForPaidBooking } from "@/lib/xero-booking-invoice-queue";
import { hasAdminAccess } from "@/lib/access-roles";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import {
  consumeStoredCreditElection,
  settleFullyCreditCoveredBooking,
  CreditCoveredSettlementConflictError,
} from "@/lib/booking-credit-election";
import { recordBookingEvent } from "@/lib/booking-events";
import { sendBookingConfirmedEmail } from "@/lib/email";
import { getProvisionalNonMemberChildSummary } from "@/lib/booking-split-summary";

class PaymentIntentCapacityError extends Error {
  constructor() {
    super("Not enough beds available for your dates. Please choose different dates.");
    this.name = "PaymentIntentCapacityError";
  }
}

/**
 * The booking moved out of the status this request read before the pay
 * transaction could claim it — a concurrent cancel, admin action or a second
 * pay attempt. Nothing was written (the transaction rolls back), so this is a
 * plain conflict, not a failure.
 */
class PaymentIntentConflictError extends Error {
  constructor() {
    super("This booking is no longer payable. Reload the booking and try again.");
    this.name = "PaymentIntentConflictError";
  }
}

/**
 * Defence in depth (#2266): a DRAFT carrying an unresolved admin review must
 * not become payable here. The writers park review-flagged drafts to
 * AWAITING_REVIEW (booking-create and the modify path alike), so this state
 * should not exist — but the no-adult review rule is a child-safety gate, so
 * the pay door checks it too rather than trusting every writer forever.
 */
class PaymentIntentReviewPendingError extends Error {
  constructor() {
    super("This booking needs admin review before it can be paid.");
    this.name = "PaymentIntentReviewPendingError";
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }
    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
    }

    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const parsed = CreatePaymentIntentSchema.safeParse(json.body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { bookingId } = parsed.data;

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        member: true,
        guests: true,
        payment: true,
      },
    });

    if (!booking) {
      return NextResponse.json(
        { error: "Booking not found" },
        { status: 404 }
      );
    }

    // Verify the requesting user owns this booking or is admin
    if (booking.memberId !== session.user.id && !hasAdminAccess(session.user)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ORGANISER_PAYS group join: the organiser settles this booking as part of
    // one combined bill, so neither the joiner nor an admin pays it here.
    if (booking.organiserSettled) {
      return NextResponse.json(
        {
          error:
            "This booking is paid by the group organiser and cannot be paid individually",
        },
        { status: 400 }
      );
    }

    if (
      booking.status !== "PENDING" &&
      booking.status !== "PAYMENT_PENDING" &&
      booking.status !== "CONFIRMED" &&
      booking.status !== "DRAFT"
    ) {
      return NextResponse.json(
        { error: "Booking is not in a payable state" },
        { status: 400 }
      );
    }

    if (
      !canCreateImmediatePaymentIntent({
        status: booking.status,
        hasNonMembers: booking.hasNonMembers,
        organiserSettled: booking.organiserSettled,
      })
    ) {
      return NextResponse.json(
        {
          error:
            "This booking must stay in the saved-card flow until the non-member hold window expires",
        },
        { status: 400 }
      );
    }

    if (booking.payment?.source === PaymentSource.INTERNET_BANKING) {
      return NextResponse.json(
        {
          error:
            "This booking is already awaiting Internet Banking payment and cannot use the Stripe payment flow",
        },
        { status: 400 }
      );
    }

    // This is the point at which a draft becomes a real, capacity-holding,
    // payable booking — so it is also the point at which the member's stored
    // credit election is honoured (#2265) and, if nothing is left to pay, the
    // point at which the booking settles at $0.
    //
    // Everything runs in ONE transaction under the #1881 two-tier lock
    // protocol: the global booking/money lock(1) first, then the booking's
    // per-lodge capacity lock, then (inside the election consumer) the
    // per-member credit-ledger lock. That order is global -> lodge -> member,
    // the same order every other two-lock writer uses, so it is deadlock-free
    // against cancel, capture, settlement and the per-lodge creators. Without
    // lock(1) this transaction did not mutually exclude a concurrent cancel,
    // and its status writes could resurrect a just-cancelled booking.
    //
    // The PAYMENT_PENDING arm of the condition is not redundant: a booking that
    // tripped the no-adult rule is created in AWAITING_REVIEW and is released
    // to PAYMENT_PENDING by an admin approval, never passing through DRAFT
    // here. Its election is consumed on this, its first pay attempt — and
    // because that arm can now settle the booking at $0, it claims capacity
    // like every other settle path (honouring a persisted override, #1771)
    // instead of settling blind.
    const draftTransition =
      booking.status === "DRAFT" ||
      (booking.status === "PAYMENT_PENDING" &&
        booking.creditElectionCents != null)
        ? await prisma.$transaction(async (tx) => {
            // Two-tier lock protocol (#1881): global booking/money lock first,
            // then the per-lodge capacity lock. The booking's lodge cannot
            // change, so reading it for lock-key selection is safe.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
            const bookingLodgeId =
              booking.lodgeId ?? (await getDefaultLodgeId(tx));
            await acquireLodgeCapacityLock(tx, bookingLodgeId);

            // Re-read under the locks; every status, capacity and money
            // decision below consumes ONLY this post-lock snapshot. The
            // pre-transaction `booking` read held no lock at all.
            const freshBooking = await tx.booking.findUnique({
              where: { id: bookingId },
              include: { guests: { include: { nights: true } } }, // per-night sets (issue #713)
            });

            if (!freshBooking) {
              throw new PaymentIntentConflictError();
            }

            let previousRange: { checkIn: Date; checkOut: Date } | null = null;

            if (booking.status === "DRAFT") {
              // For DRAFT bookings: preflight capacity and transition to
              // PAYMENT_PENDING before charging. Payment success performs the
              // final capacity claim.
              if (freshBooking.status !== BookingStatus.DRAFT) {
                throw new PaymentIntentConflictError();
              }

              // #2266: the review invariant, CHECKED, not just stated — a
              // review-flagged booking is created in (or edit-parked to)
              // AWAITING_REVIEW and only an admin approval releases it toward
              // payment, so a DRAFT with an unresolved review must never
              // advance. Fail closed on any non-APPROVED review state.
              if (
                freshBooking.requiresAdminReview &&
                freshBooking.adminReviewStatus !== "APPROVED"
              ) {
                throw new PaymentIntentReviewPendingError();
              }

              const capacity = await checkCapacityForGuestRanges(
                bookingLodgeId,
                freshBooking.checkIn,
                freshBooking.checkOut,
                freshBooking.guests,
                bookingId,
                tx
              );

              // DRAFT-scoped exemption (#1771): this re-check runs only while the
              // booking is DRAFT, and a DRAFT can never carry a persisted capacity
              // override (#1767 blocks save-as-draft over capacity), so
              // bookingHasCapacityOverride would always be false here — honouring it
              // would be dead code. See docs/CAPACITY_MODEL.md.
              if (!capacity.available) {
                throw new PaymentIntentCapacityError();
              }

              // Status-guarded transition DRAFT -> PAYMENT_PENDING.
              const advanced = await tx.booking.updateMany({
                where: { id: bookingId, status: BookingStatus.DRAFT },
                data: {
                  status: BookingStatus.PAYMENT_PENDING,
                  draftExpiresAt: null,
                },
              });
              if (advanced.count === 0) {
                throw new PaymentIntentConflictError();
              }
              previousRange = {
                checkIn: freshBooking.checkIn,
                checkOut: freshBooking.checkOut,
              };
            } else {
              // Already-PAYMENT_PENDING arm: a booking an admin released from
              // review. This arm can settle the booking at $0 below, which is a
              // terminal money decision, so it re-checks capacity exactly like
              // every other settle path (markBookingPaymentSucceeded, the
              // payment links, the Internet Banking switch) rather than
              // settling on trust.
              if (freshBooking.status !== BookingStatus.PAYMENT_PENDING) {
                throw new PaymentIntentConflictError();
              }

              const capacity = await checkCapacityForGuestRanges(
                bookingLodgeId,
                freshBooking.checkIn,
                freshBooking.checkOut,
                freshBooking.guests,
                bookingId,
                tx
              );

              if (!capacity.available && bookingHasCapacityOverride(freshBooking)) {
                // Persisted capacity override (#1771): a released
                // AWAITING_REVIEW booking CAN carry one, unlike a DRAFT. It was
                // deliberately admitted above the ceiling, so settle it rather
                // than refuse — the same carve-out every other settle path makes.
                logger.info(
                  { bookingId },
                  "Paying an over-capacity booking with a persisted capacity override (#1771); skipping the capacity block"
                );
              }
              if (!capacity.available && !bookingHasCapacityOverride(freshBooking)) {
                // Refuse honestly. Nothing has been charged and nothing has been
                // consumed, so — unlike markBookingPaymentSucceeded, which is
                // cleaning up after a real capture — there is no reason to
                // cancel or refund the booking: a 409 is the whole answer.
                throw new PaymentIntentCapacityError();
              }
            }

            // #2265 — honour the election the member made when they saved the
            // draft. Clamps to the live balance and the outstanding price, and
            // reports any shortfall rather than quietly applying less.
            //
            // Deliberately AFTER the capacity decision above: a refusal must
            // leave the election intact so the member can pay once beds free
            // up. The throw would roll the transaction back anyway, but the
            // ordering means the property does not depend on that.
            const creditElection = await consumeStoredCreditElection(tx, {
              bookingId,
            });

            // Nothing left to pay? Settle here, in the same transaction that
            // advanced the booking, through the same zero-dollar shape
            // booking-create and the modification engine use.
            //
            // This covers more than a fully-covering election. A draft can be
            // repriced to $0 between the member rendering the pay step and
            // clicking it (a promo, an admin edit, a membership change), and a
            // booking can already be fully covered by credit applied elsewhere.
            // Deciding it INSIDE the transaction is the point: the old code
            // committed DRAFT -> PAYMENT_PENDING first and only then hit the
            // "<= 0 effective price" guard below, which 400s — leaving the
            // member with a booking that had left DRAFT and could never be paid.
            const appliedCreditCents = await deriveBookingAppliedCreditCents(
              bookingId,
              tx,
            );
            const settledEffectivePriceCents =
              freshBooking.finalPriceCents - appliedCreditCents;

            let superseded: SupersededPrimaryPaymentIntent[] = [];
            let settledAtZero = false;
            if (settledEffectivePriceCents <= 0) {
              const settled = await settleFullyCreditCoveredBooking(tx, {
                bookingId,
                appliedCreditCents,
              });
              superseded = settled.supersededPrimaryPaymentIntents;
              settledAtZero = true;
            }

            // Reconcile once, against the final status, so a booking that went
            // straight from DRAFT to PAID is allocated exactly once. The
            // released-review arm reconciles too when it settles: it moved
            // PAYMENT_PENDING -> PAID, and every other path that claims PAID
            // reconciles on that claim (markBookingPaymentSucceeded does it
            // immediately after its own guarded claim). An arm that changed no
            // status has nothing to reconcile.
            if (previousRange || settledAtZero) {
              await reconcileBedAllocationsForBookingWithLodgeLockHeld({
                bookingId,
                db: tx,
                previousRange: previousRange ?? {
                  checkIn: freshBooking.checkIn,
                  checkOut: freshBooking.checkOut,
                },
              });
            }

            return {
              creditElection,
              superseded,
              settledAtZero,
              // Post-lock price, so the confirmation email quotes what the
              // booking was actually worth at settlement rather than the
              // pre-transaction snapshot.
              finalPriceCents: freshBooking.finalPriceCents,
            };
          })
        : null;

    // The admin alert for review-flagged bookings is sent once at
    // creation time. Re-alerting here would double up.

    const creditElection = draftTransition?.creditElection ?? null;

    if (draftTransition?.settledAtZero) {
      // Post-commit side effects for the $0 settlement, mirroring the
      // fully-credit-covered branch of booking-create and the $0 confirm-draft
      // route: the durable lifecycle event, the member's confirmation email,
      // and the Xero invoice. Each is best-effort and must never fail the
      // (already committed) settlement.
      await recordBookingEvent({
        bookingId: booking.id,
        type: BookingEventType.MEMBER_PAID,
        actorMemberId: session.user.id,
        amountCents: 0,
      }).catch((err) =>
        logger.error(
          { err, bookingId: booking.id },
          "Failed to record MEMBER_PAID event for credit-covered booking",
        ),
      );

      const promoRedemption = await prisma.promoRedemption.findUnique({
        where: { bookingId: booking.id },
        include: { promoCode: true },
      });
      sendBookingConfirmedEmail(
        { bookingId: booking.id, recipientMemberId: booking.memberId },
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        draftTransition.finalPriceCents,
        {
          lodgeId: booking.lodgeId,
          ...(promoRedemption?.promoCode
            ? {
                discountCents: booking.discountCents,
                promoAdjustmentCents: booking.promoAdjustmentCents,
                promoCode: promoRedemption.promoCode.code,
              }
            : {}),
        },
      ).catch((err) =>
        logger.error(
          { err, bookingId: booking.id },
          "Failed to send confirmation email for credit-covered booking",
        ),
      );

      // Best-effort like the rest: the settlement is already committed, so a
      // queueing failure must be logged, not turned into a 500 that tells the
      // member their paid booking failed.
      await queueXeroInvoiceForPaidBooking({
        bookingId: booking.id,
        createdByMemberId: session.user.id,
      }).catch((err) =>
        logger.error(
          { err, bookingId: booking.id },
          "Failed to queue Xero invoice for credit-covered booking",
        ),
      );

      await drainSupersededPrimaryIntents({
        bookingId: booking.id,
        supersededPrimaryPaymentIntents: draftTransition?.superseded ?? [],
      });

      return NextResponse.json({
        alreadyPaid: true,
        status: BookingStatus.PAID,
        creditElection,
      });
    }

    // #1641 — the member may have applied account credit at booking-create (the
    // credit was consumed into the BOOKING_APPLIED ledger there). The card charge
    // must be the credit-reduced EFFECTIVE amount, not the full finalPriceCents, or
    // the member double-pays by the applied slice. Derive the applied total from the
    // ledger (the authoritative source; the booking row keeps the full price) and
    // mint / reconcile every intent against the effective amount.
    const appliedCreditCents = await deriveBookingAppliedCreditCents(booking.id);
    const effectivePriceCents = booking.finalPriceCents - appliedCreditCents;

    // A fully credit-covered booking is confirmed at $0 by the booking-create
    // zero-dollar path before any intent is ever requested; it never legitimately
    // reaches this route. Guard defensively rather than mint a $0 Stripe intent
    // (Stripe rejects those) — do NOT invent a new zero-payment shape here.
    //
    // #2265 — this guard no longer strands anything. Every booking the pay
    // transaction above touched (a DRAFT, or a PAYMENT_PENDING booking with an
    // outstanding election) had its zero case decided INSIDE that transaction
    // and settled at $0 there, so reaching this line means the booking was
    // already in a payable status and was never advanced by this request.
    if (effectivePriceCents <= 0) {
      return NextResponse.json(
        { error: "Fully credit-covered bookings do not take card payment." },
        { status: 400 }
      );
    }

    // #1976 — a split parent (member/non-member party, #738) is priced on the
    // member subset only; its non-member guests live on a provisional child
    // booking that is charged closer to the stay, NOT today. So the intent
    // amount (effectivePriceCents) is the member portion, and the member must
    // see THAT figure at the pay step, not the full party total the wizard
    // computed. Surface the split shape and the deferred guest portion (the
    // child's own server-priced finalPriceCents) so the client renders "charged
    // today" from the server intent rather than client arithmetic. Read-only
    // describe: returns null for a non-split booking (single, all-member, or the
    // flagged whole-party hold), which leaves the response non-split-shaped.
    const provisionalChild = await getProvisionalNonMemberChildSummary({
      id: booking.id,
      memberId: booking.memberId,
    });
    const splitPaymentMeta = {
      isSplit: provisionalChild !== null,
      deferredGuestAmountCents: provisionalChild?.deferredAmountCents ?? null,
    };

    // Reuse or reconcile an existing PaymentIntent before creating a new one.
    // #1765 — set to the refunded intent's id when the pointed-to intent turns
    // out to be refund history; the block then falls through to mint a fresh
    // repay intent instead of reconciling or reusing.
    let repaySupersededIntentId: string | null = null;
    if (booking.payment?.stripePaymentIntentId) {
      const existingIntent = await getPaymentIntent(booking.payment.stripePaymentIntentId);

      if (existingIntent.status === "succeeded") {
        // #1765 — a refunded PaymentIntent keeps status "succeeded" forever
        // (refunds hang off the charge and never move the intent), so at the
        // intent level a deliberately refunded payment is indistinguishable
        // from crashed-webhook recovery. Discriminate on the local ledger:
        // refund history lives on the intent's PaymentTransaction row
        // (REFUNDED/PARTIALLY_REFUNDED), which genuine recovery — success
        // never recorded locally — can never carry. The lookup backfills
        // pre-ledger payments; the aggregate-status fallback covers a payment
        // with no derivable transaction row.
        const pointedTransaction = await findPaymentTransactionByIntentId({
          paymentIntentId: existingIntent.id,
        });
        const refundedHistory = pointedTransaction
          ? pointedTransaction.status === PaymentStatus.REFUNDED ||
            pointedTransaction.status === PaymentStatus.PARTIALLY_REFUNDED
          : booking.payment.status === PaymentStatus.REFUNDED ||
            booking.payment.status === PaymentStatus.PARTIALLY_REFUNDED;

        if (!refundedHistory) {
          if (booking.payment.status !== "SUCCEEDED") {
            const reconciliation = await markBookingPaymentSucceeded({
              bookingId: booking.id,
              paymentIntentId: existingIntent.id,
              amountCents: existingIntent.amount,
              paymentMethodId:
                typeof existingIntent.payment_method === "string"
                  ? existingIntent.payment_method
                  : existingIntent.payment_method?.id ?? null,
            });

            if (
              reconciliation.outcome === "cancelled_refunded" ||
              reconciliation.outcome === "cancelled_refund_failed"
            ) {
              return NextResponse.json(
                {
                  error:
                    "Payment succeeded, but lodge capacity is no longer available for this booking.",
                  status: BookingStatus.CANCELLED,
                  refunded: reconciliation.outcome === "cancelled_refunded",
                },
                { status: 409 }
              );
            }
          }

          await queueXeroInvoiceForPaidBooking({
            bookingId: booking.id,
            createdByMemberId: session.user.id,
          });

          return NextResponse.json({
            alreadyPaid: true,
            paymentIntentId: existingIntent.id,
            // #2265 — this recovery path is reachable AFTER an election was
            // consumed above (an admin payment link or saved-card charge can
            // have minted and captured an intent against a PAYMENT_PENDING
            // booking that still carried one). The member is owed the same
            // account of what happened to their credit here as on every other
            // exit; null when this request consumed nothing.
            creditElection,
          });
        }

        // Refund history (#1765): the succeeded-then-refunded intent is
        // settlement history, not a recoverable payment — reconciling it would
        // re-admit the stale amount (or settle the booking at zero net cash
        // when the price never changed). Leave the refunded transaction
        // immutable, keep the pointer for idempotency-key derivation below,
        // and fall through to mint a fresh card-entry intent at the current
        // effective price. The cancellation queue below only selects
        // PENDING/PROCESSING transactions, so it cannot touch this succeeded
        // (refunded) intent; it runs to sweep any older in-flight primary
        // intent stranded at a wrong amount (#1161).
        repaySupersededIntentId = existingIntent.id;
        await queueSupersededPrimaryIntentCancellations(prisma, {
          bookingId: booking.id,
          paymentId: booking.payment.id,
          newFinalPriceCents: effectivePriceCents,
        });
      } else if (
        existingIntent.status !== "canceled" &&
        existingIntent.amount !== effectivePriceCents
      ) {
        // The booking was modified after this intent was minted (#1161), or the
        // intent predates the #1641 effective-price fix (a legacy full-price
        // intent): handing back its client_secret would let Stripe capture the
        // wrong total and strand the booking in webhook reconciliation. Queue the
        // stale intent's cancellation and fall through to mint a fresh one at the
        // current effective price (this also corrects a not-yet-paid legacy
        // booking forward to the effective amount).
        if (booking.payment) {
          await queueSupersededPrimaryIntentCancellations(prisma, {
            bookingId: booking.id,
            paymentId: booking.payment.id,
            newFinalPriceCents: effectivePriceCents,
          });
        }
      } else if (
        existingIntent.client_secret &&
        existingIntent.status !== "canceled"
      ) {
        return NextResponse.json({
          clientSecret: existingIntent.client_secret,
          paymentIntentId: existingIntent.id,
          // #1976 — the amount actually charged today is the reused intent's
          // own amount (server-authoritative, equal to effectivePriceCents on
          // this reuse branch). Render "charged today" from this, not client
          // arithmetic.
          chargedAmountCents: existingIntent.amount,
          ...splitPaymentMeta,
          // #2265 — null unless this request consumed a stored election. #2266
          // renders it so a clamped election is never applied in silence.
          creditElection,
        });
      }
    }

    // Find or create Stripe customer
    const customer = await findOrCreateCustomer({
      email: booking.member.email,
      name: `${booking.member.firstName} ${booking.member.lastName}`,
      memberId: booking.member.id,
    });

    // Create the PaymentIntent at the credit-reduced effective amount (#1641).
    // #1765 — a repay mint may not re-derive the standard key: the pointer
    // still holds the refunded intent (and clearing it would re-derive the
    // original "_initial" key), and Stripe hard-errors when a key is reused
    // with different params inside its ~24h idempotency window. Key the repay
    // mint by the refunded intent it supersedes: stable across same-generation
    // retries (the pointer only moves once the repay mint commits a newer
    // PRIMARY transaction) and unique per generation (each generation
    // supersedes a different intent), while the "repay" segment keeps it
    // disjoint from every non-repay key.
    const paymentIntent = await createPaymentIntent({
      amountCents: effectivePriceCents,
      customerId: customer.id,
      metadata: {
        bookingId: booking.id,
        memberId: booking.memberId,
      },
      idempotencyKey: repaySupersededIntentId
        ? `pi_${booking.id}_repay_${repaySupersededIntentId}`
        : `pi_${booking.id}_${booking.payment?.stripePaymentIntentId ?? "initial"}`,
    });

    // Mirror the effective split onto the Payment so the invariant
    // `amountCents + creditAppliedCents = finalPriceCents` holds (#1641). The
    // update branch also corrects a not-yet-paid legacy full-price payment forward
    // to the effective amount when a fresh intent is minted here.
    const payment = await prisma.payment.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        amountCents: effectivePriceCents,
        creditAppliedCents: appliedCreditCents,
        stripeCustomerId: customer.id,
        status: PaymentStatus.PENDING,
      },
      update: {
        amountCents: effectivePriceCents,
        creditAppliedCents: appliedCreditCents,
        stripeCustomerId: customer.id,
      },
    });

    await upsertPaymentIntentTransaction({
      paymentId: payment.id,
      kind: PaymentTransactionKind.PRIMARY,
      paymentIntentId: paymentIntent.id,
      amountCents: effectivePriceCents,
      status: PaymentStatus.PROCESSING,
      reason: repaySupersededIntentId
        ? "repay_after_refund"
        : "primary_booking_payment",
      stripeCustomerId: customer.id,
    });

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      // #1976 — the freshly minted intent charges the credit-reduced member
      // portion (effectivePriceCents). Return it so the pay step displays the
      // real charge from the server, plus the deferred guest portion for a
      // split so the member reads a coherent "charged today / charged later"
      // story instead of the full party total.
      chargedAmountCents: effectivePriceCents,
      ...splitPaymentMeta,
      // #2265 — the outcome of the stored credit election consumed above (null
      // when the booking carried none). The member asked for this credit when
      // they saved the draft, so the pay step must be able to say what actually
      // happened to it, including a clamp forced by a changed balance or price.
      creditElection,
    });
  } catch (error) {
    logger.error({ err: error }, "Error creating payment intent");
    // The pay transaction's capacity refusal and its status-conflict bail both
    // carry an intentionally user-facing message; keep them (and their 409).
    // Every other unexpected error gets the fixed generic message so internal
    // detail (Prisma constraint names, connection strings, ...) never reaches
    // the client (#1888).
    if (
      error instanceof PaymentIntentCapacityError ||
      error instanceof PaymentIntentConflictError ||
      error instanceof PaymentIntentReviewPendingError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // The $0 settlement lost its status-guarded claim: a concurrent cancel got
    // there first and the whole transaction rolled back (including the credit
    // application), so nothing was settled and nothing was spent.
    if (error instanceof CreditCoveredSettlementConflictError) {
      return NextResponse.json(
        {
          error:
            "This booking is no longer payable. Reload the booking and try again.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create payment intent" },
      { status: 500 }
    );
  }
}
