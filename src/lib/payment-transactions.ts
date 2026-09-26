import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import { APP_STRIPE_CURRENCY } from "@/config/operational";
import { prisma } from "@/lib/prisma";
import { processRefund } from "@/lib/stripe";
import { stripeReferenceId, type StripeReference } from "@/lib/stripe-references";
import Stripe from "stripe";
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
// Moved to a leaf so the booking ledger's settlement sync can share them
// without an import cycle (#3581); re-exported so existing importers stand.
import {
  EXCLUDED_LEDGER_REFUND_STATUSES,
  isCapturedTransactionStatus,
  isRecordedRefundStatus,
} from "@/lib/payment-transaction-status";

export { isCapturedTransactionStatus };

export type PaymentStore = Prisma.TransactionClient | typeof prisma;

type StripeRefundLedgerInput = {
  id: string;
  amount: number;
  currency?: string | null;
  status?: string | null;
  reason?: string | null;
  created?: number | null;
  charge?: StripeReference;
  payment_intent?: StripeReference;
};

function stripeCreatedAtToDate(created: number | null | undefined) {
  if (!created) {
    return null;
  }

  return new Date(created * 1000);
}

function normalizeRefundCurrency(currency: string | null | undefined) {
  return (currency ?? APP_STRIPE_CURRENCY).toLowerCase();
}

function normalizeRefundStatus(status: string | null | undefined) {
  return status ?? "unknown";
}

function mapAdditionalSummaryStatus(status: PaymentStatus | null): string | null {
  if (!status) {
    return null;
  }

  if (status === PaymentStatus.FAILED) {
    return "FAILED";
  }

  if (isCapturedTransactionStatus(status)) {
    return "SUCCEEDED";
  }

  return "PENDING";
}

function mapLegacyAdditionalStatus(status: string | null | undefined): PaymentStatus {
  switch (status) {
    case "FAILED":
      return PaymentStatus.FAILED;
    case "SUCCEEDED":
      return PaymentStatus.SUCCEEDED;
    case "PROCESSING":
      return PaymentStatus.PROCESSING;
    case "PENDING":
    default:
      return PaymentStatus.PENDING;
  }
}

function applyRefundStatus(
  baseStatus: PaymentStatus,
  amountCents: number,
  refundedAmountCents: number
) {
  if (amountCents > 0 && refundedAmountCents >= amountCents) {
    return PaymentStatus.REFUNDED;
  }

  if (refundedAmountCents > 0) {
    return PaymentStatus.PARTIALLY_REFUNDED;
  }

  return baseStatus;
}

