import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import { APP_STRIPE_CURRENCY } from "@/config/operational";
import { prisma } from "@/lib/prisma";
import { processRefund } from "@/lib/stripe";
import Stripe from "stripe";

type PaymentStore = Prisma.TransactionClient | typeof prisma;

type StripeReference = string | { id?: string | null } | null | undefined;

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

const CAPTURED_TRANSACTION_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
]);

const EXCLUDED_LEDGER_REFUND_STATUSES = ["failed", "canceled"];

function stripeReferenceId(reference: StripeReference) {
  if (!reference) {
    return null;
  }

  if (typeof reference === "string") {
    return reference;
  }

  return reference.id ?? null;
}

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

function isCapturedTransactionStatus(status: PaymentStatus) {
  return CAPTURED_TRANSACTION_STATUSES.has(status);
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

function boundedRefundedAmountCents(
  amountCents: number,
  ...candidates: number[]
) {
  return Math.min(amountCents, Math.max(0, ...candidates));
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
  const latestAdditional = getLatestTransaction(
    payment.transactions,
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
  const latestPrimaryStripeIntentId =
    latestPrimary && isStripeTransaction(latestPrimary)
      ? latestPrimary.stripePaymentIntentId
      : null;
  const latestPrimaryStripePaymentMethodId =
    latestPrimaryStripeIntentId && latestPrimary
      ? latestPrimary.paymentMethodId ?? null
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

export async function recordStripeRefundLedgerEntry({
  paymentId,
  paymentTransactionId,
  refund,
  fallbackChargeId,
  fallbackPaymentIntentId,
  store = prisma,
}: {
  paymentId: string;
  paymentTransactionId?: string | null;
  refund: StripeRefundLedgerInput;
  fallbackChargeId?: string | null;
  fallbackPaymentIntentId?: string | null;
  store?: PaymentStore;
}) {
  const stripeChargeId = stripeReferenceId(refund.charge) ?? fallbackChargeId ?? null;
  const stripePaymentIntentId =
    stripeReferenceId(refund.payment_intent) ?? fallbackPaymentIntentId ?? null;
  const stripeCreatedAt = stripeCreatedAtToDate(refund.created);
  const existingRefund = await store.paymentRefund.findUnique({
    where: { stripeRefundId: refund.id },
    select: { id: true },
  });
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

  await store.paymentRefund.upsert({
    where: { stripeRefundId: refund.id },
    create: {
      ...data,
      stripeRefundId: refund.id,
    },
    update: data,
  });

  return {
    created: !existingRefund,
    amountCents: refund.amount,
  };
}

export async function sumRecordedRefundsForTransaction(
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

export async function syncRefundedAmountFromStripe({
  paymentIntentId,
  refundedAmountCents,
  store = prisma,
}: {
  paymentIntentId: string;
  refundedAmountCents: number;
  store?: PaymentStore;
}) {
  const transaction = await findPaymentTransactionByIntentId({
    paymentIntentId,
    store,
  });
  if (!transaction) {
    return null;
  }

  const paymentBeforeUpdate = await store.payment.findUnique({
    where: { id: transaction.paymentId },
    select: { refundedAmountCents: true },
  });

  const nextRefundedAmountCents = boundedRefundedAmountCents(
    transaction.amountCents,
    transaction.refundedAmountCents,
    refundedAmountCents
  );

  await store.paymentTransaction.update({
    where: { id: transaction.id },
    data: {
      refundedAmountCents: nextRefundedAmountCents,
      status: applyRefundStatus(
        PaymentStatus.SUCCEEDED,
        transaction.amountCents,
        nextRefundedAmountCents
      ),
    },
  });

  const payment = await reconcilePaymentAggregates({
    paymentId: transaction.paymentId,
    store,
  });

  return {
    payment,
    refundDeltaCents: Math.max(
      (payment?.refundedAmountCents ?? 0) -
        (paymentBeforeUpdate?.refundedAmountCents ?? 0),
      0
    ),
    paymentId: transaction.paymentId,
    transactionId: transaction.id,
  };
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

  const paymentBeforeUpdate = await store.payment.findUnique({
    where: { id: transaction.paymentId },
    select: { refundedAmountCents: true },
  });

  let createdRefundsCount = 0;
  let createdRefundAmountCents = 0;
  for (const refund of refunds) {
    const recordedRefund = await recordStripeRefundLedgerEntry({
      paymentId: transaction.paymentId,
      paymentTransactionId: transaction.id,
      refund,
      fallbackChargeId: stripeChargeId,
      fallbackPaymentIntentId: paymentIntentId,
      store,
    });

    if (recordedRefund.created) {
      createdRefundsCount += 1;
      createdRefundAmountCents += recordedRefund.amountCents;
    }
  }

  const ledgerRefundedAmountCents = await sumRecordedRefundsForTransaction(
    store,
    transaction.id
  );
  const nextRefundedAmountCents = boundedRefundedAmountCents(
    transaction.amountCents,
    transaction.refundedAmountCents,
    refundedAmountCents,
    ledgerRefundedAmountCents
  );

  await store.paymentTransaction.update({
    where: { id: transaction.id },
    data: {
      refundedAmountCents: nextRefundedAmountCents,
      status: applyRefundStatus(
        PaymentStatus.SUCCEEDED,
        transaction.amountCents,
        nextRefundedAmountCents
      ),
    },
  });

  const payment = await reconcilePaymentAggregates({
    paymentId: transaction.paymentId,
    store,
  });

  return {
    payment,
    refundDeltaCents: Math.max(
      (payment?.refundedAmountCents ?? 0) -
        (paymentBeforeUpdate?.refundedAmountCents ?? 0),
      0
    ),
    paymentId: transaction.paymentId,
    transactionId: transaction.id,
    createdRefundsCount,
    createdRefundAmountCents,
    ledgerRefundedAmountCents,
  };
}

export async function refundPaymentTransactions({
  paymentId,
  amountCents,
  reason = "requested_by_customer",
  metadata,
  idempotencyKeyPrefix,
  store = prisma,
}: {
  paymentId: string;
  amountCents: number;
  reason?: Stripe.RefundCreateParams.Reason;
  metadata?: Record<string, string>;
  idempotencyKeyPrefix?: string;
  store?: PaymentStore;
}) {
  const payment = await ensurePaymentTransactionsBackfilled(store, paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const refundableTransactions = [...payment.transactions]
    .filter((transaction) => isStripeTransaction(transaction))
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
    throw new Error("Refund amount exceeds captured Stripe payments");
  }

  let remainingAmountCents = amountCents;
  const refunds: Array<{
    paymentIntentId: string;
    refundId: string;
    amountCents: number;
  }> = [];

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

    const refund = await processRefund({
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: refundAmountForTransaction,
      reason:
        typeof reason === "string" ? reason : "requested_by_customer",
      metadata,
      idempotencyKey: idempotencyKeyPrefix
        ? `${idempotencyKeyPrefix}_${transaction.id}_${refundAmountForTransaction}`
        : undefined,
    });

    await recordStripeRefundLedgerEntry({
      paymentId,
      paymentTransactionId: transaction.id,
      refund,
      fallbackPaymentIntentId: transaction.stripePaymentIntentId,
      store,
    });

    const ledgerRefundedAmountCents = await sumRecordedRefundsForTransaction(
      store,
      transaction.id
    );
    const nextRefundedAmountCents = boundedRefundedAmountCents(
      transaction.amountCents,
      transaction.refundedAmountCents,
      ledgerRefundedAmountCents
    );
    await store.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        refundedAmountCents: nextRefundedAmountCents,
        status: applyRefundStatus(
          PaymentStatus.SUCCEEDED,
          transaction.amountCents,
          nextRefundedAmountCents
        ),
      },
    });
    await reconcilePaymentAggregates({ paymentId, store });

    refunds.push({
      paymentIntentId: transaction.stripePaymentIntentId,
      refundId: refund.id,
      amountCents: refund.amount,
    });
    remainingAmountCents -= refundAmountForTransaction;
  }

  if (remainingAmountCents > 0) {
    throw new Error(
      `Refund partially processed; ${remainingAmountCents} cents still need manual reconciliation`
    );
  }

  return {
    refunds,
    totalRefundedAmountCents: amountCents,
  };
}

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
    throw new Error("Refund amount exceeds captured Stripe payments");
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

    await store.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        refundedAmountCents: nextRefundedAmountCents,
        status: applyRefundStatus(
          PaymentStatus.SUCCEEDED,
          transaction.amountCents,
          nextRefundedAmountCents
        ),
      },
    });
    remainingAmountCents -= refundAmountForTransaction;
  }

  await reconcilePaymentAggregates({ paymentId, store });
}
