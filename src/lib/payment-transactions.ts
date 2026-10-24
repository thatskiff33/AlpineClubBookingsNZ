import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { refundSliceStripeIdempotencyKey } from "@/lib/payment-recovery-keys";
import { processRefund } from "@/lib/stripe";
import { stripeReferenceId, type StripeReference } from "@/lib/stripe-references";
import Stripe from "stripe";
import { formatCents } from "@/lib/utils";
import { compareOrdinal } from "@/lib/ordinal-order";
import { isRootPrismaClient, withStoreTransaction } from "@/lib/db-transaction";
import {
  alertFailedLaterCardRefunds,
  keepFailedLaterCardRefundsOwed,
  type FailedLaterCardRefundDebt,
  type FailedLaterKind,
} from "@/lib/card-refund-failed-later";
import { readMigrationFinishedAt } from "@/lib/migration-finished-at";
import { alertCardRefundCapOverflow, readCardRefundCapOverflow, type CardRefundCapOverflow } from "@/lib/card-refund-cap-overflow";
import logger from "@/lib/logger";
import { IntentLedgerRowOnAnotherPaymentError, writePaymentIntentTransaction } from "@/lib/payment-intent-ledger-row-write";
import { accountCreditDispositionCents } from "@/lib/stripe-cash-refund-evidence";
import type { ClubFormat } from "@/lib/club-format";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import { compareLedgerRowsNewestFirst, LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
// Moved to a leaf so the booking ledger's settlement sync can share them
// without an import cycle (#3581); re-exported so existing importers stand.
import {
  CAPTURED_TRANSACTION_STATUS_LIST,
  deriveAggregatePaymentStatus,
  EXCLUDED_LEDGER_REFUND_STATUSES,
  predatesRefundLedger,
  expectedRefundedFloorCents,
  grossCapturedCents,
  isCapturedTransactionStatus,
  isRecordedRefundStatus,
  isRefusedRefundStatus,
  LEGACY_ADDITIONAL_BACKFILL_REASON,
  LEGACY_PRIMARY_BACKFILL_REASON,
  latestTransactionOfKind,
} from "@/lib/payment-transaction-status";

export { isCapturedTransactionStatus };

export type PaymentStore = Prisma.TransactionClient | typeof prisma;

type StripeRefundLedgerInput = {
  id: string;
  amount: number;
  currency: string; // Stripe's, always set; no fallback (#3567 D4)
  status?: string | null;
  reason?: string | null;
  created?: number | null;
  charge?: StripeReference;
  payment_intent?: StripeReference;
  metadata?: Record<string, string> | null; // #4104: whose refund it is, and a retry's generation
};

function stripeCreatedAtToDate(created: number | null | undefined) {
  return created ? new Date(created * 1000) : null;
}

// Stripe's refund currency, lower-cased. Missing fails loudly rather than being
// guessed: the column has no default since #3567, and a guessed currency would
// falsify the history reconciled against Stripe and Xero.
function normalizeRefundCurrency(refundId: string, currency: string) {
  const code = typeof currency === "string" ? currency.trim().toLowerCase() : "";
  if (!code) throw new Error(`Stripe refund ${refundId} carries no currency; refusing to record it without one.`);
  return code;
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

/** The payment and its capture ledger, oldest first (`LEDGER_ROWS_OLDEST_FIRST`, #4132). Read-only. */
export async function loadPaymentWithTransactions(store: PaymentStore, paymentId: string) {
  return store.payment.findUnique({
    where: { id: paymentId },
    include: {
      transactions: {
        orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
      },
    },
  });
}

export function isStripeTransaction<
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

/**
 * The rows a pre-ledger payment's backfill writes, derived from the payment
 * alone. Pure, so the write (`ensurePaymentTransactionsBackfilled`) and the
 * cancel preview's read-only plan (#4119) see the same legacy charges.
 */
export function legacyBackfillRows(
  payment: NonNullable<Awaited<ReturnType<typeof loadPaymentWithTransactions>>>
): Array<Prisma.PaymentTransactionUncheckedCreateInput & Omit<RefundableStripeTransaction, "id" | "createdAt" | "insertionSeq">> {
  const knownIntentIds = new Set(
    payment.transactions.flatMap((transaction) =>
      transaction.stripePaymentIntentId ? [transaction.stripePaymentIntentId] : []
    )
  );
  const rows: ReturnType<typeof legacyBackfillRows> = [];

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

    rows.push({
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
      reason: LEGACY_PRIMARY_BACKFILL_REASON,
    });
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

    rows.push({
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
      reason: LEGACY_ADDITIONAL_BACKFILL_REASON,
    });
  }

  return rows;
}

export async function ensurePaymentTransactionsBackfilled(
  store: PaymentStore,
  paymentId: string
) {
  const payment = await loadPaymentWithTransactions(store, paymentId);
  if (!payment) return null;
  const rows = legacyBackfillRows(payment);
  if (rows.length === 0) return payment;
  await Promise.all(rows.map((data) => store.paymentTransaction.create({ data })));
  return loadPaymentWithTransactions(store, paymentId);
}

/**
 * Re-derive the Payment's summary columns from its ledger rows. #4217
 * (`INV-LOCK-002`): under the Payment row lock, taken BEFORE the rows are read
 * (a re-lock inside a writer that holds it), so no refund writer's commit can
 * land between the read and the write.
 */
export async function reconcilePaymentAggregates({
  paymentId,
  store = prisma,
}: {
  paymentId: string;
  store?: PaymentStore;
}) {
  return withStoreTransaction(store, async (db) => {
    await lockPaymentForRefundedTotal(db, paymentId);
    return reconcilePaymentAggregatesUnderLock(db, paymentId);
  });
}

async function reconcilePaymentAggregatesUnderLock(store: Prisma.TransactionClient, paymentId: string) {
  const payment = await ensurePaymentTransactionsBackfilled(store, paymentId);
  if (!payment) {
    return null;
  }

  const latestPrimary = latestTransactionOfKind(
    payment.transactions,
    PaymentTransactionKind.PRIMARY
  );
  // #3528 (`INV-ADDPAY-040`): a request an officer WITHDREW is no longer the
  // live ask. It stays in the ledger - FAILED, intent cancelled, `withdrawnAt`
  // stamped - but the projection reads past it, so the summary columns derive
  // zero rather than the FAILED-but-still-owed shape a declined card keeps.
  // Excluded here, at the one place the columns are derived, so the webhook
  // that follows the cancel cannot resurrect what the withdrawal retired.
  const latestAdditional = latestTransactionOfKind(
    payment.transactions.filter((transaction) => transaction.withdrawnAt === null),
    PaymentTransactionKind.ADDITIONAL
  );

  const grossCapturedAmountCents = grossCapturedCents(payment.transactions);
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

/**
 * #4217: the intent's row, or else the payment whose pointer names the intent -
 * read WITHOUT writing. The one lookup both `findPaymentTransactionByIntentId`
 * (which then backfills a pre-ledger payment) and the `mark…` writers' pure
 * read (which then lock that payment) start from.
 */
async function locateIntent(store: PaymentStore, paymentIntentId: string) {
  const transaction = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  });
  if (transaction) return { transaction, paymentId: transaction.paymentId };
  const payment = await findPaymentByIntentPointer(store, paymentIntentId);
  return payment ? { transaction: null, paymentId: payment.id } : null;
}

