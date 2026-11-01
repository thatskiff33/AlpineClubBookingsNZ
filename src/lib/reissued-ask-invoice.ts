/**
 * #3954 DECISION A (owner, 9 Oct 2026, "Raise a $30 invoice"): A PRICE
 * REDUCTION'S SMALLER RE-ISSUED ASK GETS ITS OWN SUPPLEMENTARY XERO INVOICE.
 *
 * The reduction retired the increase's parked invoice with the ask it waited
 * on (`retireUnpaidAskChain`) and recorded, on its own history row, what the
 * smaller ask's invoice bills (`recordedReissuedAskInvoiceCents`: the retired
 * invoices' money less the offset, never more than the ask). Once that ask is
 * minted - by the door after commit or by its recovery's replay - its invoice
 * is queued on the reducing edit, parked `WAITING_PAYMENT` on the minted
 * intent and recording the payment when it is captured, exactly as an
 * ordinary increase's invoice waits for its intent. Xero then matches what
 * the member is asked to pay.
 *
 * Best-effort, like every after-commit Xero leg: a failure is logged, and the
 * booking-vs-Xero repair pass reports the reduction's missing invoice. The
 * enqueue's one-invoice-per-anchor lock makes a second call (door and replay
 * both reaching here) queue nothing.
 *
 * ONLY ON A LIVE ASK (review round 7). The door queues after its Stripe
 * cancels, which can take a while, and a later reduction may have retired the
 * intent it just minted in that time - accounting for this money in its own
 * history, and naming this edit there (round 8). So the intent's row is
 * re-read first (`isMintedAskStillLive`). Round 8: only a row RETIRED since -
 * withdrawn, or cancelled (superseded, or at Stripe; #4052: not a declined
 * card, which the member can still pay) - is not live. A row the member already paid is live
 * (its invoice is queued and released as paid), and so is one the re-read
 * could not see, or a re-read that failed: an invoice parked on an intent that
 * did die is retired with it by the stale-wait reaper, while one not queued
 * for a live ask is money Xero never bills. A retired ask queues nothing, and
 * the door withholds its client secret - never the intent's id, which the
 * edit's Xero leg still needs to park the increase's own invoice rather than
 * raise it unpaid.
 */
import { PaymentStatus } from "@prisma/client";

import { readOpenProviderIntent } from "@/lib/additional-payment-chase";
import logger from "@/lib/logger";
import { SUPERSEDED_ASK_TRANSACTION_REASON } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { intentCancellationQueuedWhere } from "@/lib/queued-intent-cancellation";
import { getPaymentIntent } from "@/lib/stripe";
import {
  recordedFoldedReissuedAskModificationIds,
  recordedReissuedAskInvoiceCents,
} from "@/lib/unpaid-ask-offset-marker";
import { enqueueXeroSupplementaryInvoiceOperation } from "@/lib/xero-operation-outbox";

/**
 * Whether a just-minted ask is still live: not retired since. Paid counts as
 * live; so does a row not found, and so does a DECLINED card (#4052): a
 * declined attempt marks the row FAILED and nothing more
 * (`markPaymentIntentTransactionFailed`), and the member can still pay that
 * intent with another card. Retired is only:
 *  - `withdrawnAt` (a reduction, an officer's withdrawal, a credit-release close);
 *  - FAILED with a queued Stripe cancellation (a supersede, a booking's end -
 *    `intentCancellationQueuedWhere`);
 *  - FAILED with the cancel processor's supersede stamp
 *    (`SUPERSEDED_ASK_TRANSACTION_REASON`);
 *  - FAILED with none of those, and Stripe reports the intent cancelled or gone
 *    (`readOpenProviderIntent`, the pay door's own read): a cancel made at
 *    Stripe itself, which `handlePaymentIntentCanceled` records as FAILED
 *    alone, exactly as a decline. That writer leaves no mark of its own on
 *    purpose: the row's `reason` names the ask, and the billing evidence, the
 *    reminder cadence and the review-charge reads key on it.
 * A Stripe read that fails throws; the caller reads that as live.
 */
export async function isMintedAskStillLive(paymentIntentId: string): Promise<boolean> {
  const row = await prisma.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { status: true, withdrawnAt: true, reason: true },
  });
  if (!row) return true;
  if (row.withdrawnAt) return false;
  if (row.status !== PaymentStatus.FAILED) return true;
  if (row.reason === SUPERSEDED_ASK_TRANSACTION_REASON) return false;
  const queuedCancel = await prisma.paymentRecoveryOperation.findFirst({
    where: intentCancellationQueuedWhere([paymentIntentId]),
    select: { id: true },
  });
  if (queuedCancel) return false;
  const open = await readOpenProviderIntent(paymentIntentId, (id) => getPaymentIntent(id, { timeoutMs: STRIPE_READ_TIMEOUT_MS }));
  return open !== null;
}

