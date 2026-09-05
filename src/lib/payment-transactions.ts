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

type PaymentStore = Prisma.TransactionClient | typeof prisma;

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

/**
 * #3170 exported this. "Has this transaction's money actually been taken?" had
 * three inline spellings in this file and a fourth was about to be written in
 * `edit-financial-review-charge.ts`, which has to know whether an edit's combined
 * charge request has already been PAID before it lets another share be added to
 * it. `INV-SSOT`: one definition, imported.
 */
export function isCapturedTransactionStatus(status: PaymentStatus) {
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
  cause: unknown;

  constructor({
    completedRefundCents,
    refunds,
    cause,
  }: {
    completedRefundCents: number;
    refunds: PartialRefundError["refunds"];
    cause: unknown;
  }) {
    super(
      `Refund failed after ${completedRefundCents} cents were refunded and recorded: ${
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
      });
    }

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
