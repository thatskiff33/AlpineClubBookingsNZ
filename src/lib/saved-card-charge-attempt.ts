/**
 * #3267 (epic #3270) — one saved-card charge attempt is one durable ledger row
 * with its own Stripe idempotency key (`INV-PAY-055`).
 *
 * Three call sites charge a saved card off-session: the confirm-pending cron
 * (`cron-confirm-pending.ts`), the admin "Confirm pending guests" route and the
 * `charge-saved-method` route. Until #3267 all three sent ONE Stripe idempotency
 * key, `pending_charge_<bookingId>`, and relied on it as the guard that stopped
 * two paths charging one booking twice. Stripe fingerprints the whole request
 * body under that key, and the admin route's metadata differed, so whichever
 * path charged first locked the key with its own shape and the admin route could
 * only ever get "Keys for idempotent requests can only be used with the same
 * parameters" back — five times over 21 hours in production, each one hiding
 * the real refusal (#3268). A re-saved card changed the fingerprint the same
 * way, so a fresh card was refused for up to 24 hours. Owner decision, 5 Sep
 * 2026 (option b on #3267): every attempt gets its own key, and the
 * never-double-charge guard moves onto the `PaymentTransaction` ledger.
 *
 * The contract, in the order a caller uses it:
 *
 *   1. `beginSavedCardChargeAttempt` — INSIDE the caller's claim transaction,
 *      i.e. under global `pg_advisory_xact_lock(1)` and the lodge capacity lock,
 *      after the status-guarded PENDING -> CONFIRMED claim. It reads this
 *      payment's PRIMARY Stripe rows and decides, under those locks, whether an
 *      earlier attempt is still unresolved (replay it), has been overtaken by a
 *      new card (end it and cancel its intent), or has already captured money
 *      (refuse). Otherwise it creates the attempt row and mints the key from the
 *      row's OWN id, so the key exists before Stripe is asked anything.
 *   2. `cancelStaleSavedCardChargeIntents` — AFTER that transaction commits,
 *      best-effort, a plain provider call (`INV-INT-003`).
 *   3. `chargeSavedCardAttempt` — the ONLY place a saved card is charged. Same
 *      metadata for every caller, key from the row, and the thrown failure is
 *      partitioned into DEFINITE (Stripe answered: the row is marked FAILED so
 *      the next attempt is fresh) and AMBIGUOUS (nothing certain came back: the
 *      row stays PENDING so the next attempt asks about THIS one).
 *   4. `settleSavedCardChargeAttempt` — records the intent Stripe answered with
 *      on the attempt row and re-derives the Payment aggregate.
 *
 * Why the guard holds without a shared key. Every path writes its attempt row
 * inside the same two-lock claim transaction, so two paths can never both hold
 * an open attempt for one payment: the second to take the locks reads the
 * first's row and either replays it or refuses. What Stripe's shared key used to
 * provide by accident — "the cron and the admin can never double-charge one
 * booking" — is now a property of the ledger under locks the claim already
 * takes, and it covers the third path (`charge-saved-method`) too, which the
 * old admin metadata never did.
 *
 * Why a replay RETRIEVES rather than re-sends the key when it can. Stripe's
 * idempotency layer replays the ORIGINAL response body, not the intent's current
 * state: a key whose first answer was `requires_action` answers `requires_action`
 * for ever, however the member's 3DS challenge ended, and after the 24-hour key
 * window the same re-send EXECUTES A NEW CHARGE. So an unresolved row that
 * already names its intent is asked about with `getPaymentIntent` — a read,
 * with no key and no window — and the recorded key is re-sent only for a row
 * whose first POST never answered at all, where the key is the one thing that
 * identifies the attempt at Stripe. Either way there is exactly one instrument
 * per attempt, which is the property the owner chose.
 *
 * What the ledger rows now mean, so nobody "tidies" them: a PRIMARY Stripe row
 * with a `reference` in this module's key format is a saved-card charge attempt.
 * PENDING with no intent id: minted, Stripe not yet (or not certainly) asked.
 * PROCESSING with an intent id: Stripe answered with an unfinished intent.
 * FAILED: this attempt is over — a definite refusal, a dead intent, or overtaken
 * by a later card (`reason` suffixed with why). SUCCEEDED: captured.
 *
 * Ordering with #3268 (INV-PAY-054), written here because it is load-bearing and
 * invisible from either side alone: `retireUnusableSavedCard` nulls
 * `PaymentTransaction.paymentMethodId` on every row carrying the retired pm,
 * which includes attempt rows. That is safe ONLY because a definite failure
 * marks the attempt FAILED before the rethrow reaches the cron's terminal
 * branch. Were the row still PENDING with its pm nulled, the next attempt would
 * read "unresolved, no card, no intent" and replay a key whose stored body names
 * the retired card — an `idempotency_error` on the new card. Pinned in
 * `saved-card-charge-attempt.test.ts` and `cron-confirm-pending.test.ts`.
 */
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import type Stripe from "stripe";