async function loadPaymentWithTransactions(store: PaymentStore, paymentId: string) {
  return store.payment.findUnique({
    where: { id: paymentId },
    include: {
      transactions: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

function getLatestTransaction<
  T extends {
    kind: PaymentTransactionKind;
    createdAt: Date;
  },
>(transactions: T[], kind: PaymentTransactionKind) {
  let latest: T | null = null;

  for (const transaction of transactions) {
    if (transaction.kind !== kind) {
      continue;
    }

    if (!latest || transaction.createdAt.getTime() > latest.createdAt.getTime()) {
      latest = transaction;
    }
  }

  return latest;
}

function isStripeTransaction<
  T extends {
    source: PaymentSource;
    stripePaymentIntentId: string | null;
  },
>(
  transaction: T
): transaction is T & {
  source: typeof PaymentSource.STRIPE;
  stripePaymentIntentId: string;
} {
  return (
    transaction.source === PaymentSource.STRIPE &&
    Boolean(transaction.stripePaymentIntentId)
  );
}

async function ensurePaymentTransactionsBackfilled(
  store: PaymentStore,
  paymentId: string
) {
  const payment = await loadPaymentWithTransactions(store, paymentId);
  if (!payment) {
    return null;
  }

  const knownIntentIds = new Set(
    payment.transactions.flatMap((transaction) =>
      transaction.stripePaymentIntentId ? [transaction.stripePaymentIntentId] : []
    )
  );
  const createOperations: Array<Promise<unknown>> = [];

  if (payment.stripePaymentIntentId && !knownIntentIds.has(payment.stripePaymentIntentId)) {
    const additionalCapturedAmountCents =
      payment.additionalPaymentIntentId &&
      payment.additionalPaymentStatus === "SUCCEEDED"
        ? payment.additionalAmountCents
        : 0;
    const primaryAmountCents = Math.max(
      payment.amountCents - additionalCapturedAmountCents,
      0
    );
    const primaryRefundedAmountCents = Math.min(
      payment.refundedAmountCents,
      primaryAmountCents
    );

    createOperations.push(
      store.paymentTransaction.create({
        data: {
          paymentId: payment.id,
          kind: PaymentTransactionKind.PRIMARY,
          source: PaymentSource.STRIPE,
          stripePaymentIntentId: payment.stripePaymentIntentId,
          amountCents: primaryAmountCents,
          refundedAmountCents: primaryRefundedAmountCents,
          status: applyRefundStatus(
            payment.status,
            primaryAmountCents,
            primaryRefundedAmountCents
          ),
          paymentMethodId: payment.stripePaymentMethodId ?? undefined,
          reason: "legacy_primary_backfill",
        },
      })
    );
  }

  if (
    payment.additionalPaymentIntentId &&
    !knownIntentIds.has(payment.additionalPaymentIntentId)
  ) {
    const baseStatus = mapLegacyAdditionalStatus(payment.additionalPaymentStatus);
    const primaryAmountCents = payment.stripePaymentIntentId
      ? Math.max(
          payment.amountCents -
            (payment.additionalPaymentStatus === "SUCCEEDED"
              ? payment.additionalAmountCents
              : 0),
          0
        )
      : 0;
    const additionalRefundedAmountCents =
      baseStatus === PaymentStatus.SUCCEEDED
        ? Math.min(
            Math.max(payment.refundedAmountCents - primaryAmountCents, 0),
            payment.additionalAmountCents
          )
        : 0;

    createOperations.push(
      store.paymentTransaction.create({
        data: {
          paymentId: payment.id,
          kind: PaymentTransactionKind.ADDITIONAL,
          source: PaymentSource.STRIPE,
          stripePaymentIntentId: payment.additionalPaymentIntentId,
          amountCents: payment.additionalAmountCents,
          refundedAmountCents: additionalRefundedAmountCents,
          status: applyRefundStatus(
            baseStatus,
            payment.additionalAmountCents,
            additionalRefundedAmountCents
          ),
          reason: "legacy_additional_backfill",
        },
      })
    );
  }

  if (createOperations.length === 0) {
    return payment;
  }

  await Promise.all(createOperations);
  return loadPaymentWithTransactions(store, paymentId);
}

function deriveAggregatePaymentStatus(
  fallbackStatus: PaymentStatus,
  grossCapturedAmountCents: number,
  refundedAmountCents: number,
  latestPrimaryStatus: PaymentStatus | null
) {
  if (grossCapturedAmountCents > 0) {
    if (refundedAmountCents >= grossCapturedAmountCents) {
      return PaymentStatus.REFUNDED;
    }

    if (refundedAmountCents > 0) {
      return PaymentStatus.PARTIALLY_REFUNDED;
    }

    return PaymentStatus.SUCCEEDED;
  }

  return latestPrimaryStatus ?? fallbackStatus;
}

export async function reconcilePaymentAggregates({
  paymentId,
  store = prisma,
}: {
  paymentId: string;
  store?: PaymentStore;
}) {
  const payment = await ensurePaymentTransactionsBackfilled(store, paymentId);
  if (!payment) {
    return null;
  }

  const latestPrimary = getLatestTransaction(
    payment.transactions,
    PaymentTransactionKind.PRIMARY
  );
  // #3528 (`INV-ADDPAY-040`): a request an officer WITHDREW is no longer the
  // live ask. It stays in the ledger - FAILED, intent cancelled, `withdrawnAt`
  // stamped - but the projection reads past it, so the summary columns derive
  // zero rather than the FAILED-but-still-owed shape a declined card keeps.
  // Excluded here, at the one place the columns are derived, so the webhook
  // that follows the cancel cannot resurrect what the withdrawal retired.
  const latestAdditional = getLatestTransaction(
    payment.transactions.filter((transaction) => transaction.withdrawnAt === null),
    PaymentTransactionKind.ADDITIONAL
  );

  const grossCapturedAmountCents = payment.transactions.reduce((sum, transaction) => {
    return sum + (isCapturedTransactionStatus(transaction.status) ? transaction.amountCents : 0);
  }, 0);
  const refundedAmountCents = payment.transactions.reduce((sum, transaction) => {
    return sum + transaction.refundedAmountCents;
  }, 0);
  const preserveZeroDollarSucceededPayment =
    grossCapturedAmountCents === 0 &&
    payment.amountCents === 0 &&
    payment.status === PaymentStatus.SUCCEEDED;
  const aggregateAmountCents =
    preserveZeroDollarSucceededPayment
      ? 0
      : grossCapturedAmountCents > 0
        ? grossCapturedAmountCents
        : latestPrimary?.amountCents ?? payment.amountCents;

  const status = preserveZeroDollarSucceededPayment
    ? PaymentStatus.SUCCEEDED
    : deriveAggregatePaymentStatus(
        payment.status,
        grossCapturedAmountCents,
        refundedAmountCents,
        latestPrimary?.status ?? null
      );
  // #3267 (INV-PAY-055): a saved-card charge ATTEMPT row is a Stripe PRIMARY
  // row born without an intent id, and it stays so after a definite failure.
  // While it is the latest PRIMARY, a reconcile (the #1992 sweep's
  // `payment_intent.canceled` webhook, a failed webhook, …) must not null the
  // Payment's intent pointer: `/pay` and `create-payment-intent` read that
  // pointer to decide whether to mint, and a nulled pointer sends them back to
  // the `_initial` key, which Stripe answers with the CANCELLED first intent —
  // a dead client secret. So a Stripe latest PRIMARY without an intent keeps
  // the pointer the Payment already holds (`??`), the same rule #3268 applies
  // to the card column below. A non-Stripe (IB) latest PRIMARY still yields
  // null, as before.
  const latestPrimaryStripeIntentId =
    latestPrimary && latestPrimary.source === PaymentSource.STRIPE
      ? latestPrimary.stripePaymentIntentId ?? payment.stripePaymentIntentId
      : null;
  // #3268 (INV-PAY-054, "the ledger never moves a saved card"): a Payment with
  // a `stripeSetupIntentId` owns its card column through the SetupIntent
  // writers and the cron's retire path, so the ledger leaves it alone — a late
  // `payment_intent.canceled` for an old intent must not null a card the member
  // has just re-saved. Without one the ledger is followed, but a Stripe row
  // that recorded no pm never nulls a card that is set (`??`). No intent-id
  // gate here, deliberately (a pre-charge attempt row has none). A non-Stripe
  // (IB) latest PRIMARY still yields null — #1967 depends on the IB switch
  // dropping the card.
  const latestPrimaryStripePaymentMethodId =
    latestPrimary && latestPrimary.source === PaymentSource.STRIPE
      ? payment.stripeSetupIntentId != null
        ? payment.stripePaymentMethodId
        : latestPrimary.paymentMethodId ?? payment.stripePaymentMethodId
      : null;
  const latestAdditionalStripeIntentId =
    latestAdditional && isStripeTransaction(latestAdditional)
      ? latestAdditional.stripePaymentIntentId
      : null;
  const nextPaymentSource =
    preserveZeroDollarSucceededPayment
      ? payment.source
      : latestPrimary?.source ?? payment.source;
  const nextStripePaymentIntentId = preserveZeroDollarSucceededPayment
    ? payment.stripePaymentIntentId
    : latestPrimary
      ? latestPrimaryStripeIntentId
      : payment.stripePaymentIntentId;
  const nextStripePaymentMethodId = preserveZeroDollarSucceededPayment
    ? payment.stripePaymentMethodId
    : latestPrimary
      ? latestPrimaryStripePaymentMethodId
      : payment.stripePaymentMethodId;
  const nextPaymentReference =
    !preserveZeroDollarSucceededPayment &&
    latestPrimary?.source === PaymentSource.INTERNET_BANKING
      ? latestPrimary.reference ?? payment.reference
      : payment.reference;
  const nextXeroInvoiceId =
    !preserveZeroDollarSucceededPayment &&
    latestPrimary?.source === PaymentSource.INTERNET_BANKING
      ? latestPrimary.xeroInvoiceId ?? payment.xeroInvoiceId
      : payment.xeroInvoiceId;
  const nextXeroInvoiceNumber =
    !preserveZeroDollarSucceededPayment &&
    latestPrimary?.source === PaymentSource.INTERNET_BANKING
      ? latestPrimary.xeroInvoiceNumber ?? payment.xeroInvoiceNumber
      : payment.xeroInvoiceNumber;

  await store.payment.update({
    where: { id: payment.id },
    data: {
      amountCents: aggregateAmountCents,
      refundedAmountCents,
      status,
      source: nextPaymentSource,
      reference: nextPaymentReference,
      stripePaymentIntentId: nextStripePaymentIntentId,
      stripePaymentMethodId: nextStripePaymentMethodId,
      xeroInvoiceId: nextXeroInvoiceId,
      xeroInvoiceNumber: nextXeroInvoiceNumber,
      additionalPaymentIntentId: latestAdditionalStripeIntentId,
      additionalAmountCents: latestAdditional?.amountCents ?? 0,
      additionalPaymentStatus: mapAdditionalSummaryStatus(
        latestAdditional?.status ?? null
      ),
    },
  });

  // #3581: the booking ledger's settlement lines converge from the SAME rows
  // the mirror above was just derived from, at the same place — so every
  // capture, receipt and refund writer that ends here is covered, including
  // one nobody has written yet. Idempotent by key (`INV-MONEY-033`).
  await syncBookingLedgerSettlements({ paymentId: payment.id, store });

  return store.payment.findUnique({
    where: { id: payment.id },
  });
}

async function findPaymentByIntentPointer(
  store: PaymentStore,
  paymentIntentId: string
) {
  const primaryMatch = await store.payment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  });
  if (primaryMatch) {
    return primaryMatch;
  }

  return store.payment.findUnique({
    where: { additionalPaymentIntentId: paymentIntentId },
  });
}

export async function findPaymentTransactionByIntentId({
  paymentIntentId,
  store = prisma,
}: {
  paymentIntentId: string;
  store?: PaymentStore;
}) {
  let transaction = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  });

  if (transaction) {
    return transaction;
  }

  const payment = await findPaymentByIntentPointer(store, paymentIntentId);
  if (!payment) {
    return null;
  }

  await ensurePaymentTransactionsBackfilled(store, payment.id);
  transaction = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  });

  return transaction;
}

