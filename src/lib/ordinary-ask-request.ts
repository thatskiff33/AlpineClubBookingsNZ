/**
 * #4036: AN ORDINARY EDIT'S PRICE ASK IS ONE STRIPE REQUEST, WHICHEVER OF ITS
 * TWO MINTERS SENDS IT.
 *
 * A price increase is asked for by the edit's door after commit
 * (`createModificationAdditionalPaymentIntent`). If that mint fails, or its
 * reply is lost after Stripe accepted it, the recovery runner replays it later
 * under the door's own key (`processCreateAdditionalPaymentIntentOperation`).
 * Stripe answers a key replayed with DIFFERENT parameters with
 * `idempotency_error`, so a replay that differs by one byte never mints, and
 * the member is never asked for the increase.
 *
 * The runner used to send its own reason (`modification_additional_recovery`)
 * where the door sent its own (`guest_add_price_increase`, ...), and the door
 * named the Stripe customer without the booking's organisation. So the request
 * is planned here and nowhere else (`planOrdinaryAskMint`):
 *
 * - the KEY - the door's, frozen on the recovery row; or, when the replay's
 *   re-derived amount moved, that key naming the amount
 *   (`stripeIdempotencyKeyForAskAmount`), which is a different request;
 * - the METADATA, and in it the REASON - the door's reason, named BY THE KEY
 *   (`ordinaryAskReasonForStripeKey`). The key is what the recovery row already
 *   stores, so the runner needs no new column to send the door's reason, and a
 *   row the previous release's door wrote replays with the reason that door
 *   sent - the precedent is the modification refund, whose recovery rebuilds
 *   its reason from the stored key prefix (#1507);
 * - the CUSTOMER is not in the plan but resolved one way by both
 *   (`resolveAskCustomerId`, from `reissued-ask-mint.ts`).
 *
 * The ledger row's own `reason` is NOT part of the Stripe request and is left
 * as it was: the door's for the door's row, `ORDINARY_ASK_RECOVERY_REASON` for
 * the runner's.
 *
 * A refusal that still comes back is answered in `ordinary-ask-mint.ts`. The
 * rule is `INV-MOD-003`.
 */
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  buildReissuedAskStripeIdempotencyKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
  stripeIdempotencyKeyForAskAmount,
} from "@/lib/payment-recovery-keys";
import {
  isCreditReleaseAskRecoveryKey,
} from "@/lib/credit-release-ask-keys";
import { staleIntentAction } from "@/lib/stale-intent-action";
import type { AppPaymentIntentMetadata } from "@/lib/stripe-app-intent-metadata";

/** The Stripe metadata `type` every additional ask's intent carries. */
export const ADDITIONAL_ASK_INTENT_TYPE = "modification_additional";

/**
 * The reason the recovery runner writes on the ledger row it records, and the
 * Stripe metadata reason it sent before #4036. A request whose key names no
 * door below still sends it, from both minters alike. A refused replay never
 * adopts an intent carrying it (#4079, `isIntentForOrdinaryAskPlan`).
 */
export const ORDINARY_ASK_RECOVERY_REASON = "modification_additional_recovery";

/**
 * Every door that asks for an ordinary edit's price increase: the prefix of its
 * Stripe key and the reason its request and ledger row carry. The spellings are
 * the ones each door has always sent, so a row the previous release wrote
 * replays under the same parameters.
 */
const ORDINARY_ASK_DOORS = {
  guestAdd: { keyPrefix: "mod_guest", reason: "guest_add_price_increase" },
  guestRemoval: { keyPrefix: "mod_guest_remove", reason: "guest_removal_price_increase" },
  dateChange: { keyPrefix: "mod_dates", reason: "date_change_price_increase" },
  batchModify: { keyPrefix: "mod_batch", reason: "batch_modify_price_increase" },
  guestConsentRemoval: { keyPrefix: "mod_guest_consent", reason: "guest_consent_removal_reissued_ask" },
  guestAcceptanceReprice: { keyPrefix: "guest_accept", reason: "guest_accepted_promo_reprice_reissued_ask" },
} as const;