import logger from "@/lib/logger";
import { prisma } from "./prisma";
import {
  cancelPaymentIntentIfCancellable,
  chargePaymentMethod,
  getPaymentIntent,
} from "./stripe";
import { readStripeErrorFields } from "./stripe-errors";
import { stripeReferenceId } from "./stripe-references";
import { isPrismaUniqueConstraintError } from "./prisma-errors";
import {
  isCapturedTransactionStatus,
  reconcilePaymentAggregates,
  type PaymentStore,
} from "./payment-transactions";

/**
 * The one prefix every saved-card charge key carries. The #1992 pre-charge
 * sweep in the cron excludes attempt rows by `reference: { startsWith }` on this
 * constant, and `savedCardChargeIdempotencyKey` builds the key from it, so the
 * sweep and the mint cannot disagree about what an attempt row looks like
 * (`INV-SSOT-002`). The bare pre-#3267 key `pending_charge_<bookingId>` is
 * retired; nothing mints it and nothing matches on it.
 */
export const SAVED_CARD_CHARGE_KEY_PREFIX = "pending_charge_";

/**
 * The ledger `reason` each path stamps on the attempt row it mints. The reason
 * records WHICH path started the attempt (the metadata no longer does — see
 * `buildSavedCardChargeMetadata`); the row's `reference` is what identifies it
 * as an attempt. Typed as a closed union so a fourth caller has to add itself
 * here rather than invent a spelling.
 */
export const SAVED_CARD_CHARGE_REASON = {
  cron: "pending_hold_auto_charge",
  adminConfirmPendingGuests: "admin_confirm_pending_guests_charge",
  chargeSavedMethodRoute: "pending_saved_method_charge",
} as const;

export type SavedCardChargeReason =
  (typeof SAVED_CARD_CHARGE_REASON)[keyof typeof SAVED_CARD_CHARGE_REASON];

/**
 * The Stripe `metadata` every saved-card charge sends — the cron, the admin
 * confirm-pending-guests route and the charge-saved-method route, byte for byte.
 * Modelled on `buildBookingCancellationRefundMetadata` (#1494): the shape is a
 * pure function of the two ids and carries no per-path value, because the admin
 * route's `source: "admin_confirm_pending_guests"` is exactly what made Stripe
 * refuse the shared key with an idempotency parameter mismatch. Which path
 * minted an attempt is recorded on the ledger row's `reason` instead. Nothing
 * downstream reads this metadata off the intent; it is dashboard-only — the
 * webhook reads `bookingId` from it, which is unchanged.
 *
 * Exported for the docblock and the tests; `chargeSavedCardAttempt` builds it
 * itself from the ids it is handed, so no caller can pass a different shape.
 */
export function buildSavedCardChargeMetadata(
  bookingId: string,
  memberId: string
): Record<string, string> {
  return { bookingId, memberId };
}

/**
 * The idempotency key for ONE attempt: the booking id for the operator reading
 * the Stripe dashboard, the attempt row's own id for uniqueness. Stored on the
 * row's `reference` (an indexed free-text column used until now only for
 * Internet-Banking references), so the key can be re-sent when a first POST
 * never answered, and so a row can be recognised as an attempt.
 */
export function savedCardChargeIdempotencyKey(
  bookingId: string,
  attemptRowId: string
): string {
  return `${SAVED_CARD_CHARGE_KEY_PREFIX}${bookingId}_${attemptRowId}`;
}

/** A card the caller has already judged chargeable (`INV-PAY-053`). */
export interface SavedCardToCharge {
  stripeCustomerId: string;
  stripePaymentMethodId: string;
}