async function recordStripeRefundLedgerEntry({
  paymentId,
  paymentTransactionId,
  refund,
  fallbackChargeId,
  fallbackPaymentIntentId,
  store,
}: {
  paymentId: string;
  paymentTransactionId: string;
  refund: StripeRefundLedgerInput;
  fallbackChargeId?: string | null;
  fallbackPaymentIntentId?: string | null;
  store: PaymentStore;
}) {
  const stripeChargeId = stripeReferenceId(refund.charge) ?? fallbackChargeId ?? null;
  const stripePaymentIntentId =
    stripeReferenceId(refund.payment_intent) ?? fallbackPaymentIntentId ?? null;
  const stripeCreatedAt = stripeCreatedAtToDate(refund.created);
  const data = {
    paymentId,
    paymentTransactionId: paymentTransactionId ?? null,
    stripeChargeId,
    stripePaymentIntentId,
    amountCents: refund.amount,
    currency: normalizeRefundCurrency(refund.currency),
    status: normalizeRefundStatus(refund.status),
    reason: refund.reason ?? null,
    stripeCreatedAt,
  };

  // #3640: `created` decides whether the refund is ADDED to the mirror, so the
  // INSERT itself must answer it. The old read-then-upsert let two writers
  // recording one refund at once - the inline refund and its own
  // `charge.refunded` webhook - both see no row and both report `created`,
  // which would add the refund twice. `ON CONFLICT DO NOTHING` inserts for
  // exactly one of them; the other refreshes the row it lost to.
  const inserted = await store.paymentRefund.createMany({
    data: [{ ...data, stripeRefundId: refund.id }],
    skipDuplicates: true,
  });
  if (inserted.count === 0) {
    await store.paymentRefund.update({
      where: { stripeRefundId: refund.id },
      data,
    });
  }

  return {
    created: inserted.count > 0,
    amountCents: refund.amount,
    status: data.status,
  };
}