export async function findPaymentTransactionByIntentId({
  paymentIntentId,
  store = prisma,
}: {
  paymentIntentId: string;
  store?: PaymentStore;
}) {
  const located = await locateIntent(store, paymentIntentId);
  if (!located) return null;
  if (located.transaction) return located.transaction;

  // A pre-ledger payment: its rows are backfilled, then the intent's is read.
  await ensurePaymentTransactionsBackfilled(store, located.paymentId);
  return store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  });
}

// #3653: exported for the organiser child's refund out of the COMBINED charge,
// which has no transaction row to pass (`paymentTransactionId: null`).
export async function recordStripeRefundLedgerEntry({
  paymentId,
  paymentTransactionId,
  refund,
  fallbackChargeId,
  fallbackPaymentIntentId,
  store,
}: {
  paymentId: string;
  paymentTransactionId: string | null;
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
    currency: normalizeRefundCurrency(refund.id, refund.currency),
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
  let reversedCents = 0;
  let failedLater: FailedLaterKind | null = null;
  if (inserted.count === 0) {
    // The refresh is guarded on the row still being COUNTED, for two reasons:
    //
    // - Stripe's `failed` and `canceled` are final, so a row in either is never
    //   moved back. An idempotent retry of the inline refund gets Stripe's
    //   ORIGINAL response for 24 hours - a stale `succeeded` - and an unguarded
    //   write resurrected the failed row, so the next sync saw it fail again
    //   and subtracted it twice (#3640 delta review, D3).
    // - When the incoming status is failed or cancelled, this write IS the
    //   counted -> excluded transition, so exactly one writer sees it and the
    //   mirror takes that refund back out once.
    const refreshed = await store.paymentRefund.updateMany({
      where: {
        stripeRefundId: refund.id,
        status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES },
      },
      data,
    });
    if (refreshed.count === 1 && !isRecordedRefundStatus(data.status)) {
      reversedCents = refund.amount;
    }
    // #4104: seen failed after it counted - that write, or a caller told it counts (a replayed key) that the row holds refused.
    failedLater = reversedCents > 0 ? "transition" : refreshed.count === 0 && isRecordedRefundStatus(data.status) ? "replayed" : null;
  }

  return {
    created: inserted.count > 0,
    failedLater,
    reversedCents,
    amountCents: refund.amount,
    status: data.status,
  };
}

/** Re-reads the refund mirror's compare-and-set allows before failing loud. */
const REFUND_MIRROR_CAS_ATTEMPTS = 5;

/**
 * The one compare-and-set loop behind every write of a transaction's
 * `refundedAmountCents` after its row exists (#3640; the #3032 discipline): the
 * card-refund writer, the #1491 fold and the account-credit allocation all go
 * through here. It reads the row, computes the next value from what it read,
 * writes it only while the row still holds that value, and on a miss re-reads
 * and recomputes - so the caller's rule (a headroom cap, a floor) is re-checked
 * against the fresh value on every attempt. It never writes a stale absolute
 * value, so a concurrent writer's change survives.
 *
 * `writeStatus` re-derives the row's refund status from the new value; the
 * #1491 fold leaves status alone, as it always has. Exhausting the attempts
 * throws: loud, and inside a transaction, so nothing half-written commits.
 */
export async function compareAndSetRefundedAmount(
  db: PaymentStore,
  paymentTransactionId: string,
  nextFrom: (row: { amountCents: number; refundedAmountCents: number }) => number,
  { writeStatus }: { writeStatus: boolean }
): Promise<{ previousCents: number; nextCents: number }> {
  for (let attempt = 0; attempt < REFUND_MIRROR_CAS_ATTEMPTS; attempt += 1) {
    const current = await db.paymentTransaction.findUnique({
      where: { id: paymentTransactionId },
      select: { amountCents: true, refundedAmountCents: true },
    });
    if (!current) {
      throw new Error(`Payment transaction ${paymentTransactionId} not found`);
    }
    const nextCents = nextFrom(current);
    const claimed = await db.paymentTransaction.updateMany({
      where: {
        id: paymentTransactionId,
        refundedAmountCents: current.refundedAmountCents,
      },
      data: writeStatus
        ? {
            refundedAmountCents: nextCents,
            status: applyRefundStatus(
              PaymentStatus.SUCCEEDED,
              current.amountCents,
              nextCents
            ),
          }
        : { refundedAmountCents: nextCents },
    });
    if (claimed.count === 1) {
      return { previousCents: current.refundedAmountCents, nextCents };
    }
  }

  throw new Error(
    `Refund mirror for payment transaction ${paymentTransactionId} kept moving under ${REFUND_MIRROR_CAS_ATTEMPTS} compare-and-set attempts`
  );
}