/**
 * What `beginSavedCardChargeAttempt` hands back: which row this attempt IS, how
 * to ask Stripe about it, and which earlier intents the caller must cancel
 * best-effort once its transaction has committed.
 *
 * - `fresh`: a new row; `idempotencyKey` is to be sent with the charge.
 * - `replay`: an earlier attempt on the same card is unresolved. When it names
 *   its intent (`paymentIntentId`), the charge step RETRIEVES that intent; when
 *   it does not (its first POST never answered), the charge step re-sends its
 *   key, which Stripe answers with the stored result or executes exactly once.
 */
export type SavedCardChargeAttempt =
  | {
      kind: "fresh";
      attemptRowId: string;
      idempotencyKey: string;
      staleIntentIdsToCancel: string[];
    }
  | {
      kind: "replay";
      attemptRowId: string;
      idempotencyKey: string;
      paymentIntentId: string | null;
      staleIntentIdsToCancel: string[];
    };

/**
 * Thrown by `beginSavedCardChargeAttempt` when a PRIMARY row on this payment
 * already holds captured money while the booking is somehow still PENDING.
 * Thrown rather than returned so the caller's claim transaction ROLLS BACK —
 * which is precisely "release the claim": the PENDING -> CONFIRMED claim, the bed
 * reconcile and the link revocation all unwind, and no charge is attempted.
 * Callers catch it by type, log at error level and alert an administrator; the
 * message is plain English because it is what the alert and the admin response
 * say.
 */
export class SavedCardChargeRefusedError extends Error {
  readonly bookingId: string;
  readonly paymentIntentId: string | null;

  constructor(params: { bookingId: string; paymentIntentId: string | null }) {
    super(
      `A captured charge${params.paymentIntentId ? ` (${params.paymentIntentId})` : ""} is already recorded on this booking's payment while the booking is still pending, so no new charge was attempted. An administrator needs to check the payment and either settle the booking or refund the charge by hand.`
    );
    this.name = "SavedCardChargeRefusedError";
    this.bookingId = params.bookingId;
    this.paymentIntentId = params.paymentIntentId;
  }
}

type AttemptLedgerRow = {
  id: string;
  status: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
  paymentMethodId: string | null;
  stripePaymentIntentId: string | null;
  reference: string | null;
  reason: string | null;
  createdAt: Date;
};

const UNRESOLVED_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
]);

function isAttemptRow(row: AttemptLedgerRow, bookingId: string): boolean {
  return row.reference === savedCardChargeIdempotencyKey(bookingId, row.id);
}

/**
 * Decide, under the caller's locks, what this charge attempt is — then make it
 * durable before Stripe is asked anything.
 *
 * MUST run inside the caller's claim transaction: global `lock(1)`, then the
 * lodge capacity lock, after the status-guarded PENDING -> CONFIRMED claim and
 * the `Payment` upsert that yields `paymentId`. The type cannot enforce that (a
 * `PrismaClient` is assignable to `Prisma.TransactionClient`); the callers' lock
 * sites are registered in `advisory-lock-guard.test.ts` (`INV-LOCK-003`) and the
 * per-caller tests pin the ordering. Every write here is status-guarded so a
 * replayed transaction cannot regress a row another writer has since moved.
 *
 * In order:
 *
 *   a. Load this payment's PRIMARY Stripe rows.
 *   b. A row still holding net captured cash (SUCCEEDED or PARTIALLY_REFUNDED —
 *      `isCapturedTransactionStatus` minus the fully refunded, which is #1765
 *      history a repay may legitimately follow) means money is already taken
 *      while the booking is still PENDING: THROW `SavedCardChargeRefusedError`.
 *      Never charge on top of it.
 *   c. An unresolved (PENDING/PROCESSING) attempt row on the SAME card — or
 *      with no card and no intent, the shape #3268's retire leaves when it nulls
 *      the pm off a row whose first POST never answered — is REPLAYED. The
 *      newest such row is the attempt; any older one is a duplicate and is
 *      ended.
 *   d. Every other unresolved row is ENDED: a row on a DIFFERENT card (the
 *      previous card was retired by #3268 or replaced via #3266), a row whose
 *      card was nulled but whose intent still exists, or a row that is not an
 *      attempt row at all (no key of ours to re-send). It is marked FAILED with
 *      its `reason` suffixed, and its intent id, if any, is returned for the
 *      caller to cancel best-effort AFTER commit (`cancelStaleSavedCardChargeIntents`,
 *      a provider call kept out of the transaction — `INV-INT-003`). If that
 *      intent succeeds anyway — the member finished a 3DS challenge as the cancel
 *      arrived — its webhook settles the booking through the FAILED row it still
 *      names, and this attempt's capture is the duplicate the #1992 auto-refund
 *      hands back (`INV-PAY-043`).
 *   e. Otherwise create the attempt row (PENDING, this card, this path's reason)
 *      and stamp its `reference` with the key built from ITS OWN id — two
 *      statements, one transaction.
 *
 * The Payment aggregate is deliberately NOT re-derived here: the claim's own
 * upsert has just set it, and `settleSavedCardChargeAttempt` reconciles once
 * the intent is known. A consequence the reader should expect (#3269,
 * `INV-PAY-053`): the attempt row carries the card that will be charged, and a
 * later reconcile of a PENDING split child — a `Payment` row with no
 * `stripeSetupIntentId` — mirrors that borrowed pm onto the child's row. That
 * copy is harmless because the provenance predicate refuses it (no SetupIntent
 * beside it), which is what `INV-PAY-053` says the predicate is FOR.
 */