/**
 * Run `fn` atomically: inside the caller's transaction when `store` is one,
 * otherwise inside a transaction of its own. The root client is told apart by
 * `$connect`, which an interactive transaction client does not carry;
 * `$transaction` cannot tell them apart (measured on Prisma 7, see
 * `edit-financial-review.ts`).
 */
function runAtomically<T>(
  store: PaymentStore,
  fn: (db: PaymentStore) => Promise<T>
): Promise<T> {
  if (typeof (store as { $connect?: unknown }).$connect === "function") {
    return (store as typeof prisma).$transaction((tx) => fn(tx));
  }
  return fn(store);
}

/** Re-reads the refund mirror's compare-and-set allows before failing loud. */
const REFUND_MIRROR_CAS_ATTEMPTS = 5;

/**
 * #3640 - THE one way a Stripe card refund reaches a transaction's
 * `refundedAmountCents` mirror (`INV-SSOT`). The inline refund, the
 * `charge.refunded` webhook sync and the superseded-payment refund recovery all
 * write through here.
 *
 * ## The refund is ADDED, never maxed
 *
 * The mirror counts BOTH dispositions - card refunds and account-credit
 * settlements (`applyLocalRefundAllocation`, which writes no `PaymentRefund`
 * row; see `stripe-cash-refund-evidence.ts`). It used to be set to
 * `max(stored, card refunds on record)`, so a card refund made AFTER a credit
 * vanished: $100 credit then a $50 card refund read $100, not $150, and a later
 * 100%-tier cancel paid $450 against $400 taken. Now only a refund this call
 * NEWLY recorded, in a counted status (`isRecordedRefundStatus`), is added. A
 * replay records nothing new and adds nothing.
 *
 * The card refunds on record - and, from the webhook, Stripe's own
 * `amount_refunded` - remain a FLOOR, never the value: the mirror can never read
 * below the cash the card has demonstrably returned, which is also what heals a
 * row a pre-#3640 crash left between its ledger row and its mirror write.
 * Capped at the transaction's captured amount, as before.
 *
 * ## Why it cannot lose or double an increment
 *
 * - `created` is answered by the INSERT (`recordStripeRefundLedgerEntry`), so
 *   two writers recording one refund cannot both add it.
 * - The mirror write is a compare-and-set on the value it was computed from,
 *   re-read and retried on a miss - the #3032 discipline. It is never a stale
 *   absolute write, and a concurrent credit allocation's own CAS refuses rather
 *   than overwrite it.
 * - The ledger rows and the mirror write commit TOGETHER (`runAtomically`): a
 *   crash between them would otherwise leave a row whose replay reports "not
 *   created" and never adds it.
 * - Refunds are inserted in id order, so two writers inserting overlapping sets
 *   take the unique-index locks in one order.
 *
 * Returns `appliedCents`, how far THIS call moved the mirror - the real delta
 * the webhook queues a Xero credit note for.
 */
