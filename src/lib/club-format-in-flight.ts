import "server-only";

import {
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";

import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { prisma } from "@/lib/prisma";

/**
 * The card payments a currency change would catch mid-flight (owner decision D2
 * on #3567). Card charges follow the club's stored currency (D1), so the
 * currency-change confirmation counts what is already under way before a Full
 * Admin saves: it WARNS, it does not refuse — refusing while anything is open
 * was declined, because a busy club might never find a moment with nothing open.
 *
 * Each count is one population that behaves differently across the change:
 *
 * - `unpaidCardPayments` — a card payment already started: a Stripe intent the
 *   ledger records as pending or processing. Stripe keeps the currency the
 *   intent was created in, so it settles in the OLD currency and is recorded as
 *   currency-less cents.
 * - `pendingSavedCardCharges` — a pending booking whose card was saved to be
 *   charged later. A saved card carries no currency, so the same number of
 *   cents is charged in the NEW currency, though the price was set in the old.
 * - `openRecoveryRetries` — a queued retry that will create a card charge
 *   (`CREATE_ADDITIONAL_PAYMENT_INTENT`, still claimable). It replays an
 *   idempotency key, and Stripe refuses a replay whose currency differs.
 *
 * READS ONLY, and outside any transaction or lock: this is advice shown before
 * a save, not a guard inside one, so it composes no lock tier
 * (`docs/CONCURRENCY_AND_LOCKING.md`) and a count that moves between the read
 * and the save is expected. It never throws: an unreachable database answers
 * `null`, which the panel shows as "could not be counted" rather than as zero.
 */
export type ClubFormatInFlightCardPayments = {
  unpaidCardPayments: number;
  pendingSavedCardCharges: number;
  openRecoveryRetries: number;
};

export async function countInFlightCardPayments(): Promise<ClubFormatInFlightCardPayments | null> {
  try {
    const [unpaidCardPayments, pendingSavedCardCharges, openRecoveryRetries] =
      await Promise.all([
        prisma.paymentTransaction.count({
          where: {
            source: PaymentSource.STRIPE,
            status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
            stripePaymentIntentId: { not: null },
            amountCents: { gt: 0 },
          },
        }),
        prisma.payment.count({
          where: {
            source: PaymentSource.STRIPE,
            status: PaymentStatus.PENDING,
            stripePaymentMethodId: { not: null },
            booking: { status: BookingStatus.PENDING },
          },
        }),
        prisma.paymentRecoveryOperation.count({
          where: {
            type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
            // Every status but the terminal one, and only while the recovery
            // runner will still claim it: a row at the attempt ceiling is dead.
            status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
            attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
          },
        }),
      ]);
    return { unpaidCardPayments, pendingSavedCardCharges, openRecoveryRetries };
  } catch {
    return null;
  }
}