export type OrdinaryAskDoor = keyof typeof ORDINARY_ASK_DOORS;

function ordinaryAskStripeKey(door: OrdinaryAskDoor, bookingId: string, bookingModificationId: string): string {
  return `${ORDINARY_ASK_DOORS[door].keyPrefix}_${bookingId}_${bookingModificationId}`;
}

/**
 * The door's request, derived from the door alone: its reason and its
 * edit-scoped Stripe key. The minter takes the door, never the two strings, so
 * a key and a reason from different doors cannot be written (#4036 review).
 */
export function ordinaryAskDoorRequest(
  door: OrdinaryAskDoor,
  bookingId: string,
  bookingModificationId: string,
): { reason: string; idempotencyKey: string } {
  return {
    reason: ORDINARY_ASK_DOORS[door].reason,
    idempotencyKey: ordinaryAskStripeKey(door, bookingId, bookingModificationId),
  };
}

/**
 * The door whose key `stripeKey` is, matched by rebuilding each door's key for
 * this booking and edit - exact equality, never a prefix slice - else null.
 */
function ordinaryAskDoorForStripeKey(
  stripeKey: string,
  bookingId: string,
  bookingModificationId: string | null,
): OrdinaryAskDoor | null {
  if (!bookingModificationId) return null;
  for (const door of Object.keys(ORDINARY_ASK_DOORS) as OrdinaryAskDoor[]) {
    if (ordinaryAskStripeKey(door, bookingId, bookingModificationId) === stripeKey) return door;
  }
  return null;
}

/**
 * The reason a request under `stripeKey` carries: the door whose key it is,
 * else `ORDINARY_ASK_RECOVERY_REASON`.
 */
export function ordinaryAskReasonForStripeKey(
  stripeKey: string,
  bookingId: string,
  bookingModificationId: string | null,
): string {
  const door = ordinaryAskDoorForStripeKey(stripeKey, bookingId, bookingModificationId);
  return door ? ORDINARY_ASK_DOORS[door].reason : ORDINARY_ASK_RECOVERY_REASON;
}

export type OrdinaryAskMintPlan = {
  readonly bookingId: string;
  readonly amountCents: number;
  readonly idempotencyKey: string;
  readonly metadata: AppPaymentIntentMetadata;
};

/** The one request both minters of an ordinary edit's price ask send. */
export function planOrdinaryAskMint({
  bookingId,
  bookingModificationId,
  stripeKey,
  frozenAmountCents,
  amountCents,
}: {
  bookingId: string;
  /** The edit the ask is for; null only for a recovery row whose key names none. */
  bookingModificationId: string | null;
  /** The door's key: the door's own, or the one frozen on its recovery row. */
  stripeKey: string;
  /** The figure the door asked for, frozen on the recovery row. */
  frozenAmountCents: number;
  /** The figure this mint asks for: the door's, or the replay's re-derivation. */
  amountCents: number;
}): OrdinaryAskMintPlan {
  return {
    bookingId,
    amountCents,
    idempotencyKey:
      amountCents === frozenAmountCents
        ? stripeKey
        : stripeIdempotencyKeyForAskAmount(stripeKey, amountCents),
    // The order the door has always sent, so an old row's replay matches it.
    metadata: {
      bookingId,
      type: ADDITIONAL_ASK_INTENT_TYPE,
      reason: ordinaryAskReasonForStripeKey(stripeKey, bookingId, bookingModificationId),
    },
  };
}

/**
 * #4036 review: how far after its recovery row's creation an intent under a
 * door's reason may have been created and still be that door's. Allows for the
 * clock difference between Stripe and the database, and nothing more.
 */