export async function recordStripeRefundsAgainstTransaction({
  paymentId,
  paymentTransactionId,
  refunds,
  fallbackChargeId,
  fallbackPaymentIntentId,
  stripeRefundedAmountCents = 0,
  store = prisma,
}: {
  paymentId: string;
  paymentTransactionId: string;
  refunds: readonly StripeRefundLedgerInput[];
  fallbackChargeId?: string | null;
  fallbackPaymentIntentId?: string | null;
  /** Stripe's cumulative `amount_refunded` for the charge, when known. */
  stripeRefundedAmountCents?: number;
  store?: PaymentStore;
}) {
  return runAtomically(store, async (db) => {
    let createdRefundsCount = 0;
    let createdRefundAmountCents = 0;
    let newlyCountedCents = 0;
    const ordered = [...refunds].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    for (const refund of ordered) {
      const recorded = await recordStripeRefundLedgerEntry({
        paymentId,
        paymentTransactionId,
        refund,
        fallbackChargeId,
        fallbackPaymentIntentId,
        store: db,
      });
      if (!recorded.created) {
        continue;
      }
      createdRefundsCount += 1;
      createdRefundAmountCents += recorded.amountCents;
      if (isRecordedRefundStatus(recorded.status)) {
        newlyCountedCents += recorded.amountCents;
      }
    }

    const ledgerRefundedAmountCents = await sumRecordedRefundsForTransaction(
      db,
      paymentTransactionId
    );

    for (let attempt = 0; attempt < REFUND_MIRROR_CAS_ATTEMPTS; attempt += 1) {
      const current = await db.paymentTransaction.findUnique({
        where: { id: paymentTransactionId },
        select: { amountCents: true, refundedAmountCents: true },
      });
      if (!current) {
        throw new Error(`Payment transaction ${paymentTransactionId} not found`);
      }
      const nextRefundedAmountCents = Math.min(
        current.amountCents,
        Math.max(
          current.refundedAmountCents + newlyCountedCents,
          ledgerRefundedAmountCents,
          stripeRefundedAmountCents,
          0
        )
      );
      const claimed = await db.paymentTransaction.updateMany({
        where: {
          id: paymentTransactionId,
          refundedAmountCents: current.refundedAmountCents,
        },
        data: {
          refundedAmountCents: nextRefundedAmountCents,
          status: applyRefundStatus(
            PaymentStatus.SUCCEEDED,
            current.amountCents,
            nextRefundedAmountCents
          ),
        },
      });
      if (claimed.count === 1) {
        return {
          createdRefundsCount,
          createdRefundAmountCents,
          ledgerRefundedAmountCents,
          refundedAmountCents: nextRefundedAmountCents,
          appliedCents: Math.max(
            nextRefundedAmountCents - current.refundedAmountCents,
            0
          ),
        };
      }
    }

    throw new Error(
      `Refund mirror for payment transaction ${paymentTransactionId} kept moving under ${REFUND_MIRROR_CAS_ATTEMPTS} compare-and-set attempts`
    );
  });
}

async function sumRecordedRefundsForTransaction(
  store: PaymentStore,
  paymentTransactionId: string
) {
  const recordedRefunds = await store.paymentRefund.aggregate({
    where: {
      paymentTransactionId,
      status: {
        notIn: EXCLUDED_LEDGER_REFUND_STATUSES,
      },
    },
    _sum: { amountCents: true },
  });

  return recordedRefunds._sum.amountCents ?? 0;
}

