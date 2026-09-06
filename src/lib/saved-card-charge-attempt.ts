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
 *      new card (end it; its intent is cancelled in step 2), or whether money
 *      has already been captured (refuse). Otherwise it creates the attempt row
 *      and mints the key from the row's OWN id, so the key exists before Stripe
 *      is asked anything.
 *   2. `chargeSavedCardAttempt` — AFTER that transaction commits; the ONLY place
 *      a saved card is charged. It first cancels, best-effort, the intents of
 *      the attempts step 1 ended (a plain provider call, `INV-INT-003`), and if
 *      one of them turns out to have CAPTURED already — or is still
 *      `processing`, i.e. may capture any second — that intent is the answer
 *      and no charge is made. Then it asks Stripe about this attempt: same
 *      metadata for every caller, key from the row. A thrown failure is
 *      partitioned into DEFINITE (Stripe answered: the row is marked FAILED so
 *      the next attempt is fresh) and AMBIGUOUS (nothing certain came back: the
 *      row stays PENDING so the next attempt asks about THIS one).
 *   3. `settleSavedCardChargeAttempt` (`saved-card-charge-settle.ts`, the other
 *      half of this contract, split at the provider call so each half stays
 *      inside the size budget) — records the intent Stripe answered with on the
 *      attempt row, forward only, and re-derives the Payment aggregate.
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
 * per attempt, which is the property the owner chose; "replayed (same key)" on
 * the issue is honoured in its purpose (Stripe tells us what happened to THAT
 * attempt) by the only mechanism that actually does so.
 *
 * The re-send has a deadline, and it is Stripe's, not ours. Stripe keeps an
 * idempotency key for 24 hours; a key re-sent after that is a brand-new request
 * and executes a brand-new charge, with nothing local able to tell it apart from
 * the first. So a PENDING row with no intent that is older than
 * `SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS` (23 hours — an hour of margin for
 * clock skew and the run itself) is NOT re-sent: `beginSavedCardChargeAttempt`
 * refuses (`attempt_key_expired`) and a person checks Stripe. The state is rare
 * — a fresh POST that executed but whose response was lost is normally
 * recovered within minutes by the `payment_intent.succeeded` (or
 * `payment_failed`) webhook, which adopts the row by the idempotency key Stripe
 * stamps on the event (`adoptSavedCardChargeAttemptForIntent`) — but the
 * alternative to refusing is a charge with no local witness, and a stuck row
 * has two honest exits: a redelivered webhook, or the member saving a card
 * again, which supersedes the attempt.
 *
 * What the ledger rows now mean, so nobody "tidies" them: a PRIMARY Stripe row
 * whose `reference` is this module's key built from ITS OWN id is a saved-card
 * charge attempt. PENDING with no intent id: minted, Stripe not yet (or not
 * certainly) asked. PROCESSING with an intent id: Stripe answered with an
 * unfinished intent. FAILED: this attempt is over — a definite refusal, a dead
 * intent, or overtaken by a later card (`reason` suffixed with why). SUCCEEDED:
 * captured. Rows that are NOT attempt rows fall into two groups. A PRIMARY
 * Stripe row that is unresolved, names an intent and carries THE SAME CARD this
 * attempt would charge — a saved-card row minted under the shared key before
 * #3267, or a /pay link intent the member is paying with that very card — is
 * replayed by retrieve exactly like an attempt row: whoever minted it, it is
 * this booking's money in flight on this card, and charging beside it is the
 * double charge this module exists to prevent. Everything else (a link intent
 * on another card, a legacy row on a since-replaced card) is left to the
 * mechanisms that already own it: the cron's #1992 pre-charge sweep (which
 * excludes attempt rows by the key prefix and the row this run is replaying by
 * id) and the `payment_intent.*` webhooks. This module only ever counts those
 * for one thing — captured money — because money is money whoever minted the
 * row.
 *
 * Ordering with #3268 (INV-PAY-054), written here because it is load-bearing and
 * invisible from either side alone: `retireUnusableSavedCard` nulls
 * `PaymentTransaction.paymentMethodId` on every row carrying the retired pm,
 * which includes attempt rows. That is safe ONLY because a definite failure
 * marks the attempt FAILED before the rethrow reaches the cron's terminal
 * branch. Were the row still PENDING with its pm nulled, the next attempt would
 * read "unresolved, no card, no intent" and replay a key whose stored body names
 * the retired card — an `idempotency_error` on the new card, one wasted run.
 * Pinned in `saved-card-charge-attempt.test.ts` and `cron-confirm-pending.test.ts`.
 *
 * The one shape that CAN still reach that replay: two split children borrowing
 * one parent card, where child A's attempt fails AMBIGUOUSLY (row PENDING, pm
 * set, no intent) and child B's then fails terminally, so #3268 nulls A's pm.
 * A's next attempt on a re-saved card replays its key: if the first POST never
 * executed, Stripe executes it once on the new card; if it did, Stripe answers
 * `idempotency_error` (definite), the row is ended and the run after mints
 * fresh. Only if that first POST also CAPTURED — a lost webhook on top of two
 * rare failures — is the fresh charge a duplicate, and then the #1992
 * duplicate-capture refund is the backstop. Stated rather than engineered
 * around: the alternative is a Stripe search API call on every such replay.
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
  cancelPaymentIntentIfCancellableWithResult,
  chargePaymentMethod,
  getPaymentIntent,
} from "./stripe";
import {
  isStripeResourceMissingError,
  readStripeErrorFields,
} from "./stripe-errors";
import {
  isCapturedTransactionStatus,
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
 * How long a recorded key may still be RE-SENT for a row whose first POST never
 * answered. Stripe keeps an idempotency key for 24 hours; after that the same
 * key is a new request and executes a new charge. 23 hours leaves an hour for
 * clock skew and for the run itself. Measured from the attempt row's
 * `createdAt`, which is stamped before the first POST is ever made, so it can
 * only be EARLIER than the key's real birth at Stripe — the margin errs towards
 * refusing, never towards a second charge.
 */
export const SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * The ledger `reason` each path stamps on the attempt row it mints. The reason
 * records WHICH path started the attempt (the metadata no longer does — see
 * `buildSavedCardChargeMetadata`); the row's `reference` is what identifies it
 * as an attempt. Typed as a closed union so a fourth caller has to add itself
 * here rather than invent a spelling. The cron's and charge-saved-method's
 * literals are the ones those paths stamped before #3267, so a ledger reader
 * sees one spelling per path across the deploy.
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
 * minted an attempt is recorded on the ledger row's `reason` instead. The
 * webhook reads `bookingId` off this metadata, which is unchanged; nothing
 * downstream reads `memberId` — it is dashboard-only.
 *
 * `chargeSavedCardAttempt` builds it itself from the ids it is handed, so no
 * caller can pass a different shape; exported so the tests can pin the shape
 * without reaching into the charge call.
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
 * never answered, so a row can be recognised as an attempt, and so a webhook
 * can find the row by the key Stripe stamps on the event
 * (`Stripe.Event.request.idempotency_key`) when the POST's own response was
 * lost.
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
 * to ask Stripe about it, and which earlier intents `chargeSavedCardAttempt`
 * must cancel best-effort before it charges.
 *
 * - `fresh`: a new row; `idempotencyKey` is to be sent with the charge.
 * - `replay`: an earlier attempt on the same card is unresolved. When it names
 *   its intent (`paymentIntentId`), the charge step RETRIEVES that intent and
 *   `idempotencyKey` is never sent (for a legacy row it is a key nothing ever
 *   sent — see `isAttemptRow`); when it does not (its first POST never
 *   answered), the charge step re-sends its key, which Stripe answers with the
 *   stored result or executes exactly once.
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
 * Why `beginSavedCardChargeAttempt` refused to charge.
 *
 * - `captured_primary_exists`: a PRIMARY row on this payment already holds
 *   captured money while the booking is somehow still PENDING.
 * - `attempt_key_expired`: an earlier attempt's POST never answered and its key
 *   is now past the window in which Stripe would replay rather than re-execute
 *   it (`SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS`).
 */
export type SavedCardChargeRefusal =
  | "captured_primary_exists"
  | "attempt_key_expired";

const REFUSAL_MESSAGES: Record<
  SavedCardChargeRefusal,
  (params: { paymentIntentId: string | null }) => string
> = {
  captured_primary_exists: ({ paymentIntentId }) =>
    `A captured charge${paymentIntentId ? ` (${paymentIntentId})` : ""} is already recorded on this booking's payment while the booking is still pending, so no new charge was attempted. An administrator needs to check the payment and either settle the booking or refund the charge by hand.`,
  attempt_key_expired: () =>
    "An earlier charge attempt for this booking was started more than 23 hours ago and Stripe never confirmed whether it went through. Re-sending it now would be a new charge, so no charge was attempted. An administrator needs to check Stripe for a payment on this booking: if there is one, resend its payment_intent.succeeded event from the Stripe dashboard so it is recorded; if there is none, ask the member to save their card again, which closes this attempt and starts a fresh one.",
};

/**
 * Thrown by `beginSavedCardChargeAttempt` when charging would be wrong: money
 * is already captured on a still-PENDING booking, or an unanswered attempt's key
 * has outlived Stripe's replay window (`why`). Thrown rather than returned so
 * the caller's claim transaction ROLLS BACK — which is precisely "release the
 * claim": the PENDING -> CONFIRMED claim, the bed reconcile and the hosting
 * enqueue all unwind, and no charge is attempted. Callers catch it by type, log
 * at error level and alert an administrator; the message is plain English
 * because it is what the alert and the admin response say. Either state is
 * transient when a webhook is merely late (a redelivered
 * `payment_intent.succeeded` settles the booking — through the row it finds by
 * intent id, or the one it adopts by the event's idempotency key) and permanent
 * when a person has to look; either way charging on top of it is the one thing
 * that must not happen.
 */
export class SavedCardChargeRefusedError extends Error {
  readonly why: SavedCardChargeRefusal;
  readonly bookingId: string;
  readonly paymentIntentId: string | null;
  readonly attemptRowId: string | null;
  /**
   * When the refused state began, read off the ledger row that witnesses it:
   * the captured row's last write for `captured_primary_exists`, the moment the
   * key left Stripe's replay window for `attempt_key_expired`. The cron anchors
   * its admin-alert cadence on this (`shouldAlertOnSavedCardChargeRefusal`),
   * so a state that arises between runs is alerted on at the very next run and
   * then on the capped cadence, rather than on every run for ever.
   */
  readonly since: Date;

  constructor(params: {
    why: SavedCardChargeRefusal;
    bookingId: string;
    since: Date;
    paymentIntentId?: string | null;
    attemptRowId?: string | null;
  }) {
    const paymentIntentId = params.paymentIntentId ?? null;
    super(REFUSAL_MESSAGES[params.why]({ paymentIntentId }));
    this.name = "SavedCardChargeRefusedError";
    this.why = params.why;
    this.bookingId = params.bookingId;
    this.paymentIntentId = paymentIntentId;
    this.attemptRowId = params.attemptRowId ?? null;
    this.since = params.since;
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
  updatedAt: Date;
};

/**
 * The statuses under which an attempt is still open — Stripe has not given a
 * final answer, or has not been asked with certainty. Every status guard in this
 * module and in `saved-card-charge-settle.ts` is written against this one list
 * (`INV-SSOT-002`), so a guard cannot quietly accept a status the other refuses.
 */
export const UNRESOLVED_ATTEMPT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
];

function isUnresolved(status: PaymentStatus): boolean {
  return UNRESOLVED_ATTEMPT_STATUSES.includes(status);
}

/** An attempt row is one whose `reference` is the key minted from its OWN id. */
function isAttemptRow(row: AttemptLedgerRow, bookingId: string): boolean {
  return row.reference === savedCardChargeIdempotencyKey(bookingId, row.id);
}

/**
 * A PRIMARY Stripe row that is NOT an attempt row but is this booking's money
 * in flight ON THE CARD ABOUT TO BE CHARGED: a saved-card row minted under the
 * shared key before #3267 (reason set, no `reference`), or a /pay link intent
 * the member is paying with the same saved card. It names an intent (every such
 * row was written from a Stripe answer), so it is replayed by RETRIEVE — never
 * by re-sending a key it does not have. Without this, a legacy `processing`
 * intent at deploy time would be swept like a link intent, found uncancellable,
 * and charged beside (#3267 fix round).
 */
function isChargeInFlightOnThisCard(
  row: AttemptLedgerRow,
  card: Pick<SavedCardToCharge, "stripePaymentMethodId">
): boolean {
  return (
    row.stripePaymentIntentId !== null &&
    row.paymentMethodId === card.stripePaymentMethodId
  );
}

/** `<reason>:<suffix>`, applied once — a row ended twice reads the same. */
function supersededReason(reason: string | null, suffix: string): string {
  const base = reason ?? "saved_card_charge";
  return base.endsWith(`:${suffix}`) ? base : `${base}:${suffix}`;
}

/**
 * Decide, under the caller's locks, what this charge attempt is — then make it
 * durable before Stripe is asked anything.
 *
 * MUST run inside the caller's claim transaction: global `lock(1)`, then the
 * lodge capacity lock, after the status-guarded PENDING -> CONFIRMED claim and
 * with the `Payment` row that yields `paymentId` already written. The type
 * cannot enforce that (a `PrismaClient` is assignable to
 * `Prisma.TransactionClient`); the callers' lock sites are registered in
 * `advisory-lock-guard.test.ts` (`INV-LOCK-003`) and the per-caller tests pin
 * the ordering. Every write here is status-guarded so a replayed transaction
 * cannot regress a row another writer has since moved.
 *
 * In order:
 *
 *   a. Load this payment's PRIMARY Stripe rows.
 *   b. A row still holding net captured cash (`isCapturedTransactionStatus`
 *      minus the fully refunded, which is #1765 history a repay may
 *      legitimately follow) means money is already taken while the booking is
 *      still PENDING: THROW `SavedCardChargeRefusedError`
 *      (`captured_primary_exists`). Never charge on top of it. Every PRIMARY
 *      Stripe row counts here, attempt row or not.
 *   c. An unresolved (PENDING/PROCESSING) ATTEMPT row on the SAME card — or
 *      with no card and no intent, the shape #3268's retire leaves when it nulls
 *      the pm off a row whose first POST never answered — is REPLAYED, as is
 *      any other unresolved PRIMARY Stripe row with an intent on the same card
 *      (`isChargeInFlightOnThisCard`). The newest such row is the attempt; any
 *      older one is a duplicate and is ended (defensive: the locks make two
 *      live attempts unreachable). A replay whose first POST never answered
 *      (PENDING, no intent) and whose row is older than
 *      `SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS` is NOT re-sent: THROW
 *      `SavedCardChargeRefusedError` (`attempt_key_expired`) — see the module
 *      docblock for why re-sending is a new charge.
 *   d. An unresolved ATTEMPT row on a DIFFERENT card (the previous card was
 *      retired by #3268 or replaced via #3266), or whose card was nulled but
 *      whose intent still exists, is ENDED: marked FAILED with its `reason`
 *      suffixed `:superseded_by_new_card`, and its intent id, if any, is
 *      returned for `chargeSavedCardAttempt` to cancel best-effort AFTER commit
 *      (a provider call kept out of the transaction — `INV-INT-003`). Marking it
 *      FAILED before Stripe has confirmed the cancel is deliberate and repaired
 *      in three places if it turns out to be wrong: `chargeSavedCardAttempt`
 *      treats an intent the cancel finds already `succeeded` as THE capture and
 *      charges nothing; one it finds still `processing` is put back to
 *      PROCESSING on its row and waited on, so the next run ends and asks about
 *      it again rather than charging beside it; and a `payment_intent.succeeded`
 *      webhook for it moves the row to SUCCEEDED
 *      (`markPaymentIntentTransactionSucceeded` does not guard on FAILED). If it
 *      captures after this attempt has captured too, the #1992
 *      duplicate-capture auto-refund hands the second capture back
 *      (`INV-PAY-043`).
 *   e. Otherwise create the attempt row (PENDING, this card, this path's reason)
 *      and stamp its `reference` with the key built from ITS OWN id — two
 *      statements, one transaction.
 *
 * Rows that are neither attempt rows nor in flight on this card (a link intent
 * on another card, a legacy row on a since-replaced card) are read for (b) and
 * otherwise left alone — see the module docblock.
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
  const now = new Date();

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
      updatedAt: true,
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
      why: "captured_primary_exists",
      bookingId,
      since: captured.updatedAt,
      paymentIntentId: captured.stripePaymentIntentId,
    });
  }

  const unresolvedAttempts = rows.filter(
    (row) =>
      isUnresolved(row.status) &&
      (isAttemptRow(row, bookingId) || isChargeInFlightOnThisCard(row, card))
  );
  const replayable = unresolvedAttempts.filter(
    (row) =>
      row.paymentMethodId === card.stripePaymentMethodId ||
      (row.paymentMethodId === null && row.stripePaymentIntentId === null)
  );
  // Oldest-first read, so the LAST replayable row is the newest: THE attempt.
  const replay = replayable.length > 0 ? replayable[replayable.length - 1]! : null;

  // (c) A key can only be re-sent inside Stripe's replay window.
  if (
    replay &&
    replay.stripePaymentIntentId === null &&
    now.getTime() - replay.createdAt.getTime() >
      SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS
  ) {
    throw new SavedCardChargeRefusedError({
      why: "attempt_key_expired",
      bookingId,
      since: new Date(
        replay.createdAt.getTime() + SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS
      ),
      attemptRowId: replay.id,
    });
  }

  const staleIntentIdsToCancel: string[] = [];
  for (const row of unresolvedAttempts) {
    if (row === replay) continue;
    const suffix = replayable.includes(row)
      ? "superseded_duplicate_attempt"
      : "superseded_by_new_card";
    // Status-guarded: a webhook that has since settled or failed this row wins.
    const ended = await tx.paymentTransaction.updateMany({
      where: { id: row.id, status: { in: [...UNRESOLVED_ATTEMPT_STATUSES] } },
      data: {
        status: PaymentStatus.FAILED,
        reason: supersededReason(row.reason, suffix),
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
      // Equal to `replay.reference` for an attempt row (by `isAttemptRow`);
      // rebuilt so the type is honest without a null-coalesce. For a legacy row
      // it is a key nothing ever sent — and nothing will: a replay that names
      // its intent retrieves it and never sends a key.
      idempotencyKey: savedCardChargeIdempotencyKey(bookingId, replay.id),
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
export async function failSavedCardChargeAttempt(
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