export async function beginSavedCardChargeAttempt(
  tx: Prisma.TransactionClient,
  params: {
    paymentId: string;
    bookingId: string;
    amountCents: number;
    card: Pick<SavedCardToCharge, "stripePaymentMethodId">;
    reason: SavedCardChargeReason;
  }
): Promise<SavedCardChargeAttempt> {
  const { paymentId, bookingId, amountCents, card, reason } = params;

  const rows: AttemptLedgerRow[] = await tx.paymentTransaction.findMany({
    where: {
      paymentId,
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.STRIPE,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      amountCents: true,
      refundedAmountCents: true,
      paymentMethodId: true,
      stripePaymentIntentId: true,
      reference: true,
      reason: true,
      createdAt: true,
    },
  });

  // (b) Money already taken. A fully REFUNDED row is history, not cash.
  const captured = rows.find(
    (row) =>
      isCapturedTransactionStatus(row.status) &&
      row.amountCents - row.refundedAmountCents > 0
  );
  if (captured) {
    throw new SavedCardChargeRefusedError({
      bookingId,
      paymentIntentId: captured.stripePaymentIntentId,
    });
  }

  const unresolved = rows.filter((row) => UNRESOLVED_STATUSES.has(row.status));
  const replayable = unresolved.filter(
    (row) =>
      isAttemptRow(row, bookingId) &&
      (row.paymentMethodId === card.stripePaymentMethodId ||
        (row.paymentMethodId === null && row.stripePaymentIntentId === null))
  );
  // Newest first: the last replayable row is THE attempt; anything older is a
  // duplicate that should never have coexisted with it.
  const replay = replayable.length > 0 ? replayable[replayable.length - 1]! : null;

  const staleIntentIdsToCancel: string[] = [];
  for (const row of unresolved) {
    if (row === replay) continue;
    const suffix = !isAttemptRow(row, bookingId)
      ? "superseded_unknown_key"
      : replayable.includes(row)
        ? "superseded_duplicate_attempt"
        : "superseded_by_new_card";
    // Status-guarded: a webhook that has since settled or failed this row wins.
    const ended = await tx.paymentTransaction.updateMany({
      where: { id: row.id, status: { in: [...UNRESOLVED_STATUSES] } },
      data: {
        status: PaymentStatus.FAILED,
        reason: `${row.reason ?? "saved_card_charge"}:${suffix}`,
      },
    });
    if (ended.count > 0 && row.stripePaymentIntentId) {
      staleIntentIdsToCancel.push(row.stripePaymentIntentId);
    }
    logger.warn(
      {
        bookingId,
        paymentId,
        supersededTransactionId: row.id,
        supersededPaymentIntentId: row.stripePaymentIntentId,
        suffix,
        ended: ended.count > 0,
      },
      "Ended an unresolved saved-card charge attempt that a new attempt supersedes (#3267)"
    );
  }

  if (replay) {
    return {
      kind: "replay",
      attemptRowId: replay.id,
      // Guaranteed by isAttemptRow; spelled out so the type is honest.
      idempotencyKey: replay.reference ?? savedCardChargeIdempotencyKey(bookingId, replay.id),
      paymentIntentId: replay.stripePaymentIntentId,
      staleIntentIdsToCancel,
    };
  }

  const created = await tx.paymentTransaction.create({
    data: {
      paymentId,
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.STRIPE,
      amountCents,
      status: PaymentStatus.PENDING,
      paymentMethodId: card.stripePaymentMethodId,
      reason,
    },
    select: { id: true },
  });
  const idempotencyKey = savedCardChargeIdempotencyKey(bookingId, created.id);
  await tx.paymentTransaction.update({
    where: { id: created.id },
    data: { reference: idempotencyKey },
  });

  return {
    kind: "fresh",
    attemptRowId: created.id,
    idempotencyKey,
    staleIntentIdsToCancel,
  };
}

