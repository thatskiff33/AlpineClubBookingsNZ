/**
 * #3267 (epic #3270) — asking Stripe about one saved-card charge attempt
 * (`INV-PAY-055`). The middle third of the contract whose whole shape is in
 * `saved-card-charge-attempt.ts`'s module docblock; `saved-card-charge-settle.ts`
 * is the last third.
 *
 * The seam is the provider call, and it is a real one, not a size dodge:
 * everything in `saved-card-charge-attempt.ts` runs INSIDE the caller's claim
 * transaction and touches only the ledger; everything here runs AFTER that
 * transaction has committed and is a plain Stripe call with no lock held
 * (`INV-INT-003`); everything in `saved-card-charge-settle.ts` runs once Stripe
 * has answered. Each third stays inside its own file-size budget as a result,
 * and nothing here decides what an attempt IS — that vocabulary is imported.
 */
import { PaymentStatus } from "@prisma/client";
import type Stripe from "stripe";

import logger from "@/lib/logger";
import { prisma } from "./prisma";
import {
  cancelPaymentIntentIfCancellableWithResult,
  chargePaymentMethod,
  getPaymentIntent,
} from "./stripe";
import {
  isStripeResourceMissingError,
  readStripeErrorFields,
} from "./stripe-errors";
import type { PaymentStore } from "./payment-transactions";
import {
  buildSavedCardChargeMetadata,
  UNRESOLVED_ATTEMPT_STATUSES,
  type SavedCardChargeAttempt,
  type SavedCardToCharge,
} from "./saved-card-charge-attempt";

/**
 * Stripe API error types under which a CHARGE request was ANSWERED, so we know
 * no charge is pending from it: the card or the request was refused
 * (`card_error`, `invalid_request_error`), the key was refused
 * (`idempotency_error`), or the credentials were (`authentication_error`).
 * Everything else — `api_error` (5xx: Stripe may have executed it),
 * `rate_limit_error`, a connection error or timeout (no API type at all), a
 * plain `Error` — leaves it uncertain whether the charge happened, and the row
 * stays PENDING so the next attempt asks about THIS one rather than starting a
 * second.
 *
 * This partition is for the POST. A replay that RETRIEVES its intent is a GET,
 * and on a GET only `resource_missing` says anything about the attempt (the
 * intent is gone, so the attempt is over): an `authentication_error` or an
 * `invalid_request_error` on a read says nothing about an intent that may be
 * `processing` right now, so `chargeSavedCardAttempt` treats every other read
 * failure as ambiguous and leaves the row for the next attempt to ask again.
 *
 * This is a different partition from #3268's `classifySavedCardChargeFailure`
 * (retry vs terminal for the CARD), read from the same `readStripeErrorFields`
 * so there is one place that knows where a Stripe error keeps its type
 * (`INV-SSOT-001`). An `idempotency_error` is definite here (this attempt is
 * over) and `retry` there (the card is fine) — both are right.
 */
const DEFINITE_STRIPE_ERROR_TYPES: ReadonlySet<string> = new Set([
  "card_error",
  "invalid_request_error",
  "idempotency_error",
  "authentication_error",
]);

export function isDefiniteSavedCardChargeFailure(err: unknown): boolean {
  const apiType = readStripeErrorFields(err).apiType;
  return apiType !== null && DEFINITE_STRIPE_ERROR_TYPES.has(apiType);
}

/**
 * End an attempt Stripe definitely refused, so the next attempt mints a fresh
 * key instead of replaying a refusal. Status-guarded (PENDING/PROCESSING ->
 * FAILED): a row a webhook has since settled is left alone. Runs on the base
 * client — the caller holds no lock at this point, and the write is a
 * single-row status flip that races nothing (the intent, if Stripe created one
 * before refusing, is already terminal). The Payment aggregate is deliberately
 * not re-derived: before #3267 a thrown charge left no ledger row at all and
 * the `Payment` stayed at the PENDING the claim wrote, which is exactly what a
 * pending booking whose charge failed should read as; the next claim's upsert
 * writes PENDING again anyway.
 */
async function failSavedCardChargeAttempt(
  attemptRowId: string,
  store: PaymentStore = prisma
): Promise<{ ended: boolean }> {
  const ended = await store.paymentTransaction.updateMany({
    where: { id: attemptRowId, status: { in: [...UNRESOLVED_ATTEMPT_STATUSES] } },
    data: { status: PaymentStatus.FAILED },
  });
  return { ended: ended.count > 0 };
}