/**
 * Add up to `amountCents` to one row, capped at that row's headroom as it is
 * on the attempt that wins. Returns the cents actually placed. Shared by the
 * #1491 fold and the account-credit allocation (`INV-SSOT`).
 */
async function addWithinHeadroom(
  db: PaymentStore,
  paymentTransactionId: string,
  amountCents: number,
  options: { writeStatus: boolean }
): Promise<number> {
  const { previousCents, nextCents } = await compareAndSetRefundedAmount(
    db,
    paymentTransactionId,
    (row) => row.refundedAmountCents + refundHeadroomIncrementCents(row, amountCents),
    options
  );
  return nextCents - previousCents;
}

/** What of `amountCents` a captured row's refunded total can still take: capped at its headroom. Pure (#4119: the cancel preview's in-memory fold). */
export function refundHeadroomIncrementCents(row: { amountCents: number; refundedAmountCents: number }, amountCents: number): number {
  return Math.min(Math.max(row.amountCents - row.refundedAmountCents, 0), Math.max(amountCents, 0));
}

/**
 * The migration that shipped the first `PaymentRefund` writers (ebd633858,
 * 2026-05-09): before it finished on an install, no writer recorded a row.
 */
const REFUND_LEDGER_WRITERS_MIGRATION = "20260509090000_enrich_payment_refund_ledger";


/**
 * #3640: THE lock order for a payment's refunded total - the `Payment` row
 * FIRST, then its `PaymentRefund` rows, then its `PaymentTransaction` row(s).
 * Every writer of the transaction mirror takes it here before touching
 * anything else: the card-refund writer, `applyLocalRefundAllocation`, and the
 * cancel claim (before #1491's fold). Without it the writer took transaction
 * row -> Payment row (its aggregate) while a cancel with an unpaid top-up took
 * Payment row -> transaction row (#3640 delta review, D1): a deadlock.
 *
 * `FOR NO KEY UPDATE` - the strength an ordinary UPDATE of the row takes - so
 * it does not block a `PaymentRefund` insert's foreign-key check (`FOR KEY
 * SHARE`) on the same payment. "Lock raw, read typed" (`INV-OPS-001`): nothing
 * is read back here.
 */
