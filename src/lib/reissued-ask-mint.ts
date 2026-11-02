/**
 * #3954 review round 6: A RE-ISSUED ASK IS MINTED FROM ONE STRIPE REQUEST,
 * WHICHEVER OF ITS TWO MINTERS GETS THERE.
 *
 * A price reduction that only shrinks an unpaid ask makes the smaller ask
 * durable in its own transaction (`queueReissuedAskRecovery`), under a Stripe
 * key scoped to the reducing edit. Two minters then race for it: the door's own
 * mint after commit, and the recovery runner once the grace has passed. Stripe
 * answers a key replayed with DIFFERENT parameters with `idempotency_error`,
 * so the two must send the same request byte for byte or the second never
 * mints - and if the first died before writing its row, the re-issue is lost.
 *
 * So the request is planned here and nowhere else (`planReissuedAskMint`):
 *
 * - the AMOUNT - the frozen figure plus the unpaid balance of any ask minted
 *   since, which this mint supersedes and so carries (`sizeReissuedAskReplay`).
 *   The door reads the outstanding ask just as the replay does, so it never
 *   cancels a newer ask - an officer's review charge included - without asking
 *   for its money too;
 * - the KEY - the frozen key while the amount is the frozen figure, else that
 *   key naming the amount (`stripeIdempotencyKeyForAskAmount`), so a moved
 *   amount is a different request and never an `idempotency_error`;
 * - the METADATA and the row's REASON - fixed, never the door's own wording.
 *
 * - the CUSTOMER - resolved one way for both (`resolveAskCustomerId`, round 7):
 *   the `Payment`'s stored customer, else the booking owner's, organisation
 *   included, exactly as the recovery runner always resolved it.
 *
 * And a refusal that still comes back is answered by fetching the intent the
 * key already minted (`mintReissuedAskIntent`), found by the key it carries in
 * its metadata - looked for among this caller's customer's intents first, then,
 * since the earlier request may have named another customer, across the
 * account's recent intents (`findRecentPaymentIntentByMetadata`, round 8). The
 * row records the customer the found intent was actually minted for
 * (`mintedIntentCustomerId`), whichever scan found it.
 *
 * The rule is `INV-PAY-120`.
 */
import type Stripe from "stripe";

import { sizeReissuedAskReplay } from "@/lib/additional-ask-recovery-replay";
import type { AdditionalAsk, AdditionalAskPayment } from "@/lib/additional-payment-ask";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { ADDITIONAL_ASK_INTENT_TYPE } from "@/lib/ordinary-ask-request";
import { bookingOwner } from "@/lib/booking-owner";
import { prisma } from "@/lib/prisma";
import { REISSUED_ASK_REASON, stripeIdempotencyKeyForAskAmount } from "@/lib/payment-recovery-keys";
import { createPaymentIntent, findOrCreateCustomer, findRecentPaymentIntentByMetadata } from "@/lib/stripe";
import { stripeErrorApiType } from "@/lib/stripe-errors";
import type { AppPaymentIntentMetadata } from "@/lib/stripe-app-intent-metadata";

/** The metadata key a re-issued ask's intent carries its Stripe key under. */
export const REISSUED_ASK_KEY_METADATA = "reissuedAskKey";

/**
 * How far before the recovery row's creation a minted intent is looked for -
 * by a re-issue's replay here, and an ordinary ask's (`mintOrdinaryAskIntent`, #4036).
 */
export const MINTED_INTENT_LOOKBACK_MS = 5 * 60 * 1000;

export type ReissuedAskMintPlan = {
  /** What is asked, all carried (`INV-PAY-098`). */
  readonly ask: AdditionalAsk;
  readonly idempotencyKey: string;
  readonly metadata: AppPaymentIntentMetadata;
  readonly reason: string;
};

/** The one request both minters send for a re-issued ask. */
export function planReissuedAskMint({
  bookingId,
  recovery,
  payment,
}: {
  bookingId: string;
  /** The re-issue's recovery row: its frozen figure and the Stripe key frozen with it. */
  recovery: { amountCents: number; stripeKey: string };
  /** The `Payment` as it stands now, for any ask minted since the reduction. */
  payment: AdditionalAskPayment | null | undefined;
}): ReissuedAskMintPlan {
  const ask = sizeReissuedAskReplay({ frozenAmountCents: recovery.amountCents, payment });
  const idempotencyKey =
    ask.amountCents === recovery.amountCents
      ? recovery.stripeKey
      : stripeIdempotencyKeyForAskAmount(recovery.stripeKey, ask.amountCents);
  return {
    ask,
    idempotencyKey,
    metadata: {
      bookingId,
      type: ADDITIONAL_ASK_INTENT_TYPE,
      reason: REISSUED_ASK_REASON,
      [REISSUED_ASK_KEY_METADATA]: idempotencyKey,
    },
    reason: REISSUED_ASK_REASON,
  };
}

