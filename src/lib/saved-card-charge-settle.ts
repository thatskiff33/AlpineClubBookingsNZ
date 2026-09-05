/**
 * #3267 (epic #3270) — recording Stripe's answer on a saved-card charge attempt
 * row (`INV-PAY-055`). The other half of `saved-card-charge-attempt.ts`, whose
 * module docblock carries the whole contract; this file is step 3 of it.
 *
 * Split out by seam rather than by size alone: `begin` and `charge` run before
 * and around the provider call, under the caller's claim and then outside it,
 * while everything here runs AFTER Stripe has answered — on the base client for
 * a capture, or inside the caller's locked release transaction (`store: tx`)
 * for an intent that did not capture. The two halves share the attempt-row
 * vocabulary through the constants the attempt module exports; nothing here
 * decides what an attempt IS.
 */
import { PaymentStatus } from "@prisma/client";
import type Stripe from "stripe";

import logger from "@/lib/logger";
import { prisma } from "./prisma";
import { stripeReferenceId } from "./stripe-references";
import { isPrismaUniqueConstraintError } from "./prisma-errors";
import {
  reconcilePaymentAggregates,
  type PaymentStore,
} from "./payment-transactions";
import { UNRESOLVED_ATTEMPT_STATUSES } from "./saved-card-charge-attempt";

/**
 * The ledger status an answered PaymentIntent maps to. `succeeded` is captured;
 * `canceled` and `requires_payment_method` (the intent's confirmation failed —
 * the shape a retrieved 3DS attempt has once the member's challenge failed)
 * are OVER, so the row goes FAILED and the next attempt is fresh instead of
 * asking about a dead intent for ever; everything else (`requires_action`,
 * `processing`, `requires_confirmation`, `requires_capture`) is still in
 * flight and stays PROCESSING for the webhook — or the next attempt — to
 * resolve. Before #3267 every non-succeeded answer was recorded PROCESSING;
 * the two terminal states are the addition a retrieve-based replay needs.
 */
export function ledgerStatusForPaymentIntent(
  status: Stripe.PaymentIntent.Status
): PaymentStatus {
  switch (status) {
    case "succeeded":
      return PaymentStatus.SUCCEEDED;
    case "canceled":
    case "requires_payment_method":
      return PaymentStatus.FAILED;
    default:
      return PaymentStatus.PROCESSING;
  }
}

/**
 * Plain English for an operator when an answered intent did not capture — the
 * admin route's and charge-saved-method's response bodies and alerts share it,
 * so the two cannot describe one Stripe status two ways.
 */
export function describeUnsettledPaymentIntent(
  status: Stripe.PaymentIntent.Status
): string {
  switch (status) {
    case "requires_action":
      return "The saved card needs the cardholder to complete authentication (3D Secure), which cannot be done automatically; the booking stays pending until they do, or until the member saves a different card.";
    case "processing":
      return "The charge is still being processed by the card network; Stripe will report the outcome, and the booking stays pending until it does.";
    case "canceled":
      return "The earlier charge attempt for this booking was cancelled before it completed and has been closed; a new attempt can now be started.";
    case "requires_payment_method":
      return "The earlier charge attempt for this booking failed at the card issuer and has been closed; a new attempt can now be started.";
    default:
      return `The charge did not complete (Stripe reports the payment as "${status}"); the booking stays pending.`;
  }
}

export interface SettledSavedCardChargeAttempt {
  /** The ledger row that now records this intent. */
  transactionId: string;
  ledgerStatus: PaymentStatus;
  /**
   * True when a row for this intent already existed and was kept, the attempt
   * row being deleted in its favour — a webhook that beat this write, or a
   * superseded attempt's intent that turned out to have captured.
   */
  keptExistingRow: boolean;
}

