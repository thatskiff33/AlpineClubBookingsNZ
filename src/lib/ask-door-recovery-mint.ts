/**
 * #3954 and #4744: the door's mint of an ask whose recovery was written in the
 * edit's own transaction — a re-issued ask, or an increase that folded a
 * waiting retry in. The row, the recovery's completion and the supersede's
 * durable rows commit together, and only while the recovery is still the
 * state the door read. A lost fence writes nothing.
 */
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";

import { assertAdditionalAskSizingCurrent } from "@/lib/additional-ask-queue-transaction";
import { writeAskUnderDoorRecovery, type ReissuedAskRecovery } from "@/lib/additional-ask-reissue";
import type { AdditionalAsk } from "@/lib/additional-payment-ask";
import {
  cancelSupersededAdditionalIntentsNow,
  queueSupersededAdditionalIntentCancellationRows,
  type QueuedSupersededIntentCancellation,
} from "@/lib/booking-payment-cleanup";
import type { ClubFormat } from "@/lib/club-format";
import { retireAskOnEndedBooking } from "@/lib/ended-booking-ask-guard";
import logger from "@/lib/logger";
import { mintOrdinaryAskIntent } from "@/lib/ordinary-ask-mint";
import { planOrdinaryAskMint } from "@/lib/ordinary-ask-request";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import { settleLostReissuedAskFence } from "@/lib/reissued-ask-abandoned-intent";
import { queueFoldedAskInvoices, queueReissuedAskSupplementaryInvoice } from "@/lib/reissued-ask-invoice";
import {
  mintedIntentCustomerId,
  mintReissuedAskIntent,
  planReissuedAskMint,
  readAskMintPayment,
  resolveAskCustomerId,
} from "@/lib/reissued-ask-mint";

export type DoorRecoveryMintResult =
  | { outcome: "retired" }
  | { outcome: "left"; recovery: ReissuedAskRecovery | null }
  | { outcome: "minted"; intentId: string; clientSecret: string | null; live: boolean };

/** Mint under the recovery the edit committed, and complete that recovery with the row. */
export async function mintAskUnderItsDoorRecovery({
  format,
  bookingId,
  paymentId,
  bookingModificationId,
  hasIssuedXeroInvoice,
  recovery,
  ask,
  reason,
}: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  hasIssuedXeroInvoice: boolean | null;
  recovery: ReissuedAskRecovery;
  ask: AdditionalAsk;
  /** The door's ledger reason. A re-issue's plan names its own. */
  reason: string;
}): Promise<DoorRecoveryMintResult> {
  const current = await readAskMintPayment(paymentId);
  const customerId = await resolveAskCustomerId(current);
  if (ask.reissuesUnpaidAsk) {
    return mintReissue({ format, bookingId, paymentId, bookingModificationId, recovery, customerId, current });
  }
  return mintFoldedIncrease({
    format,
    bookingId,
    paymentId,
    bookingModificationId,
    hasIssuedXeroInvoice,
    recovery,
    ask,
    reason,
    customerId,
  });
}

/**
 * Lost-fence settlement, the supersede, and retire-before-invoice are one
 * sequence. The row write and the invoice queue stay with the caller: a
 * re-issue and a folding increase send different requests.
 */
async function finishMintUnderDoorRecovery({
  format,
  bookingId,
  paymentId,
  bookingModificationId,
  recovery,
  intent,
  superseded,
  lostFenceMessage,
  queueInvoices,
}: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  recovery: ReissuedAskRecovery;
  intent: { id: string; client_secret: string | null };
  superseded: readonly QueuedSupersededIntentCancellation[] | null;
  lostFenceMessage: string;
  queueInvoices: () => Promise<boolean>;
}): Promise<DoorRecoveryMintResult> {
  if (superseded === null) {
    logger.warn({ bookingId, bookingModificationId, paymentIntentId: intent.id }, lostFenceMessage);
    return {
      outcome: "left",
      recovery: await settleLostReissuedAskFence({
        bookingId,
        bookingModificationId,
        paymentIntentId: intent.id,
        stripeKey: recovery.paymentIntentId,
      }),
    };
  }
  await cancelSupersededAdditionalIntentsNow({
    format,
    bookingId,
    paymentId,
    queued: superseded,
    newPaymentIntentId: intent.id,
  });
  if (await retireAskOnEndedBooking({ format, bookingId, paymentId, paymentIntentId: intent.id })) {
    return { outcome: "retired" };
  }
  const live = await queueInvoices();
  return { outcome: "minted", intentId: intent.id, clientSecret: intent.client_secret, live };
}

