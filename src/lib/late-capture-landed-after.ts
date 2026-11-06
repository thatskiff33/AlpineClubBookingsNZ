import type { Prisma } from "@prisma/client";
import { isLateCaptureHandlerWrite } from "@/lib/cancellation-settled-money";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { prisma } from "@/lib/prisma";
import { intentCancellationQueuedWhere } from "@/lib/queued-intent-cancellation";

/**
 * The durable evidence that a capture on a cancelled booking landed AFTER the
 * cancel (`CapturedRowOnCancelledBooking.capturedAfterCancellation`): the
 * primary late-capture handler's own `CANCELLED_BOOKING_LATE_CAPTURE_REASON`
 * write, or a `CANCEL_PAYMENT_INTENT` recovery for the intent - the cancel's
 * claim, or any superseded-intent writer, recording that the intent must not
 * capture. One rule for the notice's verdict (#3639), the lost-record recovery
 * and its nightly list (#4149), and `charge.refunded` and the note-eligible
 * cash (#4170). Nothing is caught: a read that cannot answer answers neither way.
 */
export async function readCaptureLandedAfterCancellation(
  capture: { paymentIntentId: string; reason: string | null },
  store: Pick<Prisma.TransactionClient, "paymentRecoveryOperation"> = prisma,
): Promise<boolean> {
  if (isLateCaptureHandlerWrite(capture.reason)) return true;
  const cancelIntentOperation = await store.paymentRecoveryOperation.findFirst({
    where: intentCancellationQueuedWhere([capture.paymentIntentId]),
    select: { id: true },
  });
  return cancelIntentOperation !== null;
}

/** The same rule for many captures at once: the intents among these that landed after the cancel. */
export async function findCapturesLandedAfterCancellation(
  paymentIntentIds: readonly string[],
  store: Pick<Prisma.TransactionClient, "paymentTransaction" | "paymentRecoveryOperation"> = prisma,
): Promise<Set<string>> {
  const ids = [...new Set(paymentIntentIds)];
  const landed = new Set<string>();
  if (ids.length === 0) return landed;
  const rows = await store.paymentTransaction.findMany({
    where: { stripePaymentIntentId: { in: ids } },
    // The ledger's order (#4132, INV-PAY-133), though only membership is read.
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: { stripePaymentIntentId: true, reason: true },
  });
  for (const row of rows ?? []) {
    if (row.stripePaymentIntentId && isLateCaptureHandlerWrite(row.reason)) landed.add(row.stripePaymentIntentId);
  }
  const unmarked = ids.filter((id) => !landed.has(id));
  if (unmarked.length === 0) return landed;
  const claims = await store.paymentRecoveryOperation.findMany({
    where: intentCancellationQueuedWhere(unmarked),
    select: { paymentIntentId: true },
  });
  for (const claim of claims ?? []) landed.add(claim.paymentIntentId);
  return landed;
}