/**
 * A superseded attempt whose intent turns out to be still `processing` is not
 * over: put its row back to PROCESSING so the ledger says what Stripe says, and
 * so the NEXT attempt reads it as unresolved again, ends it again and asks about
 * it again — waiting, run after run, until the intent captures (its row goes
 * SUCCEEDED and the next attempt refuses on captured cash) or fails (its row
 * goes FAILED and the next attempt is fresh). Without this the FAILED mark
 * `beginSavedCardChargeAttempt` wrote under the claim would hide a live intent
 * from the very next run, which would then charge beside it. Guarded on FAILED
 * so a webhook's SUCCEEDED is never regressed; the residual race — a
 * `payment_failed` webhook landing between our retrieve and this write — puts
 * PROCESSING over a FAILED the webhook wrote, which the next run's retrieve
 * corrects (the intent is then `requires_payment_method`, cancellable, ended).
 */
async function reviveSupersededAttemptRow(
  paymentIntentId: string,
  store: PaymentStore = prisma
): Promise<{ revived: boolean }> {
  const revived = await store.paymentTransaction.updateMany({
    where: { stripePaymentIntentId: paymentIntentId, status: PaymentStatus.FAILED },
    data: { status: PaymentStatus.PROCESSING },
  });
  return { revived: revived.count > 0 };
}

/**
 * Best-effort Stripe-side cancellation of the intents `beginSavedCardChargeAttempt`
 * ended — run AFTER the claim transaction has committed and BEFORE the charge
 * (`INV-INT-003`: never a provider call inside the transaction). Same shape and
 * same reasoning as the cron's #1992 link-intent sweep: a cancel that loses its
 * race is expected and a cancel that errors is logged and never blocks the
 * charge. Every stale intent is visited before anything is returned, so one
 * that CAN be cancelled is, even after another has been found live.
 *
 * Two outcomes are NOT best-effort, because they are money, and either one is
 * returned as this attempt's answer so the caller settles with it and makes no
 * second charge:
 *
 * - `succeeded`: the intent has captured this booking's price. Before #3267
 *   this state (a PROCESSING saved-card row whose intent quietly captured while
 *   the webhook was lost) stalled until the webhook was redelivered; now the
 *   next attempt finds the money.
 * - `processing`: the intent is live and may capture any second. Stripe
 *   refuses to cancel a card payment in this state (the SDK helper attempts it,
 *   because a few asynchronous methods do allow it, and the refusal arrives as
 *   a thrown `invalid_request_error`), so the intent is retrieved and, when it
 *   is still `processing`, waited on: its row is put back to PROCESSING
 *   (`reviveSupersededAttemptRow`) and it is the answer. Charging the new card
 *   beside it — the pre-fix behaviour, "not cancellable, nothing to do" — was a
 *   double charge with only the #1992 refund standing between it and the
 *   member.
 *
 * A capture outranks a live intent when both are found; the live one, if it
 * also captures, is the second capture `INV-PAY-043` hands back.
 */
async function cancelSupersededAttemptIntents(
  attempt: SavedCardChargeAttempt,
  bookingId: string
): Promise<Stripe.PaymentIntent | null> {
  let captured: Stripe.PaymentIntent | null = null;
  let live: Stripe.PaymentIntent | null = null;

  const consider = async (paymentIntent: Stripe.PaymentIntent) => {
    if (paymentIntent.status === "succeeded") {
      logger.error(
        { bookingId, paymentIntentId: paymentIntent.id, attemptRowId: attempt.attemptRowId },
        "A superseded saved-card charge attempt's intent had already captured; settling with that capture instead of charging again (#3267)"
      );
      captured ??= paymentIntent;
      return;
    }
    if (paymentIntent.status === "processing") {
      const { revived } = await reviveSupersededAttemptRow(paymentIntent.id);
      logger.warn(
        { bookingId, paymentIntentId: paymentIntent.id, attemptRowId: attempt.attemptRowId, revived },
        "A superseded saved-card charge attempt's intent is still processing; waiting on it instead of charging beside it (#3267)"
      );
      live ??= paymentIntent;
      return;
    }
    logger.warn(
      { bookingId, paymentIntentId: paymentIntent.id, paymentStatus: paymentIntent.status },
      "A superseded saved-card charge attempt's intent was not cancellable and did not capture; nothing to do (#3267)"
    );
  };

  for (const paymentIntentId of attempt.staleIntentIdsToCancel) {
    try {
      const result = await cancelPaymentIntentIfCancellableWithResult(paymentIntentId);
      if (result.canceled) {
        logger.info(
          { bookingId, paymentIntentId },
          "Cancelled the intent of a superseded saved-card charge attempt (#3267)"
        );
        continue;
      }
      await consider(result.paymentIntent);
    } catch (cancelErr) {
      // The cancel itself was refused or never answered. Ask what the intent IS
      // before deciding the charge may proceed: a `processing` card payment
      // refuses cancellation, and that refusal must not read as "nothing to do".
      try {
        await consider(await getPaymentIntent(paymentIntentId));
      } catch (retrieveErr) {
        logger.error(
          { err: cancelErr, retrieveErr, bookingId, paymentIntentId },
          "Failed to cancel a superseded saved-card charge attempt's intent, and could not read its state; proceeding with the charge and relying on the #1992 duplicate-capture backstop (best-effort, #3267)"
        );
      }
    }
  }
  return captured ?? live;
}