/**
 * Best-effort Stripe-side cancellation of the intents `beginSavedCardChargeAttempt`
 * ended, run by the caller AFTER its claim transaction has committed and BEFORE
 * it charges (`INV-INT-003`: never a provider call inside the transaction).
 * Same shape and same reasoning as the cron's #1992 link-intent sweep: a cancel
 * that loses its race (the intent already succeeded) is logged as expected and
 * the #1992 duplicate-capture refund is the backstop; a cancel that errors is
 * logged and never blocks the charge.
 */
export async function cancelStaleSavedCardChargeIntents(
  attempt: SavedCardChargeAttempt,
  ctx: { bookingId: string }
): Promise<void> {
  for (const paymentIntentId of attempt.staleIntentIdsToCancel) {
    try {
      const canceled = await cancelPaymentIntentIfCancellable(paymentIntentId);
      if (canceled) {
        logger.info(
          { bookingId: ctx.bookingId, paymentIntentId },
          "Cancelled the intent of a superseded saved-card charge attempt (#3267)"
        );
      } else {
        logger.warn(
          { bookingId: ctx.bookingId, paymentIntentId },
          "A superseded saved-card charge attempt's intent was not cancellable (it may have succeeded); the #1992 duplicate-capture refund is the backstop (#3267)"
        );
      }
    } catch (cancelErr) {
      logger.error(
        { err: cancelErr, bookingId: ctx.bookingId, paymentIntentId },
        "Failed to cancel a superseded saved-card charge attempt's intent; proceeding with the charge (best-effort, #3267)"
      );
    }
  }
}

/**
 * Stripe API error types under which the request was ANSWERED, so we know no
 * charge is pending from it: the card or the request was refused
 * (`card_error`, `invalid_request_error`), the key was refused
 * (`idempotency_error`), or the credentials were (`authentication_error`).
 * Everything else — `api_error` (5xx: Stripe may have executed it),
 * `rate_limit_error`, a connection error or timeout (no API type at all), a
 * plain `Error` — leaves it uncertain whether the charge happened, and the row
 * stays PENDING so the next attempt asks about THIS one rather than starting a
 * second.
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
 * before refusing, is already terminal). The Payment aggregate is not
 * re-derived here; the next settle or webhook reconcile derives FAILED from
 * the ledger, which is the same shape today's thrown charge leaves behind.
 */
export async function failSavedCardChargeAttempt(
  attemptRowId: string,
  store: PaymentStore = prisma
): Promise<{ ended: boolean }> {
  const ended = await store.paymentTransaction.updateMany({
    where: { id: attemptRowId, status: { in: [...UNRESOLVED_STATUSES] } },
    data: { status: PaymentStatus.FAILED },
  });
  return { ended: ended.count > 0 };
}

/**
 * Ask Stripe about this attempt — the ONLY place a saved card is charged.
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
 * why that order matters against `retireUnusableSavedCard`). If the FAILED
 * mark itself fails, that is logged and the Stripe error is still what is
 * thrown; the row stays PENDING and the next attempt replays the key, which
 * Stripe answers with the same refusal, and the mark is retried then. An
 * AMBIGUOUS failure leaves the row as it is and rethrows.
 */