export async function upsertPaymentIntentTransaction({
  paymentId,
  kind,
  paymentIntentId,
  amountCents,
  carriedAskCents,
  status,
  paymentMethodId,
  reason,
  stripeCustomerId,
  store = prisma,
}: {
  paymentId: string;
  kind: PaymentTransactionKind;
  paymentIntentId: string;
  amountCents: number;
  /**
   * #3371: how much of `amountCents` was absorbed from an ask the same mint
   * retired. Supplied ONLY by the sites that mint or raise an ADDITIONAL
   * request, which get it from an `AdditionalAsk` and cannot get it any other
   * way; every other caller here (webhook status writes, PRIMARY rows, refund
   * bookkeeping) omits it and MUST, because omitting it leaves the stored
   * provenance alone rather than resetting a real carried balance to zero.
   */
  carriedAskCents?: number;
  status: PaymentStatus;
  paymentMethodId?: string | null;
  reason?: string;
  stripeCustomerId?: string | null;
  store?: PaymentStore;
}) {
  await store.paymentTransaction.upsert({
    where: { stripePaymentIntentId: paymentIntentId },
    create: {
      paymentId,
      kind,
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: paymentIntentId,
      amountCents,
      status,
      paymentMethodId: paymentMethodId ?? undefined,
      reason,
      ...(carriedAskCents !== undefined ? { carriedAskCents } : {}),
    },
    update: {
      paymentId,
      kind,
      source: PaymentSource.STRIPE,
      amountCents,
      status,
      ...(paymentMethodId !== undefined
        ? { paymentMethodId: paymentMethodId ?? null }
        : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(carriedAskCents !== undefined ? { carriedAskCents } : {}),
    },
  });

  if (stripeCustomerId) {
    await store.payment.update({
      where: { id: paymentId },
      data: { stripeCustomerId },
    });
  }

  return reconcilePaymentAggregates({ paymentId, store });
}

export async function recordInternetBankingPaymentTransaction({
  paymentId,
  kind = PaymentTransactionKind.PRIMARY,
  amountCents,
  status = PaymentStatus.PENDING,
  xeroInvoiceId,
  xeroInvoiceNumber,
  reference,
  reason,
  store = prisma,
}: {
  paymentId: string;
  kind?: PaymentTransactionKind;
  amountCents: number;
  status?: PaymentStatus;
  xeroInvoiceId?: string | null;
  xeroInvoiceNumber?: string | null;
  reference?: string | null;
  reason?: string;
  store?: PaymentStore;
}) {
  await store.paymentTransaction.create({
    data: {
      paymentId,
      kind,
      source: PaymentSource.INTERNET_BANKING,
      stripePaymentIntentId: null,
      xeroInvoiceId: xeroInvoiceId ?? undefined,
      xeroInvoiceNumber: xeroInvoiceNumber ?? undefined,
      reference: reference ?? undefined,
      amountCents,
      status,
      reason,
    },
  });

  return reconcilePaymentAggregates({ paymentId, store });
}

export async function markPaymentIntentTransactionSucceeded({
  paymentIntentId,
  amountCents,
  paymentMethodId,
  store = prisma,
}: {
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId?: string | null;
  store?: PaymentStore;
}) {
  const transaction = await findPaymentTransactionByIntentId({
    paymentIntentId,
    store,
  });
  if (!transaction) {
    return null;
  }

  await store.paymentTransaction.update({
    where: { id: transaction.id },
    data: {
      amountCents,
      status: PaymentStatus.SUCCEEDED,
      ...(paymentMethodId !== undefined
        ? { paymentMethodId: paymentMethodId ?? null }
        : {}),
    },
  });

  return reconcilePaymentAggregates({ paymentId: transaction.paymentId, store });
}

export async function markPaymentIntentTransactionFailed({
  paymentIntentId,
  store = prisma,
}: {
  paymentIntentId: string;
  store?: PaymentStore;
}) {
  const transaction = await findPaymentTransactionByIntentId({
    paymentIntentId,
    store,
  });
  if (!transaction) {
    return null;
  }

  if (isCapturedTransactionStatus(transaction.status)) {
    return transaction;
  }

  await store.paymentTransaction.update({
    where: { id: transaction.id },
    data: { status: PaymentStatus.FAILED },
  });

  return reconcilePaymentAggregates({ paymentId: transaction.paymentId, store });
}

export async function syncRefundsFromStripeCharge({
  paymentIntentId,
  stripeChargeId,
  refundedAmountCents,
  refunds,
  store = prisma,
}: {
  paymentIntentId: string;
  stripeChargeId: string;
  refundedAmountCents: number;
  refunds: StripeRefundLedgerInput[];
  store?: PaymentStore;
}) {
  const transaction = await findPaymentTransactionByIntentId({
    paymentIntentId,
    store,
  });
  if (!transaction) {
    return null;
  }

  const recorded = await recordStripeRefundsAgainstTransaction({
    paymentId: transaction.paymentId,
    paymentTransactionId: transaction.id,
    refunds,
    fallbackChargeId: stripeChargeId,
    fallbackPaymentIntentId: paymentIntentId,
    stripeRefundedAmountCents: refundedAmountCents,
    store,
  });

  const payment = await reconcilePaymentAggregates({
    paymentId: transaction.paymentId,
    store,
  });

  return {
    payment,
    // #3640: how far THIS sync moved the refunded total - a refund the club
    // has not already recorded, including one made after an account-credit
    // settlement, which the old max-based total swallowed and left to the
    // daily Xero reconciliation to notice.
    refundDeltaCents: recorded.appliedCents,
    paymentId: transaction.paymentId,
    transactionId: transaction.id,
    createdRefundsCount: recorded.createdRefundsCount,
    createdRefundAmountCents: recorded.createdRefundAmountCents,
    ledgerRefundedAmountCents: recorded.ledgerRefundedAmountCents,
  };
}

type RefundableStripeTransaction = {
  id: string;
  source: PaymentSource;
  stripePaymentIntentId: string | null;
  status: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
  createdAt: Date;
};

/**
 * The single derivation of newest-first per-transaction refund slices, shared
 * by refundPaymentTransactions (when no explicit allocation is passed) and
 * planStripeRefundAllocation (#1349). Sharing it is load-bearing: a plan frozen
 * at cancellation-claim time must produce byte-identical slices — and therefore
 * identical `${prefix}_${transactionId}_${amount}` Stripe idempotency keys — to
 * what an inline refund would derive, so a replay is answered by Stripe with
 * the original refunds instead of minting new ones. Slices are capped at what
 * the ledger shows refundable; callers decide whether a shortfall throws.
 */
function buildRefundAllocationSlices<T extends RefundableStripeTransaction>(
  transactions: readonly T[],
  amountCents: number
): {
  slices: Array<{ transaction: T; amountCents: number }>;
  totalRefundableCents: number;
} {
  const refundableTransactions = transactions
    .filter(isStripeTransaction)
    .filter((transaction) => isCapturedTransactionStatus(transaction.status))
    .filter(
      (transaction) =>
        transaction.amountCents - transaction.refundedAmountCents > 0
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const totalRefundableCents = refundableTransactions.reduce(
    (sum, transaction) =>
      sum + (transaction.amountCents - transaction.refundedAmountCents),
    0
  );

  let remainingAmountCents = amountCents;
  const slices: Array<{ transaction: T; amountCents: number }> = [];
  for (const transaction of refundableTransactions) {
    if (remainingAmountCents <= 0) break;
    const refundableAmountCents =
      transaction.amountCents - transaction.refundedAmountCents;
    const sliceAmountCents = Math.min(
      remainingAmountCents,
      refundableAmountCents
    );
    slices.push({ transaction, amountCents: sliceAmountCents });
    remainingAmountCents -= sliceAmountCents;
  }

  return { slices, totalRefundableCents };
}

/**
 * Freeze the refund allocation a later refundPaymentTransactions call would
 * derive, without touching Stripe (#1349). Used inside the booking-cancel
 * claim transaction to persist the refund debt (recovery operation + plan)
 * atomically with the CANCELLED flip, before any external call. Backfills
 * legacy payments' transaction rows so the plan exists even for pre-ledger
 * payments. Never throws on a shortfall: the plan covers min(amountCents,
 * refundable) and the caller surfaces any gap.
 */
export async function planStripeRefundAllocation({
  paymentId,
  amountCents,
  store = prisma,
}: {
  paymentId: string;
  amountCents: number;
  store?: PaymentStore;
}): Promise<{
  slices: RefundAllocationSlice[];
  plannedAmountCents: number;
  totalRefundableCents: number;
}> {
  const payment = await ensurePaymentTransactionsBackfilled(store, paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const { slices, totalRefundableCents } = buildRefundAllocationSlices(
    payment.transactions,
    amountCents
  );

  const plan = slices.map((slice) => ({
    paymentTransactionId: slice.transaction.id,
    amountCents: slice.amountCents,
  }));

  return {
    slices: plan,
    plannedAmountCents: plan.reduce((sum, slice) => sum + slice.amountCents, 0),
    totalRefundableCents,
  };
}

export interface RefundAllocationSlice {
  paymentTransactionId: string;
  amountCents: number;
}

/**
 * Thrown when a multi-slice refund fails partway (#1097): carries how much of
 * the requested amount was refunded **and recorded** before the failure so
 * enqueued recovery work asks for exactly the remainder, never the original
 * total again.
 */
export class PartialRefundError extends Error {
  completedRefundCents: number;
  refunds: Array<{
    paymentIntentId: string;
    refundId: string;
    amountCents: number;
  }>;
  override cause: unknown;

  constructor({
    completedRefundCents,
    refunds,
    cause,
    format,
  }: {
    completedRefundCents: number;
    refunds: PartialRefundError["refunds"];
    cause: unknown;
    /** The club's format (#3565): the message names the amount already refunded. */
    format: ClubFormat;
  }) {
    super(
      `Refund failed after ${formatCents(completedRefundCents, format)} was refunded and recorded: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "PartialRefundError";
    this.completedRefundCents = completedRefundCents;
    this.refunds = refunds;
    this.cause = cause;
  }
}

export async function refundPaymentTransactions({
  paymentId,
  amountCents,
  reason = "requested_by_customer",
  metadata,
  idempotencyKeyPrefix,
  allocation,
  store = prisma,
  format,
}: {
  paymentId: string;
  amountCents: number;
  reason?: Stripe.RefundCreateParams.Reason;
  metadata?: Record<string, string>;
  idempotencyKeyPrefix?: string;
  /**
   * Explicit per-transaction slices to execute (#1097). When present, the
   * internal newest-first allocation is skipped and exactly these slices are
   * refunded with keys `${prefix}_${transactionId}_${sliceAmount}` — so a
   * retry driven by a persisted plan replays the identical Stripe requests
   * (Stripe returns the original refund for a repeated key, and the ledger
   * dedupes on refund id), instead of deriving a shifted allocation from
   * whatever progress happens to be recorded.
   */
  allocation?: ReadonlyArray<RefundAllocationSlice>;
  store?: PaymentStore;
  /** The club's format (#3565), resolved before any transaction by the caller. */
  format: ClubFormat;
}) {
  const payment = await ensurePaymentTransactionsBackfilled(store, paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const stripeTransactions = payment.transactions
    .filter(isStripeTransaction)
    .filter((transaction) => isCapturedTransactionStatus(transaction.status));

  let slices: Array<{
    transaction: (typeof stripeTransactions)[number];
    amountCents: number;
  }>;

  if (allocation) {
    const byId = new Map(
      stripeTransactions.map((transaction) => [transaction.id, transaction])
    );
    slices = allocation.map((slice) => {
      const transaction = byId.get(slice.paymentTransactionId);
      if (!transaction) {
        throw new Error(
          `Refund allocation references transaction ${slice.paymentTransactionId} which is not a captured Stripe transaction of payment ${paymentId}`
        );
      }
      return { transaction, amountCents: slice.amountCents };
    });
  } else {
    // Shared with planStripeRefundAllocation (#1349) so a plan frozen at
    // cancellation-claim time derives the exact slices (and Stripe keys) this
    // inline path would.
    const derived = buildRefundAllocationSlices(stripeTransactions, amountCents);

    if (amountCents > derived.totalRefundableCents) {
      throw new Error("Refund amount exceeds captured Stripe payments");
    }

    slices = derived.slices;
  }

  const refunds: Array<{
    paymentIntentId: string;
    refundId: string;
    amountCents: number;
  }> = [];
  let completedRefundCents = 0;

  for (const { transaction, amountCents: refundAmountForTransaction } of slices) {
    let refund;
    try {
      refund = await processRefund({
        paymentIntentId: transaction.stripePaymentIntentId,
        amountCents: refundAmountForTransaction,
        reason:
          typeof reason === "string" ? reason : "requested_by_customer",
        metadata,
        idempotencyKey: idempotencyKeyPrefix
          ? `${idempotencyKeyPrefix}_${transaction.id}_${refundAmountForTransaction}`
          : undefined,
      });
    } catch (err) {
      throw new PartialRefundError({
        completedRefundCents,
        refunds,
        cause: err,
        format,
      });
    }

    await recordStripeRefundsAgainstTransaction({
      paymentId,
      paymentTransactionId: transaction.id,
      refunds: [refund],
      fallbackPaymentIntentId: transaction.stripePaymentIntentId,
      store,
    });
    await reconcilePaymentAggregates({ paymentId, store });

    refunds.push({
      paymentIntentId: transaction.stripePaymentIntentId,
      refundId: refund.id,
      amountCents: refund.amount,
    });
    completedRefundCents += refundAmountForTransaction;
  }

  return {
    refunds,
    totalRefundedAmountCents: amountCents,
  };
}

/**
 * Raised when the compare-and-set below loses: another writer moved this
 * transaction's `refundedAmountCents` between the read and the write.
 *
 * Exported so a caller can turn it into an answer its operator can act on
 * ("refresh and try again") rather than a 500. It carries no amounts - the
 * caller's own figures are the ones the operator needs.
 */
export class RefundAllocationRacedError extends Error {
  constructor() {
    super("Refund allocation raced another writer on the same payment");
    this.name = "RefundAllocationRacedError";
  }
}

/**
 * Mirror a refund the club made by hand into the payment ledger.
 *
 * ## Why every write here is a COMPARE-AND-SET (#3032)
 *
 * This function computes an ABSOLUTE `refundedAmountCents` from a value it read
 * a moment earlier, so two writers on one `PaymentTransaction` silently lose an
 * update: a $30 refund recorded by one and a $50 allocation written by the other
 * leave the row saying $50 instead of $80, which OVERSTATES the refundable
 * headroom by $30 and lets a later refund exceed what was ever captured.
 *
 * That was unreachable until #3032. Every pre-#3032 caller either holds the
 * global settlement key `lock(1)` (booking-cancel, the credit writers reached
 * from the booking-edit services) or ran only on a CANCELLED booking, which no
 * edit path will touch. #3032 adds a caller that is neither: completing an
 * `EDIT_FINANCIAL_REVIEW` task allocates against a LIVE booking and deliberately
 * holds no advisory lock, because serialising it would mean holding `lock(1)`
 * across a Stripe round trip. The fence keeps most concurrent edits off that
 * booking, but a consent-authority guest removal is exempt by owner decision
 * D-14 and does move money.
 *
 * The guard is the repository's own idiom - a status-guarded claim, here guarded
 * on the exact value the plan was computed from - and it FAILS LOUD instead of
 * losing the update. Callers under `lock(1)` cannot race, so it never fires for
 * them; the one caller that can race gets a refusal it can hand to an operator,
 * with its transaction rolled back and its task left OPEN.
 */
export async function applyLocalRefundAllocation({
  paymentId,
  amountCents,
  store = prisma,
}: {
  paymentId: string;
  amountCents: number;
  store?: PaymentStore;
}) {
  const payment = await ensurePaymentTransactionsBackfilled(store, paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const refundableTransactions = [...payment.transactions]
    .filter((transaction) => isCapturedTransactionStatus(transaction.status))
    .filter(
      (transaction) =>
        transaction.amountCents - transaction.refundedAmountCents > 0
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const totalRefundableCents = refundableTransactions.reduce((sum, transaction) => {
    return sum + (transaction.amountCents - transaction.refundedAmountCents);
  }, 0);

  if (amountCents > totalRefundableCents) {
    throw new Error("Refund amount exceeds captured payments");
  }

  let remainingAmountCents = amountCents;

  for (const transaction of refundableTransactions) {
    if (remainingAmountCents <= 0) {
      break;
    }

    const refundableAmountCents =
      transaction.amountCents - transaction.refundedAmountCents;
    const refundAmountForTransaction = Math.min(
      remainingAmountCents,
      refundableAmountCents
    );
    const nextRefundedAmountCents =
      transaction.refundedAmountCents + refundAmountForTransaction;

    // Compare-and-set on the value this slice was computed from. See the
    // docblock: an unguarded absolute write loses a concurrent writer's update
    // and overstates the refundable headroom.
    const claimed = await store.paymentTransaction.updateMany({
      where: {
        id: transaction.id,
        refundedAmountCents: transaction.refundedAmountCents,
      },
      data: {
        refundedAmountCents: nextRefundedAmountCents,
        status: applyRefundStatus(
          PaymentStatus.SUCCEEDED,
          transaction.amountCents,
          nextRefundedAmountCents
        ),
      },
    });
    if (claimed.count === 0) {
      throw new RefundAllocationRacedError();
    }
    remainingAmountCents -= refundAmountForTransaction;
  }

  await reconcilePaymentAggregates({ paymentId, store });
}
