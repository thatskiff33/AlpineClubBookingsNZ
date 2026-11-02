/**
 * #4036: MINT AN ORDINARY EDIT'S PRICE ASK FROM ITS ONE PLANNED REQUEST
 * (`planOrdinaryAskMint`), for the edit's door and the recovery runner alike.
 *
 * The runner's replay is normally answered by Stripe with the intent the door's
 * lost reply minted. A refusal (`idempotency_error`) still comes back when the
 * earlier request differed after all: the stored customer changed between the
 * two, the club's charge currency changed, or the earlier request came from a
 * release that sent other parameters. Stripe cannot look an intent up by its
 * key, and the door's intent carries no key in its metadata (stamping one would
 * make every row the previous release wrote differ again), so the runner finds
 * it by what it asks for: the one recent intent that is this booking's ask, by
 * this door's reason, for this amount in this currency, unpaid, and on no
 * ledger row (`isIntentForOrdinaryAskPlan`). None, or more than one, and the
 * refusal is thrown as it was: the recovery backs off and retries, and on
 * exhaustion alerts an officer. It never guesses which of two intents is owed.
 *
 * #4036 review: matching by what an ask asks for can find an intent some other
 * request minted - another edit's door under the same reason, say - so
 * adoption also fails closed when it cannot be sure the match is this ask's
 * alone:
 *
 * - the scan stopped at its bound with intents unread (`complete` false), so a
 *   second match may be among them;
 * - another additional-ask recovery row of the booking still in flight
 *   (`isPaymentRecoveryOperationInFlight`, a FAILED row with a retry scheduled
 *   included) could own the match (`couldRecoveryRowOwnIntent`) - two edits
 *   must never record one intent.
 *
 * And an intent created after the recovery row (beyond
 * `DOOR_INTENT_CLOCK_SKEW_MS`) is never a match: it is a later door's mint, a
 * lost-claim runner's or a currency re-issue's. #4079: nor is one under the
 * runner's own reason, and the scan reads nothing created after that bound.
 *
 * And the caller is told it adopted (`adopted`), so the runner confirms, under
 * its claim, that no ledger row took the intent meanwhile before writing its own.
 */
import { PaymentRecoveryOperationType, type Prisma } from "@prisma/client";
import type Stripe from "stripe";

import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import {
  ASK_RECOVERY_METADATA_KEY,
  couldRecoveryRowOwnIntent,
  isIntentForOrdinaryAskPlan,
  latestAdoptableIntentCreatedAt,
  ORDINARY_ASK_RECOVERY_REASON,
  type OrdinaryAskMintPlan,
} from "@/lib/ordinary-ask-request";
import {
  ABANDONED_INTENT_STRIPE_TIMEOUT_MS,
  isPaymentRecoveryOperationInFlight,
  PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE,
} from "@/lib/payment-recovery-constants";
import { prisma } from "@/lib/prisma";
import { MINTED_INTENT_LOOKBACK_MS } from "@/lib/reissued-ask-mint";
import { createPaymentIntent, listRecentPaymentIntentsMatching, stampPaymentIntentMetadata } from "@/lib/stripe";
import { stripeChargeCurrency } from "@/lib/stripe-charge-currency";
import { stripeErrorApiType } from "@/lib/stripe-errors";

/**
 * The intent an ordinary ask's mint answers with. `adopted` is true only when
 * Stripe refused the key and the intent was found by what the ask asks for -
 * never for the key's own intent.
 */
export type OrdinaryAskMint = { intent: Stripe.PaymentIntent; adopted: boolean };

export async function mintOrdinaryAskIntent({
  format,
  plan,
  customerId,
  recovery,
}: {
  format: ClubFormat;
  plan: OrdinaryAskMintPlan;
  customerId: string | undefined;
  /**
   * The recovery row this mint replays, or null for the door's own first mint,
   * which no earlier request can have preceded: its refusal is thrown, and the
   * door keeps the debt on a recovery row as it does for any failure.
   */
  recovery: { id: string; createdAt: Date } | null;
}): Promise<OrdinaryAskMint> {
  let intent: Stripe.PaymentIntent;
  try {
    intent = await createPaymentIntent({
      format,
      amountCents: plan.amountCents,
      customerId,
      metadata: { ...plan.metadata },
      idempotencyKey: plan.idempotencyKey,
    });
  } catch (err) {
    if (!recovery || stripeErrorApiType(err) !== "idempotency_error") throw err;
    const minted = await findIntentMintedForOrdinaryAsk({ format, plan, customerId, recovery });
    if (!minted) throw err;
    logger.warn(
      { paymentIntentId: minted.id, idempotencyKey: plan.idempotencyKey, bookingId: plan.bookingId },
      "An ordinary additional ask's key had already minted an intent under other parameters; using that intent (#4036)",
    );
    return { intent: minted, adopted: true };
  }
  if (recovery) await stampRecoveryOnIntent(intent.id, recovery.id, plan.bookingId);
  return { intent, adopted: false };
}

/**
 * #4693 (`INV-PAY-120`): the runner's own intent - minted, or handed back, under
 * this row's key; never an adopted one - is stamped with the row's id
 * (`ASK_RECOVERY_METADATA_KEY`) before any claim hold runs, so a later close
 * can find it if a hold that throws, loses or never runs leaves it unwritten.
 * Best-effort, by an update outside every transaction: a failed stamp only
 * leaves the intent as unstamped intents always were, so the ask goes on.
 */