export const DOOR_INTENT_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Whether `intent` is the ask `plan` describes, minted by an earlier request
 * under its key with other parameters: this booking, an additional ask, this
 * door's reason, this amount in this currency, and still unpaid
 * (`staleIntentAction`'s `reissue`, the one unpaid reading). The customer is
 * deliberately not compared - a different one is one way the earlier request
 * differed. Whether the intent is already on the ledger, and whether it is the
 * only one, is `mintOrdinaryAskIntent`'s to ask.
 *
 * #4036 review: the intent must have been created by the time its recovery row
 * was (`DOOR_INTENT_CLOCK_SKEW_MS` allowed for), since the row is written only
 * once the door's own create has failed. A later one is another edit's door
 * minting now, not this ask's.
 *
 * #4079: an intent under `ORDINARY_ASK_RECOVERY_REASON` is never a match. Only
 * the pre-#4036 runner sent it for a door's key, and a deployment that ran
 * #4077 for a day has no such row left (one that upgrades straight past it ends
 * a leftover row through the dead-recovery path); a
 * plan whose key names no door sends it now, and its earlier request was a
 * runner's, after the row - a lost-claim runner's mint or a currency
 * re-issue's, which this match cannot tell apart, so that refusal fails closed.
 */
export function isIntentForOrdinaryAskPlan(
  intent: { amount: number; currency: string; status: string; created?: number; metadata?: Record<string, string> | null },
  plan: OrdinaryAskMintPlan,
  currency: string,
  recoveryCreatedAt: Date,
): boolean {
  const metadata = intent.metadata ?? {};
  return (
    metadata.bookingId === plan.bookingId &&
    metadata.type === ADDITIONAL_ASK_INTENT_TYPE &&
    metadata.reason === plan.metadata.reason &&
    metadata.reason !== ORDINARY_ASK_RECOVERY_REASON &&
    typeof intent.created === "number" &&
    intent.created * 1000 <= latestAdoptableIntentCreatedAt(recoveryCreatedAt).getTime() &&
    intent.amount === plan.amountCents &&
    intent.currency === currency &&
    staleIntentAction(intent) === "reissue"
  );
}

/**
 * The latest moment an intent this recovery row's refused replay may adopt was
 * created: the row's creation plus the clock skew. #4079: also the upper bound
 * of the replay's Stripe scan, so a busy account's later intents never fill it.
 */
export function latestAdoptableIntentCreatedAt(recoveryCreatedAt: Date): Date {
  return new Date(recoveryCreatedAt.getTime() + DOOR_INTENT_CLOCK_SKEW_MS);
}

/**
 * #4036 review: whether ANOTHER unfinished additional-ask recovery row of the
 * same booking could be the one that minted `intent` - so adopting it here
 * could hand one edit's intent to two. Its own intent, named on the row; or an
 * ordinary ask's request for the same amount whose reason the intent carries:
 * the row's door's (#4079: no longer the pre-#4036 runner's, whose rows are
 * gone). A row whose key names no door (rewritten to an intent id, say) could
 * have sent any reason. A review charge's and a re-issue's requests carry
 * reasons of their own (`INV-PAY-120`), so their rows never match.
 */
export function couldRecoveryRowOwnIntent(
  row: { bookingId: string; idempotencyKey: string; paymentIntentId: string; amountCents: number },
  intent: { id: string; amount: number; metadata?: Record<string, string> | null },
): boolean {
  if (row.paymentIntentId === intent.id) return true;
  const bookingModificationId = bookingModificationIdForAdditionalIntentRecoveryKey(row.idempotencyKey);
  if (
    // #4253: a credit-release request sends a reason of its own (`INV-ADDPAY-045`).
    isCreditReleaseAskRecoveryKey(row.idempotencyKey) ||
    isEditFinancialReviewAdditionalIntentRecoveryKey(row.idempotencyKey) ||
    (bookingModificationId && row.paymentIntentId === buildReissuedAskStripeIdempotencyKey(bookingModificationId))
  ) {
    return false;
  }
  if (intent.amount !== row.amountCents) return false;
  const reason = intent.metadata?.reason;
  const door = ordinaryAskDoorForStripeKey(row.paymentIntentId, row.bookingId, bookingModificationId);
  return door === null || ORDINARY_ASK_DOORS[door].reason === reason;
}