export async function lockPaymentForRefundedTotal(
  db: Pick<Prisma.TransactionClient, "$executeRaw">,
  paymentId: string
): Promise<void> {
  await db.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${paymentId} FOR NO KEY UPDATE`;
}

/**
 * #3640 (delta review, D2): the lowest a counted -> failed subtraction may take
 * one transaction's mirror to. The payment as a whole must still hold its
 * account-credit dispositions plus the card refunds still counted - the same
 * floor the refunded-total audit reports against (`expectedRefundedFloorCents`)
 * - less what its other transactions already carry.
 *
 * Why it is needed. A card refund recorded by the OLD max-based arithmetic on a
 * transaction that also held a credit never entered the mirror ($100 credit,
 * $50 card refund, mirror $100). If that refund later fails, subtracting it
 * would take the mirror to $50 and overstate the headroom by $50 - the over-
 * refund #3640 closes. The floor keeps it at $100.
 */
async function reversalFloorForTransaction(
  db: PaymentStore,
  paymentId: string,
  paymentTransactionId: string
): Promise<number> {
  const payment = await loadPaymentWithTransactions(db, paymentId);
  if (!payment) {
    return 0;
  }
  const counted = await db.paymentRefund.aggregate({
    where: {
      paymentId,
      status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES },
    },
    _sum: { amountCents: true },
  });
  const paymentFloorCents = expectedRefundedFloorCents({
    amountCents: payment.transactions
      .filter((transaction) => isCapturedTransactionStatus(transaction.status))
      .reduce((sum, transaction) => sum + transaction.amountCents, 0),
    cardRefundCents: counted._sum.amountCents ?? 0,
    accountCreditCents: await accountCreditDispositionCents(db, payment.bookingId),
  });
  const otherTransactionsCents = payment.transactions
    .filter((transaction) => transaction.id !== paymentTransactionId)
    .reduce((sum, transaction) => sum + transaction.refundedAmountCents, 0);
  return Math.max(paymentFloorCents - otherTransactionsCents, 0);
}

/**
 * When the refund ledger's writers arrived on THIS install, in whole seconds
 * (#3640, `INV-PAY-103`): the `finished_at` of `REFUND_LEDGER_WRITERS_MIGRATION`.
 * Null when that migration has no finished row, which means the install never
 * ran pre-ledger code against this database.
 *
 * Why it matters. The ledger has no backfill, and the old max-based total had
 * already folded older card refunds into the mirror through Stripe's
 * `amount_refunded`. A `charge.refunded` sync lists EVERY refund on the charge,
 * so the first sync after such a refund inserts its row for the first time -
 * and "newly recorded" must not mean "newly refunded" for it. Every writer since
 * this migration records its row as it counts the refund, so a refund Stripe
 * made before it, arriving rowless, is one the mirror already counts.
 *
 * A fact of the install, not a guess from the data: on a fresh install it is the
 * install itself, so no refund the install ever saw is pre-ledger. Compared in
 * whole seconds because Stripe's `created` is. The one window it cannot see is
 * the blue/green overlap after the migration, while the old image still served;
 * a refund made there is counted twice (safe direction: the member is
 * under-refunded, never over-refunded; the Xero note is capped by cash evidence).
 *
 * Read through the one reader of migration history (`readMigrationFinishedAt`).
 */
export async function refundLedgerStartSeconds(db: PaymentStore): Promise<number | null> {
  // A database built with `prisma db push` (a dev convenience) has no
  // migration history; it never ran pre-ledger code either, so it reads like
  // a missing row (#3640 delta review, D4). Production, CI and e2e all `migrate deploy`.
  const started = await readMigrationFinishedAt(db, REFUND_LEDGER_WRITERS_MIGRATION);
  if (!started.history) {
    logger.warn(
      "No _prisma_migrations table: treating every card refund as made since the refund ledger started (#3640)"
    );
    return null;
  }
  return started.finishedAtSeconds;
}

/**
 * #3640 - THE one way a Stripe card refund reaches a transaction's
 * `refundedAmountCents` mirror (`INV-PAY-103`, `INV-SSOT`). The inline refund,
 * the `charge.refunded` webhook sync and the superseded-payment refund recovery
 * all write through here.
 *
 * ## The refund is ADDED, never maxed
 *
 * The mirror counts BOTH dispositions - card refunds and account-credit
 * settlements (`applyLocalRefundAllocation`, which writes no `PaymentRefund`
 * row; see `stripe-cash-refund-evidence.ts`). It used to be set to
 * `max(stored, card refunds on record)`, so a card refund made AFTER a credit
 * vanished: $100 credit then a $50 card refund read $100, not $150, and a later
 * 100%-tier cancel paid $450 against $400 taken. Now:
 *
 * - a refund this call NEWLY recorded, in a counted status
 *   (`isRecordedRefundStatus`), made since the install's refund ledger started
 *   (`refundLedgerStartSeconds`), is ADDED. A replay records nothing new and adds
 *   nothing; a pre-ledger refund getting its first row adds nothing.
 * - a counted refund this call sees move to failed or cancelled is SUBTRACTED:
 *   no money went back after all. Exactly one writer sees the transition (a
 *   guarded write in `recordStripeRefundLedgerEntry`), and the subtraction never
 *   takes the payment below its account credit plus the card refunds still
 *   counted (`reversalFloorForTransaction`) - so a refund the OLD arithmetic
 *   never added cannot be taken out of money that was never its.
 *
 * The card refunds on record remain a FLOOR, never the value (#4104: Stripe's
 * own `amount_refunded` no longer is - the sync reads every refund live, and a
 * snapshot from before a refund failed would undo it): the mirror never reads
 * below the cash the card has demonstrably returned. For a transaction with no
 * credit on it, that also lifts a row a pre-#3640 crash left between its ledger
 * row and its mirror write; with a credit the floor cannot, and the refunded-
 * total audit lists it. Capped at the transaction's captured amount.
 *
 * ## Why it cannot lose or double a change
 *
 * - `created` and the reversal are answered by guarded writes, so two writers
 *   recording one refund cannot both apply it.
 * - The mirror write is `compareAndSetRefundedAmount`, re-read and retried.
 * - The ledger rows, the mirror, AND the payment aggregate with its booking-
 *   ledger lines commit TOGETHER (`withStoreTransaction`): a crash before the
 *   aggregate would otherwise leave a retry that records nothing new, reports
 *   no delta and queues no Xero note. Lock order: the Payment row FIRST
 *   (`lockPaymentForRefundedTotal`), then refund rows, then the transaction
 *   row - the one order every writer of the mirror takes - then, for a refund
 *   seen failing after it counted, its `PaymentRecoveryOperation` (#4104).
 * - Refunds are inserted in id order, so two writers inserting overlapping sets
 *   take the unique-index locks in one order.
 *
 * Returns `appliedCents`, how far THIS call moved the mirror (signed), and the
 * reconciled `payment`.
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
  const recorded = await withStoreTransaction(store, async (db) => {
    await lockPaymentForRefundedTotal(db, paymentId);
    const ledgerStartSeconds = await refundLedgerStartSeconds(db);
    const failedLater: Array<{ refund: StripeRefundLedgerInput; kind: FailedLaterKind }> = [];
    let createdRefundsCount = 0;
    let createdRefundAmountCents = 0;
    let newlyCountedCents = 0;
    const newlyCountedRefundIds: string[] = []; // #4312: which refunds those are, for a bank transfer's own notes
    let reversedCents = 0;
    const ordered = [...refunds].sort((a, b) => compareOrdinal(a.id, b.id));
    for (const refund of ordered) {
      const recorded = await recordStripeRefundLedgerEntry({
        paymentId,
        paymentTransactionId,
        refund,
        fallbackChargeId,
        fallbackPaymentIntentId,
        store: db,
      });
      reversedCents += recorded.reversedCents;
      if (recorded.failedLater) failedLater.push({ refund, kind: recorded.failedLater });
      if (!recorded.created) {
        continue;
      }
      createdRefundsCount += 1;
      createdRefundAmountCents += recorded.amountCents;
      // An undated refund counts as new here: only a dated pre-ledger one was already folded in.
      if (isRecordedRefundStatus(recorded.status) && !predatesRefundLedger(refund.created, ledgerStartSeconds, "since-ledger")) {
        newlyCountedCents += recorded.amountCents;
        newlyCountedRefundIds.push(refund.id);
      }
    }

    const ledgerRefundedAmountCents = await sumRecordedRefundsForTransaction(
      db,
      paymentTransactionId
    );

    const reversalFloorCents =
      reversedCents > 0
        ? await reversalFloorForTransaction(db, paymentId, paymentTransactionId)
        : 0;

    // #4104 review (ML4): Stripe's cumulative `amount_refunded` is no longer a
    // floor. The sync records every refund Stripe lists for the charge, read
    // live, so the ledger floor above already holds each one that counts; the
    // event's figure is a snapshot, and one taken before a refund failed would
    // lift the total back up. Above the ledger it is only logged.
    if (stripeRefundedAmountCents > ledgerRefundedAmountCents) {
      logger.info(
        { paymentId, paymentTransactionId, stripeRefundedAmountCents, ledgerRefundedAmountCents },
        "Stripe's refunded figure is above the card refunds on record; the refunds on record stand (#4104)",
      );
    }
    let discardedCents = 0;
    const { previousCents, nextCents } = await compareAndSetRefundedAmount(
      db,
      paymentTransactionId,
      (row) => {
        const uncapped = Math.max(
          row.refundedAmountCents + newlyCountedCents - reversedCents,
          ledgerRefundedAmountCents,
          // A subtraction never goes below the payment's floor - and the
          // floor never RAISES a mirror (that would be the repair the audit
          // leaves to a person).
          Math.min(row.refundedAmountCents, reversalFloorCents),
          0
        );
        discardedCents = Math.max(0, uncapped - row.amountCents);
        return Math.min(row.amountCents, uncapped);
      },
      { writeStatus: true }
    );
    const capOverflow = await readCardRefundCapOverflow(db, { paymentId, paymentTransactionId, discardedCents, recordedRefundCents: ledgerRefundedAmountCents, previousCents, nextCents }); // #4154 M1, F2: logged; the officers alerted after the commit

    const payment = await reconcilePaymentAggregates({ paymentId, store: db });

    // #4104 (`INV-PAY-128`): a refund seen failing after it counted is owed again, in this transaction.
    const { debts: failedLaterDebts, readAsRefused } = await keepFailedLaterCardRefundsOwed(db, { paymentId, paymentTransactionId, seen: failedLater, fallbackPaymentIntentId });

    return {
      payment,
      createdRefundsCount,
      createdRefundAmountCents,
      ledgerRefundedAmountCents,
      refundedAmountCents: nextCents,
      appliedCents: nextCents - previousCents,
      newlyCountedRefundIds,
      failedLaterDebts,
      /** #4104: refunds its caller was told counted that a row it is moving owns; the caller reads them as refused. */
      readAsRefused,
      /** #4159 review round 2 (F2): refund money the charge's total could not hold, or null. */
      capOverflow,
    };
  });
  // Alerted once its commit is ours; joined to a caller's transaction, returned for the caller to alert after its commit.
  if (isRootPrismaClient(store)) await alertFailedLaterCardRefunds(recorded.failedLaterDebts);
  if (isRootPrismaClient(store) && recorded.capOverflow) await alertCardRefundCapOverflow(recorded.capOverflow);
  return recorded;
}

/**
 * #1491's fold, made safe (#3640): attribute up to `amountCents` of mirror-only
 * refund history (a folded modification credit note) to one captured row,
 * capped at that row's headroom, as an INCREMENT through the shared
 * compare-and-set. The cancel claim runs it under `lock(1)`, but the
 * `charge.refunded` webhook takes no lock: an absolute `read + bump` write would
 * erase a card refund the webhook committed in between. Returns the cents
 * actually attributed.
 */
export async function foldIntoTransactionRefundedAmount({
  paymentTransactionId,
  amountCents,
  store,
}: {
  paymentTransactionId: string;
  amountCents: number;
  store: PaymentStore;
}): Promise<number> {
  return addWithinHeadroom(store, paymentTransactionId, amountCents, {
    writeStatus: false,
  });
}

/** The recorded, non-refused card refunds on one charge (`EXCLUDED_LEDGER_REFUND_STATUSES`): the floor its refunded total keeps, and what #4154's correction lowers to. */
export const sumRecordedRefundsForTransaction = (store: RefundRowStore, paymentTransactionId: string) => sumRecordedRefundRows(store, { paymentTransactionId });
/** #4154 review (M2): the same, over every charge on one payment. */
export const sumRecordedRefundsForPayment = (store: RefundRowStore, paymentId: string) => sumRecordedRefundRows(store, { paymentId });
/** #4285 review: the same, on one capture by row OR intent. What its CARD still holds is its amount less this: `refundedAmountCents` also counts account credit and by-hand refunds. */
export const sumRecordedRefundsForCapture = (store: RefundRowStore, capture: { id: string; paymentIntentId: string }) => sumRecordedRefundRows(store, { OR: [{ paymentTransactionId: capture.id }, { stripePaymentIntentId: capture.paymentIntentId }] });
type RefundRowStore = Pick<PaymentStore, "paymentRefund">;
async function sumRecordedRefundRows(store: RefundRowStore, where: Prisma.PaymentRefundWhereInput): Promise<number> {
  const recorded = await store.paymentRefund.aggregate({ where: { ...where, status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES } }, _sum: { amountCents: true } });
  return recorded._sum.amountCents ?? 0;
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
  hadIssuedXeroInvoice,
  bookingModificationId,
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
  /** #3954 round 7: a mint stamps its edit's invoice answer (`unpaidAskBillingEvidence`); omitted, left alone. */
  hadIssuedXeroInvoice?: boolean;
  /** #3954 round 8: the edit whose price ask the row is, named by a reduction that retires it; omitted, left alone. #4036: given, `writePaymentIntentTransaction` keeps it to that edit's row. */
  bookingModificationId?: string;
  store?: PaymentStore;
}) {
  const provenance = { ...(hadIssuedXeroInvoice !== undefined ? { hadIssuedXeroInvoice } : {}), ...(bookingModificationId !== undefined ? { bookingModificationId } : {}) };
  const update = {
    kind, source: PaymentSource.STRIPE, amountCents, status,
    ...(paymentMethodId !== undefined ? { paymentMethodId: paymentMethodId ?? null } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(carriedAskCents !== undefined ? { carriedAskCents } : {}),
    ...provenance,
  };
  const create = {
    paymentId, kind, source: PaymentSource.STRIPE, stripePaymentIntentId: paymentIntentId, amountCents, status,
    paymentMethodId: paymentMethodId ?? undefined, reason,
    ...(carriedAskCents !== undefined ? { carriedAskCents } : {}),
    ...provenance,
  };
  // #4217 (`INV-LOCK-002`): the Payment row before the intent's row, joined to
  // the caller's transaction or in a short one of its own.
  return withStoreTransaction(store, async (db) => {
    await lockPaymentForRefundedTotal(db, paymentId);
    // #4036 review: an ask write naming its edit never lands on another edit's row; #4081: no write lowers a captured status.
    await writePaymentIntentTransaction(db, { paymentId, paymentIntentId, bookingModificationId, create, update });

    if (stripeCustomerId) {
      await db.payment.update({
        where: { id: paymentId },
        data: { stripeCustomerId },
      });
    }

    return reconcilePaymentAggregates({ paymentId, store: db });
  });
}

/**
 * #3402: write a RAISED amount onto an existing ADDITIONAL request row, and
 * nothing else. The review-charge raise used to go through
 * `upsertPaymentIntentTransaction` with `status: PENDING`, whose update branch
 * writes `status` unconditionally - so a `payment_intent.succeeded` webhook
 * landing between Stripe accepting the new amount and this write was reverted
 * to PENDING, and the row and aggregates said "unpaid" over captured money.
 *
 * So this never writes `status`, and it matches only a live (not withdrawn)
 * ADDITIONAL row that is not captured. A FAILED row (a declined card) therefore
 * KEEPS FAILED when raised, where the upsert reset it to PENDING: FAILED is the
 * ledger's "still owed" shape - uncollected for chasing and the outstanding-ask
 * readers alike - and the intent behind it stays payable, so the member is asked
 * the raised figure exactly as before. Returns false when nothing matched: the
 * member paid in that window (at the new amount - Stripe refuses to update a
 * captured intent) or an officer withdrew the request; the caller re-reads to
 * tell which. The first mint still goes through the upsert, which is what
 * creates the row PENDING.
 */
export async function writeRaisedAdditionalRequestAmount({
  paymentId,
  paymentIntentId,
  amountCents,
  carriedAskCents,
  store = prisma,
}: {
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
  /** #3371: re-stated from the ONE `AdditionalAsk` that computed `amountCents`. */
  carriedAskCents: number;
  store?: PaymentStore;
}): Promise<boolean> {
  // #4217 (`INV-LOCK-002`): the Payment row before the request's row.
  return withStoreTransaction(store, async (db) => {
    await lockPaymentForRefundedTotal(db, paymentId);
    const written = await db.paymentTransaction.updateMany({
      where: {
        paymentId,
        stripePaymentIntentId: paymentIntentId,
        kind: PaymentTransactionKind.ADDITIONAL,
        // #3528: a withdrawn request is retired for good; raising it would put a
        // figure on an ask the projection no longer reads.
        withdrawnAt: null,
        status: { notIn: [...CAPTURED_TRANSACTION_STATUS_LIST] },
      },
      data: { amountCents, carriedAskCents },
    });
    if (written.count === 0) return false;
    await reconcilePaymentAggregates({ paymentId, store: db });
    return true;
  });
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
  // #4217 (`INV-LOCK-002`): the Payment row before the receipt's row.
  return withStoreTransaction(store, async (db) => {
    await lockPaymentForRefundedTotal(db, paymentId);
    await db.paymentTransaction.create({
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

    return reconcilePaymentAggregates({ paymentId, store: db });
  });
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
  // #4217: which payment, read without writing; then that Payment row; then the
  // re-read (which may backfill a pre-ledger payment) and the write under it.
  const paymentId = await findPaymentIdForIntent(store, paymentIntentId);
  if (!paymentId) {
    return null;
  }

  return withStoreTransaction(store, async (db) => {
    await lockPaymentForRefundedTotal(db, paymentId);
    const transaction = await findPaymentTransactionForLockedPayment(db, paymentIntentId, paymentId);
    if (!transaction) {
      return null;
    }

    await db.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        amountCents,
        status: PaymentStatus.SUCCEEDED,
        ...(paymentMethodId !== undefined
          ? { paymentMethodId: paymentMethodId ?? null }
          : {}),
      },
    });

    return reconcilePaymentAggregates({ paymentId, store: db });
  });
}

export async function markPaymentIntentTransactionFailed({
  paymentIntentId,
  store = prisma,
}: {
  paymentIntentId: string;
  store?: PaymentStore;
}) {
  // #4217: as `markPaymentIntentTransactionSucceeded` - find the payment
  // without writing, lock it, re-read and write under the lock.
  const paymentId = await findPaymentIdForIntent(store, paymentIntentId);
  if (!paymentId) {
    return null;
  }

  return withStoreTransaction(store, async (db) => {
    await lockPaymentForRefundedTotal(db, paymentId);
    const transaction = await findPaymentTransactionForLockedPayment(db, paymentIntentId, paymentId);
    if (!transaction) {
      return null;
    }

    if (isCapturedTransactionStatus(transaction.status)) {
      return transaction;
    }

    // Status-guarded: a capture committed since the re-read keeps its status; the row is returned as above.
    const failed = await db.paymentTransaction.updateMany({
      where: { id: transaction.id, status: { notIn: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
      data: { status: PaymentStatus.FAILED },
    });
    if (failed.count === 0) {
      return db.paymentTransaction.findUnique({ where: { id: transaction.id } });
    }

    return reconcilePaymentAggregates({ paymentId, store: db });
  });
}

/** #4217: the intent's payment, read WITHOUT writing (`locateIntent`), so the lock comes before any backfill. */
async function findPaymentIdForIntent(store: PaymentStore, paymentIntentId: string): Promise<string | null> {
  return (await locateIntent(store, paymentIntentId))?.paymentId ?? null;
}

/**
 * #4217: the intent's row re-read under its Payment row lock. No ledger writer
 * moves a row between payments (`writePaymentIntentTransaction` is pinned to
 * the locked payment), so a row on another payment than the one the pure read
 * named - the Payment pointer naming the intent while the row sits elsewhere -
 * is an inconsistency, refused before anything is written.
 */
async function findPaymentTransactionForLockedPayment(
  db: Prisma.TransactionClient,
  paymentIntentId: string,
  lockedPaymentId: string,
) {
  const transaction = await findPaymentTransactionByIntentId({ paymentIntentId, store: db });
  if (transaction && transaction.paymentId !== lockedPaymentId) {
    throw new IntentLedgerRowOnAnotherPaymentError(paymentIntentId, lockedPaymentId, transaction.paymentId);
  }
  return transaction;
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
  const payment = recorded.payment;

  return {
    payment,
    // #3640: how far THIS sync moved the refunded total - a refund the club
    // has not already recorded, including one made after an account-credit
    // settlement, which the old max-based total swallowed and left to the
    // daily Xero reconciliation to notice.
    refundDeltaCents: Math.max(recorded.appliedCents, 0),
    paymentId: transaction.paymentId,
    transactionId: transaction.id,
    createdRefundsCount: recorded.createdRefundsCount,
    createdRefundAmountCents: recorded.createdRefundAmountCents,
    /** #4312: the refunds this sync was the first to record and count. */
    newlyCountedRefundIds: recorded.newlyCountedRefundIds,
    ledgerRefundedAmountCents: recorded.ledgerRefundedAmountCents,
    /** #4104: alerted already unless `store` was the caller's transaction. */
    failedLaterDebts: recorded.failedLaterDebts,
    capOverflow: recorded.capOverflow, // #4159 round 3 (6): alerted already unless `store` was the caller's transaction
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
  insertionSeq: number; // #4132: breaks a createdAt tie (`compareLedgerRowsNewestFirst`)
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
    .sort(compareLedgerRowsNewestFirst); // #4132 (INV-PAY-133): a tie's last-inserted row first

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

  return planCardRefundFromLedger(payment.transactions, amountCents);
}

/**
 * THE card refund plan a capture ledger carries for `amountCents`: its
 * newest-first slices and their total. Pure - the plan the cancel's claim
 * freezes (`planStripeRefundAllocation`) and the one the cancel preview quotes
 * from its in-memory ledger (#4119, `INV-PAY-131`), so the two cannot differ
 * on the same rows.
 */
export function planCardRefundFromLedger(
  transactions: readonly RefundableStripeTransaction[],
  amountCents: number
) {
  const { slices, totalRefundableCents } = buildRefundAllocationSlices(
    transactions,
    amountCents
  );
  const plan: RefundAllocationSlice[] = slices.map((slice) => ({
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
  /** #4083: the slice's key generation after Stripe refused it (`refundSliceStripeIdempotencyKey`). */
  stripeKeySuffix?: string;
  /** #4083: Stripe made it (this refund) on an attempt that met a refusal: never sent again, still this plan's. */
  madeRefundId?: string;
  /** #4104: the refunds that made this slice and that Stripe failed later, each moving it to its next key; it is still owed. */
  failedRefundIds?: string[];
  /** #4166: a failed-later row's maker of the failed refund, by its metadata (`card-refund-failed-later.ts`); null for none, absent before #4166. */
  madeByOperationId?: string | null;
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
    /** #4070, #4083: Stripe's answer and the slice as sent; `refundPaymentTransactions` always sets both. */
    status?: string | null;
    slice?: RefundAllocationSlice;
  }>;
  /** #4083: slices Stripe answered but refused before the failure; still owed. */
  refusedSlices: RefundAllocationSlice[];
  override cause: unknown;

  constructor({
    completedRefundCents,
    refunds,
    refusedSlices = [],
    cause,
    format,
  }: {
    completedRefundCents: number;
    refunds: PartialRefundError["refunds"];
    refusedSlices?: RefundAllocationSlice[];
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
    this.refusedSlices = refusedSlices;
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
    stripeKeySuffix?: string;
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
      return { transaction, amountCents: slice.amountCents, stripeKeySuffix: slice.stripeKeySuffix };
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

  // #4070: Stripe's own status rides along, so a caller can tell a refund made from one it refused;
  // #4083: with the slice as sent, so a refused one can be asked for again (`refusedRefundSlices`).
  const refunds: Array<PartialRefundError["refunds"][number] & { status: string | null; slice: RefundAllocationSlice }> = [];
  const refusedSlices: RefundAllocationSlice[] = [];
  let completedRefundCents = 0;
  const failedLaterDebts: FailedLaterCardRefundDebt[] = [];
  const capOverflows: CardRefundCapOverflow[] = [];

  for (const { transaction, amountCents: refundAmountForTransaction, stripeKeySuffix } of slices) {
    const slice: RefundAllocationSlice = { paymentTransactionId: transaction.id, amountCents: refundAmountForTransaction, ...(stripeKeySuffix ? { stripeKeySuffix } : {}) };
    let refund;
    try {
      refund = await processRefund({
        paymentIntentId: transaction.stripePaymentIntentId,
        amountCents: refundAmountForTransaction,
        reason:
          typeof reason === "string" ? reason : "requested_by_customer",
        metadata,
        idempotencyKey: idempotencyKeyPrefix
          ? refundSliceStripeIdempotencyKey(idempotencyKeyPrefix, slice)
          : undefined,
      });
    } catch (err) {
      throw new PartialRefundError({
        completedRefundCents,
        refunds,
        refusedSlices,
        cause: err,
        format,
      });
    }

    let readAsRefused = false;
    try {
      const recorded = await recordStripeRefundsAgainstTransaction({
        paymentId,
        paymentTransactionId: transaction.id,
        refunds: [refund],
        fallbackPaymentIntentId: transaction.stripePaymentIntentId,
        store,
      });
      failedLaterDebts.push(...recorded.failedLaterDebts);
      if (recorded.capOverflow) capOverflows.push(recorded.capOverflow);
      readAsRefused = recorded.readAsRefused.includes(refund.id);
    } catch (err) {
      // #3924 round 4 (C2): Stripe refunded this slice but it could not be
      // recorded. It is reported as a partial failure like a Stripe one, carrying
      // only the slices BEFORE it - the ones refunded AND recorded - so every
      // caller's recovery replays this slice under its same key (Stripe answers
      // with the original refund and the ledger records it then) and never
      // re-asks for a slice already recorded. A raw error here made the refund
      // request's route enqueue the whole plan and the edit's the whole amount.
      throw new PartialRefundError({
        completedRefundCents,
        refunds,
        refusedSlices,
        cause: err,
        format,
      });
    }

    refunds.push({
      paymentIntentId: transaction.stripePaymentIntentId,
      refundId: refund.id,
      amountCents: refund.amount,
      // #4104: a replayed key reads Stripe's original answer; the row knows it failed since.
      status: readAsRefused ? "failed" : refund.status,
      slice,
    });
    // #4083: a refused slice sent nothing back, so it is owed, never completed.
    if (readAsRefused || isRefusedRefundStatus(refund.status)) refusedSlices.push(slice);
    else completedRefundCents += refundAmountForTransaction;
  }

  if (failedLaterDebts.length > 0 && !isRootPrismaClient(store)) {
    logger.warn({ paymentId, failedLaterDebts }, "Card refunds that failed later were kept owed in the caller's transaction; the caller alerts after its commit (#4104)");
  }
  return {
    refunds,
    totalRefundedAmountCents: amountCents,
    /** #4104: decided as this call recorded its refunds; alerted already unless `store` was the caller's transaction. */
    failedLaterDebts,
    capOverflows, // #4159 round 3 (6): the same, for refund money a charge's total could not hold
  };
}

/**
 * Raised when an allocation finds the headroom it was checked against GONE:
 * another writer on the same payment (a card refund the lockless
 * `charge.refunded` webhook recorded, another allocation) used it between the
 * check and the write, so placing this amount would refund more than was
 * captured.
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
 * Raised when an allocation asks for more than the payment's captured
 * transactions still hold, before anything is written. The message is the one
 * callers already read (`settlementWriteRefusal`); the class lets a caller tell
 * this refusal from a fault without matching it (#3924 round 4, C3).
 */
export class RefundAllocationExceedsCapturedError extends Error {
  constructor() {
    super("Refund amount exceeds captured payments");
    this.name = "RefundAllocationExceedsCapturedError";
  }
}

/**
 * Mirror a refund the club made by hand - or value it held as account credit -
 * into the payment ledger.
 *
 * ## Every write is the shared COMPARE-AND-SET (#3032, #3640)
 *
 * Each slice is added through `addWithinHeadroom`: an increment re-read and
 * retried on a miss, capped at the row's headroom AS IT IS on the winning
 * attempt. Two writers on one `PaymentTransaction` therefore cannot lose an
 * update (a $30 refund and a $50 allocation leave $80, not $50, which would
 * overstate the headroom by $30).
 *
 * Who can race. The card-refund writers - the `charge.refunded` webhook and the
 * superseded-payment recovery - take NO advisory lock, so they can move a row
 * under ANY caller here, including one holding `lock(1)` (booking-cancel's
 * credit disposition, the credit writers reached from the booking-edit
 * services); so can the `EDIT_FINANCIAL_REVIEW` completion, which deliberately
 * holds no lock (#3032). A concurrent move that leaves enough headroom is simply
 * absorbed: the allocation retries against the fresh total and succeeds, so a
 * member's cancel is not rolled back because a dashboard refund landed at the
 * same moment.
 *
 * It refuses loudly - `RefundAllocationRacedError`, inside the caller's
 * transaction, which then rolls back - ONLY when the headroom is genuinely gone:
 * the concurrent writer used what this allocation needed.
 */
export async function applyLocalRefundAllocation({
  paymentId,
  amountCents,
  preferTransactionIds = [], onlyTransactionIds,
  store = prisma,
}: {
  paymentId: string;
  amountCents: number;
  /** #3372 ("Paid another way"): placed FIRST, in order - the charges an unsent card refund was for. */
  preferTransactionIds?: readonly string[];
  /** #4154: placed on these charges and no other; short of headroom there, it throws as any shortfall does. */ onlyTransactionIds?: readonly string[];
  store?: PaymentStore;
}) {
  await withStoreTransaction(store, async (db) => {
    await lockPaymentForRefundedTotal(db, paymentId);
    const payment = await ensurePaymentTransactionsBackfilled(db, paymentId);
    if (!payment) throw new Error("Payment not found");

    const preferredRank = (id: string) =>
      preferTransactionIds.includes(id) ? preferTransactionIds.indexOf(id) : preferTransactionIds.length;
    const capturedTransactions = [...payment.transactions]
      .filter((transaction) => isCapturedTransactionStatus(transaction.status) && (!onlyTransactionIds || onlyTransactionIds.includes(transaction.id)))
      .sort(
        (a, b) =>
          preferredRank(a.id) - preferredRank(b.id) ||
          compareLedgerRowsNewestFirst(a, b)
      );

    const totalRefundableCents = capturedTransactions.reduce(
      (sum, transaction) =>
        sum + Math.max(transaction.amountCents - transaction.refundedAmountCents, 0),
      0
    );
    if (amountCents > totalRefundableCents) {
      throw new RefundAllocationExceedsCapturedError();
    }

    let remainingAmountCents = amountCents;
    for (const transaction of capturedTransactions) {
      if (remainingAmountCents <= 0) {
        break;
      }
      remainingAmountCents -= await addWithinHeadroom(
        db,
        transaction.id,
        remainingAmountCents,
        { writeStatus: true }
      );
    }
    if (remainingAmountCents > 0) {
      throw new RefundAllocationRacedError();
    }

    await reconcilePaymentAggregates({ paymentId, store: db });
  });
}