/**
 * Ask Stripe about this attempt — the ONLY place a saved card is charged.
 *
 * First the intents of the attempts the claim ended are cancelled best-effort
 * (`cancelSupersededAttemptIntents`); one found already captured, or still
 * processing, is returned as the answer and no charge is made. Then:
 *
 * - `fresh`: `chargePaymentMethod` under the row's key.
 * - `replay` with a known intent: `getPaymentIntent` — the intent's CURRENT
 *   state, not the stored first answer (see the module docblock).
 * - `replay` without an intent: `chargePaymentMethod` under the row's key,
 *   which Stripe answers with the stored result if the first POST executed, or
 *   executes exactly once if it never arrived.
 *
 * Metadata is built here from the ids, so every path sends the same body.
 *
 * On a throw: a DEFINITE failure marks the row FAILED FIRST and then rethrows
 * the ORIGINAL error, so each caller's existing release/alert handling —
 * including #3268's terminal branch, which needs the Stripe error, not ours —
 * runs unchanged and finds the row already ended (see the module docblock for
 * why that order matters against `retireUnusableSavedCard`). What counts as
 * definite depends on what was asked: for a POST, the types in
 * `isDefiniteSavedCardChargeFailure`; for a retrieve, ONLY `resource_missing`
 * (the intent is gone) — every other read failure says nothing about an intent
 * that may be live. If the FAILED mark itself fails, that is logged and the
 * Stripe error is still what is thrown; the row stays as it was and the next
 * attempt asks about it again. An AMBIGUOUS failure leaves the row as it is and
 * rethrows.
 */
export async function chargeSavedCardAttempt(params: {
  attempt: SavedCardChargeAttempt;
  bookingId: string;
  memberId: string;
  amountCents: number;
  card: SavedCardToCharge;
}): Promise<Stripe.PaymentIntent> {
  const { attempt, bookingId, memberId, amountCents, card } = params;

  const answered = await cancelSupersededAttemptIntents(attempt, bookingId);
  if (answered) return answered;

  const retrieving = attempt.kind === "replay" && attempt.paymentIntentId !== null;
  try {
    if (attempt.kind === "replay" && attempt.paymentIntentId) {
      return await getPaymentIntent(attempt.paymentIntentId);
    }
    return await chargePaymentMethod({
      amountCents,
      customerId: card.stripeCustomerId,
      paymentMethodId: card.stripePaymentMethodId,
      metadata: buildSavedCardChargeMetadata(bookingId, memberId),
      idempotencyKey: attempt.idempotencyKey,
    });
  } catch (err) {
    const fields = readStripeErrorFields(err);
    const definite = retrieving
      ? isStripeResourceMissingError(err)
      : isDefiniteSavedCardChargeFailure(err);
    if (definite) {
      try {
        const { ended } = await failSavedCardChargeAttempt(attempt.attemptRowId);
        logger.warn(
          {
            bookingId,
            attemptRowId: attempt.attemptRowId,
            ended,
            retrieving,
            stripeType: fields.apiType,
            stripeCode: fields.code,
          },
          "Saved-card charge attempt definitely refused; ended it so the next attempt is fresh (#3267)"
        );
      } catch (markErr) {
        logger.error(
          { err: markErr, bookingId, attemptRowId: attempt.attemptRowId },
          "Failed to mark a refused saved-card charge attempt FAILED; it stays pending and the next attempt replays it (#3267)"
        );
      }
    } else {
      logger.warn(
        {
          bookingId,
          attemptRowId: attempt.attemptRowId,
          retrieving,
          stripeType: fields.apiType,
          stripeCode: fields.code,
        },
        "Saved-card charge attempt failed without a definite answer from Stripe; leaving it for the next attempt to ask about (#3267)"
      );
    }
    throw err;
  }
}