/**
 * Mint the planned request. An `idempotency_error` means the key already
 * minted an intent under different parameters; that intent - same key, same
 * amount - is the re-issue, so it is fetched and returned rather than lost.
 * Anything else, or no such intent, is thrown as it was.
 */
export async function mintReissuedAskIntent({
  format,
  plan,
  customerId,
  recoveryCreatedAt,
}: {
  format: ClubFormat;
  plan: ReissuedAskMintPlan;
  customerId: string | undefined;
  recoveryCreatedAt: Date;
}): Promise<Stripe.PaymentIntent> {
  try {
    return await createPaymentIntent({
      format,
      amountCents: plan.ask.amountCents,
      customerId,
      metadata: plan.metadata,
      idempotencyKey: plan.idempotencyKey,
    });
  } catch (err) {
    if (stripeErrorApiType(err) !== "idempotency_error") throw err;
    const minted = await findRecentPaymentIntentByMetadata({
      metadataKey: REISSUED_ASK_KEY_METADATA,
      metadataValue: plan.idempotencyKey,
      createdSince: new Date(recoveryCreatedAt.getTime() - MINTED_INTENT_LOOKBACK_MS),
      customerId,
    });
    if (!minted || minted.amount !== plan.ask.amountCents) throw err;
    logger.warn(
      { paymentIntentId: minted.id, idempotencyKey: plan.idempotencyKey },
      "A re-issued additional ask's key had already minted an intent; using that intent (#3954)",
    );
    return minted;
  }
}

/**
 * Round 7: the customer an intent was minted for - its own, which an intent
 * the metadata lookup recovered may not share with the caller - else the
 * caller's. What the ask's row records as the payment's customer.
 */
export function mintedIntentCustomerId(
  intent: Pick<Stripe.PaymentIntent, "customer">,
  fallback: string | undefined,
): string | undefined {
  const customer = intent.customer;
  return (typeof customer === "string" ? customer : customer?.id) ?? fallback;
}

/** The loaded payment `resolveAskCustomerId` reads: its customer and its booking's owner. */
export type AskCustomerPayment = {
  stripeCustomerId: string | null;
  booking: {
    organisationId: string | null;
    member: { id: string; email: string; firstName: string; lastName: string } | null;
    organisation: { name: string; email: string | null } | null;
  };
};

/**
 * Round 7: THE ONE WAY an additional ask's mint names its Stripe customer,
 * for the recovery runner and the door's mint alike - a re-issue's and, since
 * #4036, an ordinary increase's - so the two send one request under their
 * shared key: the `Payment`'s stored customer, else
 * the booking owner's (`findOrCreateCustomer`), an organisation by its own id.
 */
export async function resolveAskCustomerId(payment: AskCustomerPayment): Promise<string> {
  if (payment.stripeCustomerId) return payment.stripeCustomerId;
  const member = bookingOwner(payment.booking).member as { id?: string; email: string; firstName: string; lastName: string };
  const customer = await findOrCreateCustomer({
    email: member.email,
    name: `${member.firstName} ${member.lastName}`,
    // #3369: the OWNER - a member id, or the organisation beside it.
    memberId: member.id ?? null,
    organisationId: payment.booking.organisationId,
  });
  return customer.id;
}

/**
 * Round 7: the `Payment` a door's mint reads after commit - its live ask, for
 * any ask minted since the reduction (`planReissuedAskMint`), and its customer
 * and owner, for `resolveAskCustomerId`. #4036: the ordinary increase's door
 * reads it too, for the customer alone.
 */
export async function readAskMintPayment(
  paymentId: string,
): Promise<AdditionalAskPayment & AskCustomerPayment> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      stripeCustomerId: true,
      // #3369: the owner may be an Organisation; `resolveAskCustomerId` reads both.
      booking: {
        select: {
          organisationId: true,
          member: { select: { id: true, email: true, firstName: true, lastName: true } },
          organisation: { select: { name: true, email: true } },
        },
      },
    },
  });
  if (!payment) throw new Error(`Payment ${paymentId} not found for an additional ask's mint`);
  return payment;
}
