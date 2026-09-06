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
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import type Stripe from "stripe";

import logger from "@/lib/logger";
import { prisma } from "./prisma";
import { stripeReferenceId } from "./stripe-references";
import { isPrismaUniqueConstraintError } from "./prisma-errors";
import {
  reconcilePaymentAggregates,
  type PaymentStore,
} from "./payment-transactions";
import {
  SAVED_CARD_CHARGE_KEY_PREFIX,
  savedCardChargeIdempotencyKey,
  UNRESOLVED_ATTEMPT_STATUSES,
} from "./saved-card-charge-attempt";

/**
 * The part of a PaymentIntent the ledger records. Callers that carry an answer
 * from the charge into a later transaction (the routes' locked release) pass
 * this rather than a callback, so the release helper stays a plain function of
 * data — which is also what keeps it out of the transaction-wrapper population
 * `lock-bound-club-zone-outside-transaction.test.ts` polices.
 */
export type SavedCardChargeAnswer = Pick<
  Stripe.PaymentIntent,
  "id" | "status" | "amount" | "payment_method"
>;

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
  /**
   * The row's status after this call: Stripe's answer when it was written, the
   * row's OWN (later) status when the forward-only guard refused the write.
   * Callers branch on this rather than on the intent's status, so a caller
   * never describes as "processing" a row a webhook has already settled.
   */
  ledgerStatus: PaymentStatus;
  /**
   * True when a row for this intent already existed and was kept, the attempt
   * row being deleted in its favour — a webhook that beat this write, or a
   * superseded attempt's intent that turned out to have captured or still to
   * be processing.
   */
  keptExistingRow: boolean;
  /**
   * False when nothing was written because the row had already moved PAST the
   * answer — a webhook settled it between the retrieve and this write — in
   * which case the aggregate was not re-derived either (the webhook's write
   * did that).
   */
  moved: boolean;
}

/**
 * The forward-only status guard both writes below share (`INV-SSOT-002`): a
 * capture is written over anything but refund history; a non-capture is written
 * only over an unresolved row, so a stale `processing` read can never undo a
 * webhook's SUCCEEDED (or a webhook's FAILED).
 */
function forwardOnlyStatusGuard(answer: PaymentStatus) {
  return answer === PaymentStatus.SUCCEEDED
    ? { notIn: [PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED] }
    : { in: [...UNRESOLVED_ATTEMPT_STATUSES] };
}

/**
 * Record Stripe's answer on the attempt row and re-derive the Payment aggregate.
 *
 * Normally: the attempt row gains the intent id, the mapped status, the intent's
 * amount and the card that was charged, then `reconcilePaymentAggregates` runs
 * — exactly what `upsertPaymentIntentTransaction` did for the old inline rows,
 * which every caller used to call here and no longer does. The write is
 * FORWARD ONLY, on the attempt's own row as much as on a kept one: a capture is
 * written over anything but refund history, a non-capture only over an
 * unresolved row. The race this closes is real on every path: the retrieve
 * says `processing`, the `succeeded` webhook lands and settles the booking
 * (row SUCCEEDED, booking PAID) before the release transaction takes its
 * locks, and an unguarded write would then put PROCESSING over SUCCEEDED, the
 * reconcile would derive `Payment.status = PROCESSING`, and the release's
 * status-guarded CONFIRMED -> PENDING would match nothing and throw nothing —
 * a PAID booking whose ledger shows no captured money. When the guard refuses
 * the write, the row's current status is read back and returned as
 * `ledgerStatus` with `moved: false`, and no reconcile runs.
 *
 * `stripePaymentIntentId` is unique, so if a row for this intent already exists
 * the ATTEMPT row is deleted and the existing row is kept, its status moved
 * forward under the same guard. Three histories reach this branch. A
 * superseded attempt's intent that `chargeSavedCardAttempt` found already
 * captured: its row was marked FAILED under the claim and is corrected here.
 * One it found still `processing`: its row was put back to PROCESSING before
 * this call, so the guard admits the answer and the fresh row is removed. And
 * a webhook that wrote the intent's row first — which no handler does today
 * (`handlePaymentIntentSucceeded` and both failure handlers look the intent up
 * and adopt the attempt row by key when nothing is found), so for that history
 * the pre-check and the `P2002` catch are defensive; they exist because the
 * write is on a unique column and the alternative is a thrown constraint error
 * on a path that has just captured money.
 *
 * `paymentId` is the payment the attempt row belongs to, which every caller
 * holds from its claim; taking it here saves a read of the row on the path
 * that has just captured money.
 *
 * `store`: EVERY path's non-captured branch records inside the same locked
 * release transaction it releases in (`store: tx`) — the cron's, the admin
 * route's and charge-saved-method's — and each re-reads the booking's status
 * under those locks after recording, releasing only a booking still CONFIRMED
 * (a webhook that has since settled it is left alone). A unique violation
 * inside a caller's transaction cannot be recovered from (PostgreSQL aborts the
 * transaction on the first error), so on a transaction client the pre-check is
 * the only defence and the violation propagates — stated here rather than
 * discovered.
 */