export async function chargeSavedCardAttempt(params: {
  attempt: SavedCardChargeAttempt;
  bookingId: string;
  memberId: string;
  amountCents: number;
  card: SavedCardToCharge;
}): Promise<Stripe.PaymentIntent> {
  const { attempt, bookingId, memberId, amountCents, card } = params;
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
    if (isDefiniteSavedCardChargeFailure(err)) {
      try {
        const { ended } = await failSavedCardChargeAttempt(attempt.attemptRowId);
        logger.warn(
          {
            bookingId,
            attemptRowId: attempt.attemptRowId,
            ended,
            stripeType: readStripeErrorFields(err).apiType,
            stripeCode: readStripeErrorFields(err).code,
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
        { bookingId, attemptRowId: attempt.attemptRowId },
        "Saved-card charge attempt failed without a definite answer from Stripe; leaving it pending so the next attempt asks about this one (#3267)"
      );
    }
    throw err;
  }
}

/**
 * The ledger status an answered PaymentIntent maps to. `succeeded` is captured;
 * `canceled` and `requires_payment_method` (the intent's confirmation failed —
 * the shape a retrieved 3DS attempt has once the member's challenge failed)
 * are OVER, so the row goes FAILED and the next attempt is fresh instead of
 * asking about a dead intent for ever; everything else (`requires_action`,
 * `processing`, `requires_confirmation`, `requires_capture`) is still in
 * flight and stays PROCESSING for the webhook — or the next attempt — to
 * resolve.
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
      return "The saved card needs the cardholder to complete authentication (3D Secure), which cannot be done automatically; the booking stays pending until they do, or until a new attempt is started.";
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
   * True when a row for this intent already existed (written by a webhook that
   * beat this write) and was kept, the attempt row being deleted in its favour.
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
 * The race this guards, and how live it is: `stripePaymentIntentId` is unique,
 * so if a row for this intent already exists — a webhook that arrived before
 * this write — the ATTEMPT row is deleted and the existing row is kept, gaining
 * the attempt's `reference` and `reason` so later attempts recognise it as one
 * of theirs. Today no webhook or recovery path CREATES a row for an intent
 * nobody recorded (`handlePaymentIntentSucceeded` and both failure handlers
 * look the intent up first and log a warning when nothing is found), so the
 * pre-check and the `P2002` catch below are defensive; they exist because the
 * write is on a unique column and the alternative is a thrown constraint error
 * on a path that has just captured money.
 *
 * `store`: the cron's PROCESSING branch records inside the same locked release
 * transaction it always used (`store: tx`), keeping the lock topology unchanged.
 * A unique violation inside a caller's transaction cannot be recovered from
 * (PostgreSQL aborts the transaction on the first error), so on a transaction
 * client the pre-check is the only defence and the violation propagates —
 * stated here rather than discovered.
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

  const existing = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntent.id },
    select: { id: true, paymentId: true },
  });
  if (existing && existing.id !== attemptRowId) {
    return keepExistingRow(store, { attemptRowId, existing, ledgerStatus });
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
    return keepExistingRow(store, { attemptRowId, existing: winner, ledgerStatus });
  }
}

async function keepExistingRow(
  store: PaymentStore,
  params: {
    attemptRowId: string;
    existing: { id: string; paymentId: string };
    ledgerStatus: PaymentStatus;
  }
): Promise<SettledSavedCardChargeAttempt> {
  const ours = await store.paymentTransaction.findUnique({
    where: { id: params.attemptRowId },
    select: { reference: true, reason: true },
  });
  // Only an attempt row that never got its intent is ours to remove.
  await store.paymentTransaction.deleteMany({
    where: { id: params.attemptRowId, stripePaymentIntentId: null },
  });
  await store.paymentTransaction.update({
    where: { id: params.existing.id },
    data: {
      ...(ours?.reference ? { reference: ours.reference } : {}),
      ...(ours?.reason ? { reason: ours.reason } : {}),
    },
  });
  await reconcilePaymentAggregates({ paymentId: params.existing.paymentId, store });
  logger.warn(
    {
      attemptRowId: params.attemptRowId,
      keptTransactionId: params.existing.id,
    },
    "A ledger row for this intent already existed (webhook first); kept it and removed the attempt row (#3267)"
  );
  return {
    transactionId: params.existing.id,
    ledgerStatus: params.ledgerStatus,
    keptExistingRow: true,
  };
}
