import "server-only";

import {
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";

import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { SAVED_CARD_CHARGE_KEY_PREFIX } from "@/lib/saved-card-charge-attempt";
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
 *   ledger records as pending or processing, or a group settlement's pending
 *   intent. Stripe keeps the currency the intent was created in, so if the
 *   member completes it, it settles in the OLD currency and is recorded as
 *   currency-less cents. (Opening the payment page again after the change
 *   supersedes it with a new intent in the new currency.)
 * - `pendingSavedCardCharges` — a pending booking whose card was saved to be
 *   charged later. A saved card carries no currency, so the same number of
 *   cents is charged in the NEW currency, though the price was set in the old.
 * - `unansweredSavedCardAttempts` — a saved-card charge whose request Stripe
 *   never answered (an attempt row with no intent). Its replay after the change
 *   is refused by Stripe without saying whether the first request charged, so
 *   it waits for a person once its key leaves Stripe's replay window.
 * - `openRecoveryRetries` — a queued retry that will create a card charge
 *   (`CREATE_ADDITIONAL_PAYMENT_INTENT`, still claimable). It replays an
 *   idempotency key: within Stripe's 24-hour replay window a replay whose
 *   currency differs is refused; after it, a new intent in the new currency is
 *   minted.
 *
 * READS ONLY, and outside any transaction or lock: this is advice shown before
 * a save, not a guard inside one, so it composes no lock tier
 * (`docs/CONCURRENCY_AND_LOCKING.md`) and a count that moves between the read
 * and the save is expected. It never throws: an unreachable database answers
 * `null`, which the panel shows as "could not be counted" rather than as zero.
 *
 * FULL ADMIN ONLY: the GET route returns these counts to a Full Admin, the one
 * role that can change the currency, and `null` to every other admin.
 */
export type ClubFormatInFlightCardPayments = {
  unpaidCardPayments: number;
  pendingSavedCardCharges: number;
  unansweredSavedCardAttempts: number;
  openRecoveryRetries: number;
};

export async function countInFlightCardPayments(): Promise<ClubFormatInFlightCardPayments | null> {
  try {
    const [
      unpaidTransactions,
      unpaidGroupSettlements,
      pendingSavedCardCharges,
      unansweredSavedCardAttempts,
      openRecoveryRetries,
    ] = await Promise.all([
        prisma.paymentTransaction.count({
          where: {
            source: PaymentSource.STRIPE,
            status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
            stripePaymentIntentId: { not: null },
            amountCents: { gt: 0 },
          },
        }),
        prisma.groupBookingSettlement.count({
          where: {
            source: PaymentSource.STRIPE,
            status: PaymentStatus.PENDING,
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
        prisma.paymentTransaction.count({
          where: {
            source: PaymentSource.STRIPE,
            status: PaymentStatus.PENDING,
            stripePaymentIntentId: null,
            reference: { startsWith: SAVED_CARD_CHARGE_KEY_PREFIX },
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
    return {
      unpaidCardPayments: unpaidTransactions + unpaidGroupSettlements,
      pendingSavedCardCharges,
      unansweredSavedCardAttempts,
      openRecoveryRetries,
    };
  } catch {
    return null;
  }
}
