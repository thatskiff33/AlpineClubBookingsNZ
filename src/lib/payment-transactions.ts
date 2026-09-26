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
import { compareOrdinal } from "@/lib/ordinal-order";
import { withStoreTransaction } from "@/lib/db-transaction";
import { decodeRawRows } from "@/lib/raw-sql-rows";
import { z } from "zod";
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
  let reversedCents = 0;
  if (inserted.count === 0) {
    if (!isRecordedRefundStatus(data.status)) {
      // #3640: a counted refund Stripe now reports failed or cancelled returned
      // no money, so the mirror takes it back out. The transition is decided by
      // this guarded write, so exactly one writer sees it and subtracts.
      const reversed = await store.paymentRefund.updateMany({
        where: {
          stripeRefundId: refund.id,
          status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES },
        },
        data,
      });
      if (reversed.count === 1) {
        reversedCents = refund.amount;
      }
    }
    if (reversedCents === 0) {
      await store.paymentRefund.update({
        where: { stripeRefundId: refund.id },
        data,
      });
    }
  }

  return {
    created: inserted.count > 0,
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
async function compareAndSetRefundedAmount(
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
    (row) =>
      row.refundedAmountCents +
      Math.min(
        Math.max(row.amountCents - row.refundedAmountCents, 0),
        Math.max(amountCents, 0)
      ),
    options
  );
  return nextCents - previousCents;
}

/**
 * The migration that shipped the first `PaymentRefund` writers (ebd633858,
 * 2026-05-09): before it finished on an install, no writer recorded a row.
 */
const REFUND_LEDGER_WRITERS_MIGRATION = "20260509090000_enrich_payment_refund_ledger";

const REFUND_LEDGER_START_ROW = z.object({ finished_at: z.date() });

/**
 * When the refund ledger's writers arrived on THIS install, in whole seconds
 * (#3640, `INV-PAY-104`): the `finished_at` of `REFUND_LEDGER_WRITERS_MIGRATION`.
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
 * A one-row lookup, read raw because no Prisma model covers `_prisma_migrations`
 * (`INV-OPS-001`: the row is decoded, never cast).
 */
async function refundLedgerStartSeconds(db: PaymentStore): Promise<number | null> {
  const rows = await db.$queryRaw`
    SELECT "finished_at" FROM "_prisma_migrations"
    WHERE "migration_name" = ${REFUND_LEDGER_WRITERS_MIGRATION}
      AND "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
    ORDER BY "finished_at" ASC
    LIMIT 1
  `;
  const [row] = decodeRawRows(rows, REFUND_LEDGER_START_ROW, "refund ledger start");
  return row ? Math.floor(row.finished_at.getTime() / 1000) : null;
}

/**
 * #3640 - THE one way a Stripe card refund reaches a transaction's
 * `refundedAmountCents` mirror (`INV-PAY-104`, `INV-SSOT`). The inline refund,
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
 *   guarded write in `recordStripeRefundLedgerEntry`). Limit: where card plus
 *   credit had exceeded the captured amount the mirror was capped, and the
 *   subtraction can take it below the credit left; the audit lists such rows.
 *
 * The card refunds on record - and, from the webhook, Stripe's own
 * `amount_refunded` - remain a FLOOR, never the value: the mirror never reads
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
 *   no delta and queues no Xero note. Lock order: refund rows, then the
 *   transaction row, then the payment row - the order every other writer of the
 *   two rows takes.
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
  return withStoreTransaction(store, async (db) => {
    const ledgerStartSeconds = await refundLedgerStartSeconds(db);
    let createdRefundsCount = 0;
    let createdRefundAmountCents = 0;
    let newlyCountedCents = 0;
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
      if (!recorded.created) {
        continue;
      }
      createdRefundsCount += 1;
      createdRefundAmountCents += recorded.amountCents;
      const predatesLedger =
        ledgerStartSeconds !== null &&
        typeof refund.created === "number" &&
        refund.created < ledgerStartSeconds;
      if (isRecordedRefundStatus(recorded.status) && !predatesLedger) {
        newlyCountedCents += recorded.amountCents;
      }
    }

    const ledgerRefundedAmountCents = await sumRecordedRefundsForTransaction(
      db,
      paymentTransactionId
    );

    const { previousCents, nextCents } = await compareAndSetRefundedAmount(
      db,
      paymentTransactionId,
      (row) =>
        Math.min(
          row.amountCents,
          Math.max(
            row.refundedAmountCents + newlyCountedCents - reversedCents,
            ledgerRefundedAmountCents,
            stripeRefundedAmountCents,
            0
          )
        ),
      { writeStatus: true }
    );

    const payment = await reconcilePaymentAggregates({ paymentId, store: db });

    return {
      payment,
      createdRefundsCount,
      createdRefundAmountCents,
      ledgerRefundedAmountCents,
      refundedAmountCents: nextCents,
      appliedCents: nextCents - previousCents,
    };
  });
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
  store = prisma,
}: {
  paymentId: string;
  amountCents: number;
  store?: PaymentStore;
}) {
  await withStoreTransaction(store, async (db) => {
    const payment = await ensurePaymentTransactionsBackfilled(db, paymentId);
    if (!payment) {
      throw new Error("Payment not found");
    }

    const capturedTransactions = [...payment.transactions]
      .filter((transaction) => isCapturedTransactionStatus(transaction.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const totalRefundableCents = capturedTransactions.reduce(
      (sum, transaction) =>
        sum + Math.max(transaction.amountCents - transaction.refundedAmountCents, 0),
      0
    );
    if (amountCents > totalRefundableCents) {
      throw new Error("Refund amount exceeds captured payments");
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