async function stampRecoveryOnIntent(paymentIntentId: string, operationId: string, bookingId: string): Promise<void> {
  try {
    await stampPaymentIntentMetadata(paymentIntentId, { [ASK_RECOVERY_METADATA_KEY]: operationId }, { timeoutMs: ABANDONED_INTENT_STRIPE_TIMEOUT_MS });
  } catch (err) {
    logger.warn(
      { err, paymentIntentId, operationId, bookingId },
      "Could not stamp the recovery on an ordinary additional ask's intent; a close-time sweep will not find it if it is left unwritten (#4693)",
    );
  }
}

/**
 * #4036 review: run by the recovery runner inside its claim-held write, before
 * it records the intent. An ADOPTED intent was found by what it asks for, not
 * by this row's key, so another ask may have recorded it since the lookup.
 * That row is never written over: this throws, the claim's write rolls back,
 * and the retry's lookup finds no unrecorded match and fails closed.
 *
 * The ask write itself refuses a row naming ANOTHER EDIT, atomically
 * (`writePaymentIntentTransaction`, `payment-intent-ledger-row-write.ts`); this check
 * is what still refuses an adopted intent whose row names NO edit - a review
 * charge's, a webhook's, or one written before rows named their edit - which
 * that write would claim, as it must for the key's own intent.
 */
export async function refuseAdoptedIntentOnLedger(
  store: Prisma.TransactionClient,
  { intent, adopted }: OrdinaryAskMint,
): Promise<void> {
  if (!adopted) return;
  const recorded = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: intent.id },
    select: { id: true },
  });
  if (recorded) {
    throw new Error(`Adopted PaymentIntent ${intent.id} is already on another ask's ledger row; not recording it twice (#4036)`);
  }
}

function failClosed(plan: OrdinaryAskMintPlan, detail: Record<string, unknown>, message: string): null {
  logger.error({ bookingId: plan.bookingId, idempotencyKey: plan.idempotencyKey, ...detail }, message);
  return null;
}

async function findIntentMintedForOrdinaryAsk({
  format,
  plan,
  customerId,
  recovery,
}: {
  format: ClubFormat;
  plan: OrdinaryAskMintPlan;
  customerId: string | undefined;
  recovery: { id: string; createdAt: Date };
}): Promise<Stripe.PaymentIntent | null> {
  // #4079: a plan whose key names no door sends the runner's reason, which
  // `isIntentForOrdinaryAskPlan` never matches, so there is nothing to scan for.
  if (plan.metadata.reason === ORDINARY_ASK_RECOVERY_REASON) return null;
  const currency = stripeChargeCurrency(format);
  const scan = await listRecentPaymentIntentsMatching({
    matches: (intent) => isIntentForOrdinaryAskPlan(intent, plan, currency, recovery),
    createdSince: new Date(recovery.createdAt.getTime() - MINTED_INTENT_LOOKBACK_MS),
    // #4079: nothing created after the row could match, so none of it is read.
    createdUntil: latestAdoptableIntentCreatedAt(recovery.createdAt),
    customerId,
  });
  if (!scan.complete) {
    return failClosed(
      plan,
      { candidateIntentIds: scan.intents.map((intent) => intent.id) },
      "An ordinary additional ask's key was refused and the scan for its intent stopped before reading every recent intent; failing closed rather than guess (#4036)",
    );
  }
  const candidates = scan.intents;
  if (candidates.length === 0) return null;
  // An intent already on the ledger is some other ask's, never this one: the
  // replay runs only because this ask's mint wrote no row.
  const recorded = await prisma.paymentTransaction.findMany({
    where: { stripePaymentIntentId: { in: candidates.map((intent) => intent.id) } },
    select: { stripePaymentIntentId: true },
  });
  const recordedIds = new Set(recorded.map((row) => row.stripePaymentIntentId));
  const unrecorded = candidates.filter((intent) => !recordedIds.has(intent.id));
  if (unrecorded.length !== 1) {
    return failClosed(
      plan,
      { candidateIntentIds: unrecorded.map((intent) => intent.id) },
      unrecorded.length === 0
        ? "An ordinary additional ask's key was refused and every matching intent is already another ask's; failing closed (#4036)"
        : "An ordinary additional ask's key was refused and more than one unrecorded intent matches it; failing closed rather than guess (#4036)",
    );
  }
  const match = unrecorded[0]!;
  // Another edit's unfinished recovery could be the one that minted it: two
  // edits must never record one intent, so neither adopts it.
  // In flight includes a FAILED row with a retry still scheduled: it will run again.
  const others = await prisma.paymentRecoveryOperation.findMany({
    where: {
      bookingId: plan.bookingId,
      type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
      id: { not: recovery.id },
      ...PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE,
    },
    select: {
      id: true, bookingId: true, idempotencyKey: true, paymentIntentId: true, amountCents: true,
      status: true, attempts: true, nextRetryAt: true,
    },
  });
  const rivals = others.filter((row) => isPaymentRecoveryOperationInFlight(row) && couldRecoveryRowOwnIntent(row, match));
  if (rivals.length > 0) {
    return failClosed(
      plan,
      { paymentIntentId: match.id, rivalOperationIds: rivals.map((row) => row.id) },
      "An ordinary additional ask's key was refused and its one matching intent could be another edit's unfinished ask; failing closed rather than guess (#4036)",
    );
  }
  return match;
}