/**
 * Record Stripe's answer on the attempt row and re-derive the Payment aggregate.
 *
 * Normally: the attempt row gains the intent id, the mapped status, the intent's
 * amount and the card that was charged, then `reconcilePaymentAggregates` runs
 * — exactly what `upsertPaymentIntentTransaction` did for the old inline rows,
 * which every caller used to call here and no longer does.
 *
 * `stripePaymentIntentId` is unique, so if a row for this intent already exists
 * the ATTEMPT row is deleted and the existing row is kept, its status moved
 * FORWARD to what Stripe answered — never backward: a captured answer is written
 * over anything but refund history (a webhook may already have written it, in
 * which case this is a no-op), and a non-captured answer is written only over an
 * unresolved row, so a stale `processing` read can never undo a webhook's
 * SUCCEEDED. Two histories reach this branch. A superseded attempt's intent
 * that `chargeSavedCardAttempt` found already captured: its row was marked
 * FAILED under the claim and is corrected here. And a webhook that wrote the
 * intent's row first — which no handler does today (`handlePaymentIntentSucceeded`
 * and both failure handlers look the intent up and warn when nothing is found),
 * so for that history the pre-check and the `P2002` catch are defensive; they
 * exist because the write is on a unique column and the alternative is a thrown
 * constraint error on a path that has just captured money.
 *
 * `store`: the cron's and charge-saved-method's non-captured branches record
 * inside the same locked release transaction they always used (`store: tx`),
 * keeping the lock topology unchanged. A unique violation inside a caller's
 * transaction cannot be recovered from (PostgreSQL aborts the transaction on
 * the first error), so on a transaction client the pre-check is the only
 * defence and the violation propagates — stated here rather than discovered.
 */
export async function settleSavedCardChargeAttempt(params: {
  attemptRowId: string;
  paymentIntent: Pick<Stripe.PaymentIntent, "id" | "status" | "amount" | "payment_method">;
  store?: PaymentStore;
}): Promise<SettledSavedCardChargeAttempt> {
  const { attemptRowId, paymentIntent } = params;
  const store = params.store ?? prisma;
  const ledgerStatus = ledgerStatusForPaymentIntent(paymentIntent.status);
  const paymentMethodId = stripeReferenceId(paymentIntent.payment_method);
  const answer = { ledgerStatus, amountCents: paymentIntent.amount, paymentMethodId };

  const existing = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntent.id },
    select: { id: true, paymentId: true },
  });
  if (existing && existing.id !== attemptRowId) {
    return keepExistingRow(store, { attemptRowId, existing, answer });
  }

  try {
    const recorded = await store.paymentTransaction.update({
      where: { id: attemptRowId },
      data: {
        stripePaymentIntentId: paymentIntent.id,
        status: ledgerStatus,
        amountCents: paymentIntent.amount,
        paymentMethodId,
      },
      select: { id: true, paymentId: true },
    });
    await reconcilePaymentAggregates({ paymentId: recorded.paymentId, store });
    return { transactionId: recorded.id, ledgerStatus, keptExistingRow: false };
  } catch (err) {
    if (!isPrismaUniqueConstraintError(err)) throw err;
    const winner = await store.paymentTransaction.findUnique({
      where: { stripePaymentIntentId: paymentIntent.id },
      select: { id: true, paymentId: true },
    });
    if (!winner || winner.id === attemptRowId) throw err;
    return keepExistingRow(store, { attemptRowId, existing: winner, answer });
  }
}

async function keepExistingRow(
  store: PaymentStore,
  params: {
    attemptRowId: string;
    existing: { id: string; paymentId: string };
    answer: {
      ledgerStatus: PaymentStatus;
      amountCents: number;
      paymentMethodId: string | null;
    };
  }
): Promise<SettledSavedCardChargeAttempt> {
  const { attemptRowId, existing, answer } = params;
  // Forward only. A capture overwrites anything but refund history; a
  // non-capture overwrites only an unresolved row.
  const moved =
    answer.ledgerStatus === PaymentStatus.SUCCEEDED
      ? await store.paymentTransaction.updateMany({
          where: {
            id: existing.id,
            status: {
              notIn: [PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED],
            },
          },
          data: {
            status: PaymentStatus.SUCCEEDED,
            amountCents: answer.amountCents,
            ...(answer.paymentMethodId !== null
              ? { paymentMethodId: answer.paymentMethodId }
              : {}),
          },
        })
      : await store.paymentTransaction.updateMany({
          where: { id: existing.id, status: { in: [...UNRESOLVED_ATTEMPT_STATUSES] } },
          data: { status: answer.ledgerStatus, amountCents: answer.amountCents },
        });
  // Only an attempt row that never got its intent is ours to remove.
  await store.paymentTransaction.deleteMany({
    where: { id: attemptRowId, stripePaymentIntentId: null },
  });
  await reconcilePaymentAggregates({ paymentId: existing.paymentId, store });
  logger.warn(
    {
      attemptRowId,
      keptTransactionId: existing.id,
      ledgerStatus: answer.ledgerStatus,
      moved: moved.count > 0,
    },
    "A ledger row for this intent already existed; kept it, moved its status forward and removed the attempt row (#3267)"
  );
  return {
    transactionId: existing.id,
    ledgerStatus: answer.ledgerStatus,
    keptExistingRow: true,
  };
}