export async function settleSavedCardChargeAttempt(params: {
  attemptRowId: string;
  paymentId: string;
  paymentIntent: SavedCardChargeAnswer;
  store?: PaymentStore;
}): Promise<SettledSavedCardChargeAttempt> {
  const { attemptRowId, paymentId, paymentIntent } = params;
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
    const moved = await store.paymentTransaction.updateMany({
      where: { id: attemptRowId, status: forwardOnlyStatusGuard(ledgerStatus) },
      data: {
        stripePaymentIntentId: paymentIntent.id,
        status: ledgerStatus,
        amountCents: paymentIntent.amount,
        ...(paymentMethodId !== null ? { paymentMethodId } : {}),
      },
    });
    if (moved.count === 0) {
      const current = await store.paymentTransaction.findUnique({
        where: { id: attemptRowId },
        select: { status: true },
      });
      logger.warn(
        {
          attemptRowId,
          paymentIntentId: paymentIntent.id,
          answered: ledgerStatus,
          rowStatus: current?.status ?? null,
        },
        "The attempt row had already moved past Stripe's answer (a webhook won); left it as it is (#3267)"
      );
      return {
        transactionId: attemptRowId,
        ledgerStatus: current?.status ?? ledgerStatus,
        keptExistingRow: false,
        moved: false,
      };
    }
    await reconcilePaymentAggregates({ paymentId, store });
    return { transactionId: attemptRowId, ledgerStatus, keptExistingRow: false, moved: true };
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
  const moved = await store.paymentTransaction.updateMany({
    where: { id: existing.id, status: forwardOnlyStatusGuard(answer.ledgerStatus) },
    data: {
      status: answer.ledgerStatus,
      amountCents: answer.amountCents,
      ...(answer.paymentMethodId !== null
        ? { paymentMethodId: answer.paymentMethodId }
        : {}),
    },
  });
  // Only an attempt row that never got its intent is ours to remove.
  await store.paymentTransaction.deleteMany({
    where: { id: attemptRowId, stripePaymentIntentId: null },
  });
  await reconcilePaymentAggregates({ paymentId: existing.paymentId, store });
  const current =
    moved.count > 0
      ? null
      : await store.paymentTransaction.findUnique({
          where: { id: existing.id },
          select: { status: true },
        });
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
    ledgerStatus: current?.status ?? answer.ledgerStatus,
    keptExistingRow: true,
    moved: moved.count > 0,
  };
}

/**
 * A `payment_intent.*` webhook for an intent the ledger does not know: find the
 * attempt row whose POST minted it, by the idempotency key Stripe stamps on the
 * event (`Stripe.Event.request.idempotency_key` — the key the originating
 * request carried), and record the answer on it.
 *
 * This is the recovery for a lost response. A fresh attempt's POST executes and
 * captures, the response never reaches us (timeout, deploy, crash), and the row
 * sits PENDING with no intent id. Nothing local can link the capture to the row
 * — except the key, which is the one thing both sides hold: the row stores it
 * on `reference` and Stripe echoes it on every event the request produced.
 * Without this, the `succeeded` webhook found no row, warned, and returned; the
 * capture was invisible even to the #1992 duplicate-capture backstop, and after
 * Stripe's 24-hour key window the next attempt's re-send was a SECOND charge.
 *
 * Only a PENDING/PROCESSING attempt row with NO intent id is adopted, and only
 * when the key is the one that row's OWN id builds (the same rule
 * `beginSavedCardChargeAttempt` recognises attempt rows by), so a stray key can
 * never claim another row. The write itself is `settleSavedCardChargeAttempt`,
 * forward only, so a race with the charging code's own settle resolves the same
 * way from either side. Returns null when there is nothing to adopt — no key on
 * the event, not our prefix, no such row — and the handler proceeds as before.
 */
export async function adoptSavedCardChargeAttemptForIntent(params: {
  paymentIntent: SavedCardChargeAnswer;
  bookingId: string;
  idempotencyKey: string | null | undefined;
  store?: PaymentStore;
}): Promise<SettledSavedCardChargeAttempt | null> {
  const { paymentIntent, bookingId, idempotencyKey } = params;
  const store = params.store ?? prisma;
  if (!idempotencyKey?.startsWith(SAVED_CARD_CHARGE_KEY_PREFIX)) return null;

  const row = await store.paymentTransaction.findFirst({
    where: {
      reference: idempotencyKey,
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: null,
      status: { in: [...UNRESOLVED_ATTEMPT_STATUSES] },
    },
    select: { id: true, paymentId: true },
  });
  if (!row || savedCardChargeIdempotencyKey(bookingId, row.id) !== idempotencyKey) {
    return null;
  }

  logger.warn(
    {
      bookingId,
      attemptRowId: row.id,
      paymentIntentId: paymentIntent.id,
      paymentStatus: paymentIntent.status,
    },
    "Adopted a saved-card charge attempt row for a webhook whose intent the ledger did not know, by the event's idempotency key (#3267)"
  );
  return settleSavedCardChargeAttempt({
    attemptRowId: row.id,
    paymentId: row.paymentId,
    paymentIntent,
    store,
  });
}