/** The liveness re-read's Stripe read gives up quickly; a failed read is read as live. */
const STRIPE_READ_TIMEOUT_MS = 10_000;

/**
 * Queue the reduction's re-issue invoice on its minted intent. Returns whether
 * that intent is still the live ask (false: nothing queued, offer no secret).
 */
export async function queueReissuedAskSupplementaryInvoice(call: {
  bookingId: string;
  /** The REDUCING edit, whose history records the figure and which anchors the invoice. */
  bookingModificationId: string;
  /** The re-issued ask's minted intent, which releases the invoice when captured. */
  paymentIntentId: string;
}): Promise<boolean> {
  if (!(await askStillLive(call.bookingId, call.paymentIntentId))) return false;
  await queueReissuedAskInvoice(call);
  return true;
}

async function askStillLive(bookingId: string, paymentIntentId: string): Promise<boolean> {
  try {
    if (await isMintedAskStillLive(paymentIntentId)) return true;
    logger.warn(
      { bookingId, paymentIntentId },
      "A just-minted additional payment request was retired before its invoice was queued (#3954); no invoice queued and no client secret offered",
    );
    return false;
  } catch (err) {
    // Round 8: a failed re-read is read as live - a missing invoice for a live
    // ask is the worse failure, and the reaper retires one parked on a dead ask.
    logger.error(
      { err, bookingId, paymentIntentId },
      "Could not re-read a just-minted additional payment request (#3954); read as still live, so its invoice is queued",
    );
    return true;
  }
}

async function queueReissuedAskInvoice({
  bookingId,
  bookingModificationId,
  paymentIntentId,
}: {
  bookingId: string;
  bookingModificationId: string;
  paymentIntentId: string;
}): Promise<void> {
  try {
    const modification = await prisma.bookingModification.findUnique({
      where: { id: bookingModificationId },
      select: { newData: true },
    });
    const invoiceCents = recordedReissuedAskInvoiceCents(modification?.newData);
    if (invoiceCents <= 0) return;
    await enqueueXeroSupplementaryInvoiceOperation(
      { bookingId, priceDiffCents: invoiceCents, changeFeeCents: 0, bookingModificationId },
      { paymentIntentId, waitForConfirmedAdditionalPayment: true, recordPayment: true },
    );
  } catch (err) {
    logger.error(
      { err, bookingId, bookingModificationId, paymentIntentId },
      "Failed to queue the supplementary Xero invoice for a re-issued additional ask (#3954); the booking-vs-Xero repair pass reports it",
    );
  }
}

/**
 * #3954 review round 6: THE RE-ISSUES AN INCREASE FOLDED IN KEEP THEIR OWN
 * INVOICES. A later increase that folded a waiting re-issue into its own ask
 * (`foldWaitingReissuedAsks`) closed that re-issue's recovery, so the
 * re-issue's own mint - which queues its decision-A invoice - never runs. Once
 * the increase's ask is minted, by its door or its recovery's replay, each
 * folded reduction's invoice is queued here instead, anchored on that
 * reduction as before and waiting on the INCREASE's intent, which now asks for
 * that money. The per-anchor lock keeps a second call (door and replay) to one.
 * Returns whether the increase's intent is still the live ask (round 7).
 */
export async function queueFoldedReissuedAskInvoices({
  bookingId,
  increaseModificationId,
  paymentIntentId,
}: {
  bookingId: string;
  /** The increase whose history records what it folded in. */
  increaseModificationId: string;
  /** Its minted intent, which collects the folded re-issues' money. */
  paymentIntentId: string;
}): Promise<boolean> {
  if (!(await askStillLive(bookingId, paymentIntentId))) return false;
  let folded: string[];
  try {
    const increase = await prisma.bookingModification.findUnique({
      where: { id: increaseModificationId },
      select: { newData: true },
    });
    folded = recordedFoldedReissuedAskModificationIds(increase?.newData);
  } catch (err) {
    logger.error(
      { err, bookingId, increaseModificationId, paymentIntentId },
      "Failed to read the re-issues an increase folded in (#3954); the booking-vs-Xero repair pass reports their invoices",
    );
    return true;
  }
  for (const bookingModificationId of folded) {
    await queueReissuedAskInvoice({ bookingId, bookingModificationId, paymentIntentId });
  }
  return true;
}