async function mintReissue({
  format,
  bookingId,
  paymentId,
  bookingModificationId,
  recovery,
  customerId,
  current,
}: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  recovery: ReissuedAskRecovery;
  customerId: string;
  current: Awaited<ReturnType<typeof readAskMintPayment>>;
}): Promise<DoorRecoveryMintResult> {
  const plan = planReissuedAskMint({
    bookingId,
    recovery: { amountCents: recovery.amountCents, stripeKey: recovery.paymentIntentId },
    payment: current,
  });
  const pi = await mintReissuedAskIntent({ format, plan, customerId, recoveryCreatedAt: recovery.createdAt });
  const superseded = await writeAskUnderDoorRecovery(recovery, pi.id, async (store) => {
    await assertAdditionalAskSizingCurrent(store, paymentId, plan.ask);
    await upsertPaymentIntentTransaction({
      paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: pi.id,
      amountCents: plan.ask.amountCents,
      carriedAskCents: plan.ask.carriedCents,
      status: PaymentStatus.PENDING,
      reason: plan.reason,
      stripeCustomerId: mintedIntentCustomerId(pi, customerId),
      bookingModificationId,
      store,
    });
    return queueSupersededAdditionalIntentCancellationRows({
      bookingId,
      paymentId,
      newPaymentIntentId: pi.id,
      store,
    });
  });
  return finishMintUnderDoorRecovery({
    format,
    bookingId,
    paymentId,
    bookingModificationId,
    recovery,
    intent: pi,
    superseded,
    lostFenceMessage:
      "A re-issued additional ask's recovery moved while the door minted it (#3954); nothing written - the recovery's owner asks the member",
    queueInvoices: () => queueReissuedAskSupplementaryInvoice({ bookingId, bookingModificationId, paymentIntentId: pi.id }),
  });
}

async function mintFoldedIncrease({
  format,
  bookingId,
  paymentId,
  bookingModificationId,
  hasIssuedXeroInvoice,
  recovery,
  ask,
  reason,
  customerId,
}: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  hasIssuedXeroInvoice: boolean | null;
  recovery: ReissuedAskRecovery;
  ask: AdditionalAsk;
  reason: string;
  customerId: string;
}): Promise<DoorRecoveryMintResult> {
  const plan = planOrdinaryAskMint({
    bookingId,
    bookingModificationId,
    stripeKey: recovery.paymentIntentId,
    frozenAmountCents: recovery.amountCents,
    amountCents: ask.amountCents,
  });
  const { intent: pi } = await mintOrdinaryAskIntent({ format, plan, customerId, recovery: null });
  const superseded = await writeAskUnderDoorRecovery(recovery, pi.id, async (store) => {
    await assertAdditionalAskSizingCurrent(store, paymentId, ask);
    await upsertPaymentIntentTransaction({
      paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: pi.id,
      amountCents: ask.amountCents,
      carriedAskCents: ask.carriedCents,
      status: PaymentStatus.PENDING,
      reason,
      stripeCustomerId: mintedIntentCustomerId(pi, customerId),
      ...(hasIssuedXeroInvoice !== null ? { hadIssuedXeroInvoice: hasIssuedXeroInvoice } : {}),
      bookingModificationId,
      store,
    });
    return queueSupersededAdditionalIntentCancellationRows({
      bookingId,
      paymentId,
      newPaymentIntentId: pi.id,
      store,
    });
  });
  return finishMintUnderDoorRecovery({
    format,
    bookingId,
    paymentId,
    bookingModificationId,
    recovery,
    intent: pi,
    superseded,
    lostFenceMessage:
      "A folding increase's recovery moved while the door minted it (#4744); nothing written - the recovery's owner asks the member",
    queueInvoices: () =>
      queueFoldedAskInvoices({ bookingId, increaseModificationId: bookingModificationId, paymentIntentId: pi.id }),
  });
}
