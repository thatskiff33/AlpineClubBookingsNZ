import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

// #1992 — the duplicate-capture auto-refund. The residual #1967 split-child
// window lets an in-flight /pay link PaymentIntent (client secret already in
// the member's browser) and the settlement cron's saved-card charge BOTH
// capture. markBookingPaymentSucceeded must:
//   - refund the arriving capture when it is a DIFFERENT intent from the one
//     that settled the already-PAID booking (durable enqueue-then-execute,
//     exactly the duplicate's captured amount, pinned to its own transaction);
//   - keep `already_paid` byte-identical for a SAME-intent replay from every
//     legitimate caller path (webhook redelivery, confirm-payment route,
//     payment-link reconcile, charge-saved-method rerun, cron-confirm-pending
//     rerun, create-payment-intent recovery, confirm-pending-guests retry);
//   - never refund BOTH sides when the two captures' webhooks replay (a
//     capture a duplicate-capture refund owns, by its operation's key, is
//     never counted as the settlement: `listDuplicateCaptureRefundIntentIds`);
//   - preserve the #1765 refunded-history guard, including the
//     repay-generation case (a fully REFUNDED prior capture is history, not a
//     settlement the repay duplicates).

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  // #3864: nothing to give back unless a case says so.
  giveBackAppliedCredit: vi.fn<(...args: unknown[]) => Promise<{ appliedCreditCents: number; givenBackCents: number; payment: null }>>(
    async () => ({ appliedCreditCents: 0, givenBackCents: 0, payment: null }),
  ),
  paymentUpdate: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentUpsert: vi.fn(),
  paymentTransactionFindFirst: vi.fn(),
  paymentTransactionFindUnique: vi.fn(),
  paymentTransactionFindMany: vi.fn(),
  // #4227: what the owed-again reading answers (the real one reads card refund rows).
  supersededHoldsForMember: vi.fn(),
  // #4300: what open rows owe back any part of (the settle's reading).
  supersededOwedBackAtAll: vi.fn(),
  queueSupersededPaymentIntentRefundRecovery: vi.fn(),
  paymentRecoveryOperationFindMany: vi.fn(),
  paymentRecoveryOperationFindFirst: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  findPaymentTransactionByIntentId: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  enqueueCapacityClaimFailedRefundRecovery: vi.fn(),
  markCapacityClaimFailedRefundRecoverySucceeded: vi.fn(),
  recordCapacityClaimFailedRefundRecoveryInlineError: vi.fn(),
  enqueueDuplicateCaptureRefundRecovery: vi.fn(),
  listDuplicateCaptureRefundIntentIds: vi.fn(),
  markDuplicateCaptureRefundRecoverySucceeded: vi.fn(),
  recordDuplicateCaptureRefundRecoveryInlineError: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
  sendAdminPaymentFailureAlert: vi.fn(),
  sendAdminDuplicateCaptureRefundAlert: vi.fn(),
  sendAdminDuplicateCaptureKeptAlert: vi.fn(),
  sendAdminSupersededCaptureRefusedAlert: vi.fn(),
  releaseAlertCooldown: vi.fn(),
  // #4285 review: the owed new-capture alert markers (`AlertCooldown` keys), one shared store.
  owedMarkers: new Set<string>(),
  reconcileBedAllocationsForBooking: vi.fn(),
  recordBookingEvent: vi.fn(),
  recordDuplicateCaptureRefundEvent: vi.fn(),
  lodgeFindFirst: vi.fn(),
  // #4103: the refusal's re-plan of the pre-persisted row, outside the transaction.
  recoveryUpdateMany: vi.fn(),
  recoveryFindUnique: vi.fn(),
  claimAlertCooldownFailOpen: vi.fn(),
  // #4285 review 7: the card refunds recorded against a kept capture, and the duplicate refunds still holding theirs.
  sumRecordedRefundsForCapture: vi.fn(),
  duplicateRefundsHolding: vi.fn(),
}));

// #4627: the journal half runs on PostgreSQL (`booking-ledger-journal.realdb.test.ts`), not on this fake store.
vi.mock("@/lib/member-money/doors", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/doors")),
  postBookingLedgerJournal: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mocks.transaction(...args),
    paymentRecoveryOperation: {
      updateMany: (...args: unknown[]) => mocks.recoveryUpdateMany(...args),
      findUnique: (...args: unknown[]) => mocks.recoveryFindUnique(...args),
    },
  },
}));

vi.mock("@/lib/payment-transactions", () => ({
  // #4217: the settle locks the Payment row before its ledger lookup.
  lockPaymentForRefundedTotal: async () => undefined,
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mocks.upsertPaymentIntentTransaction(...args),
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mocks.findPaymentTransactionByIntentId(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mocks.refundPaymentTransactions(...args),
  planStripeRefundAllocation: (...args: unknown[]) =>
    mocks.planStripeRefundAllocation(...args),
  sumRecordedRefundsForCapture: (...args: unknown[]) => mocks.sumRecordedRefundsForCapture(...args),
}));

vi.mock("@/lib/payment-recovery", () => ({
  enqueueCapacityClaimFailedRefundRecovery: (...args: unknown[]) =>
    mocks.enqueueCapacityClaimFailedRefundRecovery(...args),
  markCapacityClaimFailedRefundRecoverySucceeded: (...args: unknown[]) =>
    mocks.markCapacityClaimFailedRefundRecoverySucceeded(...args),
  recordCapacityClaimFailedRefundRecoveryInlineError: (...args: unknown[]) =>
    mocks.recordCapacityClaimFailedRefundRecoveryInlineError(...args),
  enqueueDuplicateCaptureRefundRecovery: (...args: unknown[]) =>
    mocks.enqueueDuplicateCaptureRefundRecovery(...args),
  markDuplicateCaptureRefundRecoverySucceeded: (...args: unknown[]) =>
    mocks.markDuplicateCaptureRefundRecoverySucceeded(...args),
  recordDuplicateCaptureRefundRecoveryInlineError: (...args: unknown[]) =>
    mocks.recordDuplicateCaptureRefundRecoveryInlineError(...args),
  // #4300: the refused superseded capture's hand-off, after the commit.
  queueSupersededPaymentIntentRefundRecovery: (...args: unknown[]) =>
    mocks.queueSupersededPaymentIntentRefundRecovery(...args),
}));

// #4211: guard (c)'s reading, shared with the Xero second-instrument conflict.
vi.mock("@/lib/duplicate-capture-ownership", () => ({
  listDuplicateCaptureRefundIntentIds: (...args: unknown[]) =>
    mocks.listDuplicateCaptureRefundIntentIds(...args),
}));

// #4211: the kept-capture alert's claim, given back when the send throws.
vi.mock("@/lib/alert-cooldown", () => ({
  releaseAlertCooldown: (...args: unknown[]) => mocks.releaseAlertCooldown(...args),
  // #4285 review: a delivered new-capture alert clears its owed marker.
  settleOwedAlert: async ({ key }: { key: string }) => void mocks.owedMarkers.delete(key),
}));

// #4211: the kept-capture alert's once-a-day window.
vi.mock("@/lib/alert-cooldown-fail-open", () => ({
  SETTLEMENT_MONEY_ALERT_REPEAT_MS: 24 * 60 * 60 * 1000,
  claimAlertCooldownFailOpen: (...args: unknown[]) => mocks.claimAlertCooldownFailOpen(...args),
}));

// #4227: the owed-again reading, real elsewhere; its own suites cover the rows it
// reads. #4300: the composed reading (`superseded-capture-ownership.ts`) stays
// real and reads it through this one seam.
vi.mock("@/lib/superseded-intent-ownership", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/superseded-intent-ownership")),
  readSupersededCaptureHolds: async (...args: unknown[]) => ({
    holdsForMember: new Set<string>(await mocks.supersededHoldsForMember(...args)),
    owedBackAtAll: new Set<string>(await mocks.supersededOwedBackAtAll(...args)),
  }),
  listDuplicateRefundIntentIdsOwningCaptures: (...args: unknown[]) => mocks.duplicateRefundsHolding(...args),
}));

vi.mock("@/lib/member-credit", () => ({
  restoreCreditFromBooking: (...args: unknown[]) =>
    mocks.restoreCreditFromBooking(...args),
  // #3864: the settle gives back credit a full-price capture left unspent.
  giveBackAppliedCredit: (...args: unknown[]) => mocks.giveBackAppliedCredit(...args),
  // #3792: the settle takes the member credit-ledger key after its lodge key.
  lockMemberCreditLedger: vi.fn().mockResolvedValue(undefined),
  deriveBookingAppliedCreditCents: (...args: unknown[]) =>
    mocks.deriveBookingAppliedCreditCents(...args),
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: (...args: unknown[]) =>
    mocks.sendAdminPaymentFailureAlert(...args),
  sendAdminSupersededCaptureRefusedAlert: (...args: unknown[]) =>
    mocks.sendAdminSupersededCaptureRefusedAlert(...args),
  sendAdminDuplicateCaptureKeptAlert: (...args: unknown[]) =>
    mocks.sendAdminDuplicateCaptureKeptAlert(...args),
  sendAdminDuplicateCaptureRefundAlert: (...args: unknown[]) =>
    mocks.sendAdminDuplicateCaptureRefundAlert(...args),
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: (...args: unknown[]) =>
    mocks.reconcileBedAllocationsForBooking(...args),
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...args: unknown[]) => mocks.recordBookingEvent(...args),
  recordDuplicateCaptureRefundEvent: (...args: unknown[]) =>
    mocks.recordDuplicateCaptureRefundEvent(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// #2576 §9. Mocked at the module boundary, like the other collaborators this suite
// already stubs. The real seam reads the booking and the lodge policy through the
// CONFIRMING transaction's client, and this suite drives that transaction with a fake
// that carries only the delegates the money path itself needs — so without this the
// enqueue throws and the settlement fails. Failing closed is the correct production
// behaviour (§8 wants the obligation to commit WITH the transition), so the fixture is
// what changes. Whether an uncovered booking becomes an incident belongs to the hosting
// suites; that this path reaches a seam at all is pinned tree-wide by
// `adult-member-hosting-call-sites.test.ts`.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: vi.fn(async () => null),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(async () => undefined),
}));


import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import {
  buildDuplicateCaptureRefundRecoveryIdempotencyKey,
  buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking,
  buildDuplicateCaptureRefundStripeKeyPrefix,
  bookingModificationRefundReasonForKeyPrefix,
  buildCapacityClaimFailedRefundRecoveryIdempotencyKey,
  duplicateCaptureIntentIdForRecoveryKey,
} from "@/lib/payment-recovery-keys";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  compareLedgerRowsOldestFirst,
  LEDGER_ROWS_OLDEST_FIRST,
} from "@/lib/payment-ledger-order";

const tx = {
  $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  $queryRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  lodge: {
    findFirst: (...args: unknown[]) => mocks.lodgeFindFirst(...args),
  },
  // #2286: the capacity engines read bed-holding hut-leader assignments
  // (custodian occupancy). None in these cases.
  hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
  // #3595: the settle asks the ledger once per booking whether its
  // confirmation is already posted, then posts through the write door.
  bookingLedgerLine: {
    findFirst: vi.fn().mockResolvedValue(null),
    createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
  },
  booking: {
    findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    findMany: (...args: unknown[]) => mocks.bookingFindMany(...args),
    updateMany: (...args: unknown[]) => mocks.bookingUpdateMany(...args),
  },
  payment: {
    upsert: (...args: unknown[]) => mocks.paymentUpsert(...args),
    update: (...args: unknown[]) => mocks.paymentUpdate(...args),
  },
  paymentTransaction: {
    findFirst: (...args: unknown[]) => mocks.paymentTransactionFindFirst(...args),
    // #4211: the released settler's own intent, read by id.
    findUnique: (...args: unknown[]) => mocks.paymentTransactionFindUnique(...args),
    // #4227: the captures the owed-again reading weighs.
    findMany: (...args: unknown[]) => mocks.paymentTransactionFindMany(...args),
  },
  // #1992 superseded-handoff exclusion: guards (b′)/(c′) read the recovery
  // operations inside the same lock(1) transaction. Deliberately NO write
  // methods here — the reconciliation path must never touch (complete, retry,
  // clobber) a superseded-machinery operation, so any write would crash a test.
  paymentRecoveryOperation: {
    findMany: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationFindMany(...args),
    findFirst: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationFindFirst(...args),
  },
  // #4285 review: the owed new-capture alert marker, read by the guard and written by the settle.
  alertCooldown: {
    findUnique: async ({ where }: { where: { key: string } }) => (mocks.owedMarkers.has(where.key) ? { key: where.key } : null),
    upsert: async ({ where }: { where: { key: string } }) => void mocks.owedMarkers.add(where.key),
  },
};

type LedgerRow = {
  id: string;
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
  /** #4177: the ledger order (`INV-PAY-133`). Defaults tie on `createdAt`; see primeLedger. */
  createdAt?: Date;
  insertionSeq?: number;
};

/** The one `createdAt` every row ties on unless a case sets its own. */
const TIED_AT = new Date("2026-06-15T00:00:00.000Z");

function ledgerRow(overrides: Partial<LedgerRow> & { id: string }): LedgerRow {
  return {
    kind: PaymentTransactionKind.PRIMARY,
    source: PaymentSource.STRIPE,
    status: PaymentStatus.SUCCEEDED,
    stripePaymentIntentId: null,
    amountCents: 10000,
    refundedAmountCents: 0,
    ...overrides,
  };
}

/**
 * True once the duplicate-capture candidate query has actually MATCHED a
 * sibling row. The `already_paid` guard tests assert this, so a mock that
 * silently stopped understanding the predicate shape would fail them loudly
 * instead of making them pass for the wrong reason.
 */
let reachedSibling = false;

/**
 * Drive both ledger lookups from one transaction list so the tests exercise
 * the REAL where-clause semantics of the duplicate-capture predicate:
 * `findFirst` honours kind/source/status filters and the arriving-intent
 * exclusion; `findPaymentTransactionByIntentId` resolves by intent id.
 *
 * The list is the PHYSICAL (heap) order. A row's ledger order is its
 * `createdAt` then `insertionSeq` (default: its position in the list). The fake
 * answers like PostgreSQL: with `orderBy: LEDGER_ROWS_OLDEST_FIRST` the oldest-
 * inserted match, with no `orderBy` the first match in heap order (#4177), and
 * any other `orderBy` throws rather than being ignored.
 */
function primeLedger(
  physicalOrder: LedgerRow[],
  /** #4211: the row the PAID claim recorded as the settler; null = paid before the record existed. */
  { settledBy = null }: { settledBy?: string | null } = {},
) {
  mocks.paymentUpsert.mockResolvedValue({ id: "payment-1", settledByTransactionId: settledBy });
  const transactions = physicalOrder.map((row, index) => ({
    ...row,
    createdAt: row.createdAt ?? TIED_AT,
    insertionSeq: row.insertionSeq ?? index + 1,
  }));
  // #2262 widened the predicate to an OR: the STRIPE arm keeps the
  // arriving-intent + superseded exclusions, and a second arm matches ANY
  // settled non-Stripe PRIMARY row (a cash settlement, or a Xero-inbound
  // internet-banking one). The mock interprets that shape rather than the old
  // flat one; interpreting only the old shape would make the `already_paid`
  // guard tests pass VACUOUSLY (no sibling would ever be returned), which is
  // why reachedSibling below is asserted by those tests.
  mocks.paymentTransactionFindFirst.mockImplementation(
    async (args: {
      orderBy?: unknown;
      where: {
        id?: string;
        kind: PaymentTransactionKind;
        status: { in: PaymentStatus[] };
        OR: Array<{
          source?: PaymentSource | { not: PaymentSource };
          stripePaymentIntentId?: { not: string; notIn: string[] };
        }>;
      };
    }) => {
      const { where } = args;
      if (
        args.orderBy !== undefined &&
        JSON.stringify(args.orderBy) !== JSON.stringify(LEDGER_ROWS_OLDEST_FIRST)
      ) {
        throw new Error(`fake ledger: unsupported orderBy ${JSON.stringify(args.orderBy)}`);
      }
      const candidates =
        args.orderBy === undefined
          ? transactions
          : [...transactions].sort(compareLedgerRowsOldestFirst);
      const matchesArm = (
        transaction: LedgerRow,
        arm: {
          source?: PaymentSource | { not: PaymentSource };
          stripePaymentIntentId?: { not: string; notIn: string[] };
        }
      ) => {
        if (typeof arm.source === "string") {
          if (transaction.source !== arm.source) return false;
        } else if (arm.source && "not" in arm.source) {
          if (transaction.source === arm.source.not) return false;
        }
        if (arm.stripePaymentIntentId) {
          if (transaction.stripePaymentIntentId === null) return false;
          if (transaction.stripePaymentIntentId === arm.stripePaymentIntentId.not) {
            return false;
          }
          if (
            arm.stripePaymentIntentId.notIn.includes(
              transaction.stripePaymentIntentId
            )
          ) {
            return false;
          }
        }
        return true;
      };
      const match =
        candidates.find(
          (transaction) =>
            (where.id === undefined || transaction.id === where.id) &&
            transaction.kind === where.kind &&
            where.status.in.includes(transaction.status) &&
            where.OR.some((arm) => matchesArm(transaction, arm))
        ) ?? null;
      if (match) reachedSibling = true;
      return match;
    }
  );
  mocks.paymentTransactionFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => transactions.find((transaction) => transaction.id === where.id) ?? null,
  );
  mocks.findPaymentTransactionByIntentId.mockImplementation(
    async ({ paymentIntentId }: { paymentIntentId: string }) =>
      transactions.find(
        (transaction) => transaction.stripePaymentIntentId === paymentIntentId
      ) ?? null
  );
  // The live rows both fakes read, for a case that moves them between calls (#4211).
  return transactions;
}

type RecoveryOperationRow = {
  id: string;
  type: PaymentRecoveryOperationType;
  status: PaymentRecoveryOperationStatus;
  paymentId: string;
  paymentIntentId: string;
};

/**
 * Drive BOTH superseded-machinery guard lookups (b′ findMany scoped to the
 * payment, c′ findFirst by intent id) from one operation list with the REAL
 * where-clause semantics: type-in filter, non-SUCCEEDED ("live") status
 * filter, payment scoping / intent-id equality. This makes the regression
 * tests exercise the actual predicates rather than a canned return value.
 */
function primeRecoveryOperations(operations: RecoveryOperationRow[]) {
  mocks.paymentRecoveryOperationFindMany.mockImplementation(
    async (args: {
      where: {
        paymentId: string;
        type: { in: PaymentRecoveryOperationType[] };
        status: { not: PaymentRecoveryOperationStatus };
      };
    }) =>
      operations
        .filter(
          (operation) =>
            operation.paymentId === args.where.paymentId &&
            args.where.type.in.includes(operation.type) &&
            operation.status !== args.where.status.not
        )
        .map((operation) => ({ paymentIntentId: operation.paymentIntentId }))
  );
  mocks.paymentRecoveryOperationFindFirst.mockImplementation(
    async (args: {
      where: {
        paymentIntentId: string;
        type: { in: PaymentRecoveryOperationType[] };
        status: { not: PaymentRecoveryOperationStatus };
      };
    }) =>
      operations.find(
        (operation) =>
          operation.paymentIntentId === args.where.paymentIntentId &&
          args.where.type.in.includes(operation.type) &&
          operation.status !== args.where.status.not
      ) ?? null
  );
}

function makePaidBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: BookingStatus.PAID,
    lodgeId: "lodge-1",
    checkIn: parseDateOnly("2026-08-10"),
    checkOut: parseDateOnly("2026-08-12"),
    finalPriceCents: 10000,
    parentBookingId: "parent-1",
    guests: [],
    member: {
      firstName: "Alice",
      lastName: "Member",
      email: "alice@example.com",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owedMarkers.clear();
  reachedSibling = false;
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)
  );
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
  mocks.bookingFindUnique.mockResolvedValue(makePaidBooking());
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.paymentUpsert.mockResolvedValue({ id: "payment-1" });
  mocks.paymentTransactionFindFirst.mockResolvedValue(null);
  // Default: no live superseded-machinery operations (guards b′/c′ find none).
  mocks.paymentRecoveryOperationFindMany.mockResolvedValue([]);
  mocks.paymentRecoveryOperationFindFirst.mockResolvedValue(null);
  mocks.upsertPaymentIntentTransaction.mockResolvedValue(undefined);
  mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);
  mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  mocks.restoreCreditFromBooking.mockResolvedValue(undefined);
  mocks.deriveBookingAppliedCreditCents.mockResolvedValue(0);
  mocks.sendAdminPaymentFailureAlert.mockResolvedValue(undefined);
  mocks.sendAdminDuplicateCaptureKeptAlert.mockResolvedValue(undefined);
  mocks.releaseAlertCooldown.mockResolvedValue(undefined);
  mocks.sendAdminDuplicateCaptureRefundAlert.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.recordDuplicateCaptureRefundEvent.mockResolvedValue(undefined);
  mocks.refundPaymentTransactions.mockResolvedValue({ refunds: [] });
  mocks.enqueueDuplicateCaptureRefundRecovery.mockResolvedValue({
    id: "dup-op-1",
  });
  // Default: no duplicate-capture refund owns any capture yet (guard c).
  mocks.listDuplicateCaptureRefundIntentIds.mockResolvedValue([]);
  mocks.markDuplicateCaptureRefundRecoverySucceeded.mockResolvedValue({
    count: 1,
  });
  mocks.recordDuplicateCaptureRefundRecoveryInlineError.mockResolvedValue({
    count: 1,
  });
  mocks.recoveryUpdateMany.mockResolvedValue({ count: 1 });
  mocks.recoveryFindUnique.mockResolvedValue(null);
  mocks.claimAlertCooldownFailOpen.mockResolvedValue(true);
  mocks.supersededHoldsForMember.mockResolvedValue([]);
  mocks.supersededOwedBackAtAll.mockResolvedValue([]);
  mocks.paymentTransactionFindMany.mockResolvedValue([]);
  mocks.sumRecordedRefundsForCapture.mockResolvedValue(0);
  // By default a duplicate-capture refund holds its capture at any status, until one failed later (#4285 review 7 F6).
  mocks.duplicateRefundsHolding.mockImplementation(() => mocks.listDuplicateCaptureRefundIntentIds());
});

// The settled auto-charge capture and the arriving in-flight link capture.
const SETTLED_PI = "pi_auto_charge";
const DUPLICATE_PI = "pi_link_intent";

function primeDuplicateCaptureLedger(
  options: { duplicateAmountCents?: number } = {}
) {
  const duplicateAmountCents = options.duplicateAmountCents ?? 10000;
  primeLedger([
    ledgerRow({
      id: "txn-settled",
      stripePaymentIntentId: SETTLED_PI,
      amountCents: 10000,
    }),
    ledgerRow({
      id: "txn-duplicate",
      stripePaymentIntentId: DUPLICATE_PI,
      status: PaymentStatus.PROCESSING,
      amountCents: duplicateAmountCents,
    }),
  ], { settledBy: "txn-settled" });
}

describe("#1992 duplicate-capture auto-refund", () => {
  it("refunds a DIFFERENT arriving capture on an already-PAID booking: durable op enqueued inside the transaction, inline refund pinned to the duplicate's own transaction under the shared Stripe key prefix", async () => {
    primeDuplicateCaptureLedger();

    const result = await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result).toEqual({
      outcome: "duplicate_capture_refunded",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });

    // The arriving capture is still recorded in the ledger first (real money
    // moved), exactly as before this fix.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: DUPLICATE_PI,
        status: PaymentStatus.SUCCEEDED,
      })
    );

    // Durable debt enqueued with the transaction client (atomic with the
    // detection, before any Stripe call), pinned to the duplicate transaction.
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      allocationPlan: [
        { paymentTransactionId: "txn-duplicate", amountCents: 10000 },
      ],
      store: tx,
    });

    // Inline refund executes the same frozen slice under the shared
    // duplicate_capture_refund key prefix and cron-reconstructible metadata.
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith({
      paymentId: "payment-1",
      amountCents: 10000,
      reason: "requested_by_customer",
      allocation: [
        { paymentTransactionId: "txn-duplicate", amountCents: 10000 },
      ],
      format: CLUB_FORMAT_TEST,
      metadata: { bookingId: "booking-1", reason: "duplicate_capture" },
      idempotencyKeyPrefix: `duplicate_capture_refund_booking-1_${DUPLICATE_PI}`,
    });

    // Happy-path close + loud admin alert (money moved automatically).
    expect(
      mocks.markDuplicateCaptureRefundRecoverySucceeded
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `duplicate_capture_booking-1_${DUPLICATE_PI}`,
        // #4144: fenced on the plan this attempt sent, so a re-planned row stays owed.
        sentPlan: [{ paymentTransactionId: "txn-duplicate", amountCents: 10000 }],
      })
    );
    // #2007: the dedicated duplicate-capture template is sent (success variant),
    // NOT the generic payment-anomaly alert.
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 10000,
        paymentIntentId: DUPLICATE_PI,
        settledPaymentIntentId: SETTLED_PI,
        refundFailed: false,
        operationReference: `duplicate_capture_booking-1_${DUPLICATE_PI}`,
      }), CLUB_FORMAT_TEST
    );
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();

    // The booking's status/settlement is untouched: no PAID/CANCELLED claim.
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();

    // #2008 — the durable, admin-only history event is recorded EXACTLY ONCE on
    // the inline-success path (the mark flipped the operation to SUCCEEDED,
    // count 1). It is a REFUNDED event carrying the duplicate_capture_refund
    // discriminator (recordDuplicateCaptureRefundEvent), NOT a plain
    // recordBookingEvent that could masquerade as a cancellation's refund.
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
    expect(mocks.recordDuplicateCaptureRefundEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordDuplicateCaptureRefundEvent).toHaveBeenCalledWith({
      bookingId: "booking-1",
      amountCents: 10000,
      duplicatePaymentIntentId: DUPLICATE_PI,
      settledPaymentIntentId: SETTLED_PI,
    });
  });

  it("does NOT record the admin history event when the inline mark did not flip the operation (count 0 — the cron already closed it)", async () => {
    // A lost inline close raced the cron: the refund succeeded but the mark
    // reports count 0 because the operation is already SUCCEEDED. The inline
    // path must NOT record the event (the cron-replay path owns it), so the two
    // paths never double-record.
    primeDuplicateCaptureLedger();
    mocks.markDuplicateCaptureRefundRecoverySucceeded.mockResolvedValue({
      count: 0,
    });

    const result = await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refunded");
    expect(mocks.recordDuplicateCaptureRefundEvent).not.toHaveBeenCalled();
  });

  it("refunds exactly the duplicate's captured amount, not the booking price", async () => {
    // A stale-price duplicate: the link intent was minted at an older 8000
    // total. The refund must hand back the 8000 that was actually captured.
    primeDuplicateCaptureLedger({ duplicateAmountCents: 8000 });

    const result = await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 8000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refunded");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 8000,
        allocationPlan: [
          { paymentTransactionId: "txn-duplicate", amountCents: 8000 },
        ],
      })
    );
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 8000 })
    );
  });

  it("tolerates an inline refund failure: the pre-persisted operation stays for the recovery cron, the inline error is recorded, admins are alerted", async () => {
    primeDuplicateCaptureLedger();
    mocks.refundPaymentTransactions.mockRejectedValue(
      new Error("Stripe is unavailable (503)")
    );

    const result = await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refund_failed");
    expect(result.refundError).toContain("503");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledTimes(1);
    expect(
      mocks.markDuplicateCaptureRefundRecoverySucceeded
    ).not.toHaveBeenCalled();
    // #2008 — no history event on the failed inline path: the operation is
    // still PENDING and the cron-replay path will record it on success.
    expect(mocks.recordDuplicateCaptureRefundEvent).not.toHaveBeenCalled();
    expect(
      mocks.recordDuplicateCaptureRefundRecoveryInlineError
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentIntentId: DUPLICATE_PI,
        message: expect.stringContaining("503"),
      })
    );
    // #2007: the dedicated template is sent in its failed variant carrying the
    // inline error and the queued recovery-operation reference.
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: DUPLICATE_PI,
        refundFailed: true,
        operationReference: `duplicate_capture_booking-1_${DUPLICATE_PI}`,
        errorMessage: expect.stringContaining("503"),
      }), CLUB_FORMAT_TEST
    );
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("pins the distinctness predicate's where-clause: captured PRIMARY Stripe transactions with net cash only (SUCCEEDED/PARTIALLY_REFUNDED — never fully REFUNDED), excluding the arriving intent, NULL intent ids and superseded-machinery-owned intents", async () => {
    primeDuplicateCaptureLedger();

    await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(mocks.paymentTransactionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          // #4211: asked of the recorded settler, under the same predicate.
          id: "txn-settled",
          paymentId: "payment-1",
          kind: PaymentTransactionKind.PRIMARY,
          status: {
            in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED],
          },
          // #2262 guard 3: ANY settled PRIMARY row counts as the sibling. The
          // STRIPE arm keeps the arriving-intent and superseded exclusions; the
          // non-Stripe arm needs no arriving-row exclusion because
          // upsertPaymentIntentTransaction hardcodes source STRIPE on both its
          // create and update arms (pinned by its own test), so the row this
          // settlement just wrote can never match it.
          OR: [
            {
              source: PaymentSource.STRIPE,
              stripePaymentIntentId: { not: DUPLICATE_PI, notIn: [] },
              NOT: { stripePaymentIntentId: null },
            },
            { source: { not: PaymentSource.STRIPE } },
          ],
        },
      })
    );

    // Guard (b′) query shape: live (non-SUCCEEDED) CANCEL_PAYMENT_INTENT /
    // REFUND_SUPERSEDED_PAYMENT operations on this payment, run inside the
    // same lock(1) transaction (the tx client's own delegate was used).
    expect(mocks.paymentRecoveryOperationFindMany).toHaveBeenCalledWith({
      where: {
        paymentId: "payment-1",
        type: {
          in: [
            PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
            PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          ],
        },
        status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
      },
      select: { paymentIntentId: true },
    });
  });

  it("still refunds the duplicate when the settling capture has since been PARTIALLY refunded (net cash is still held)", async () => {
    primeLedger([
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        status: PaymentStatus.PARTIALLY_REFUNDED,
        amountCents: 10000,
        refundedAmountCents: 2000,
      }),
      ledgerRow({
        id: "txn-duplicate",
        stripePaymentIntentId: DUPLICATE_PI,
        status: PaymentStatus.PROCESSING,
      }),
    ], { settledBy: "txn-settled" });

    const result = await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("duplicate_capture_refunded");
  });

  // #4211: only a booking with NO recorded settler still asks which capture is
  // the settlement, and only to tell the admins: it keeps the arriving capture.
  describe("#4177 no recorded settler, several captures qualify: the alert names the OLDEST-INSERTED, whatever order the rows come back in (INV-PAY-133)", () => {
    const OLDER_PI = "pi_settled_first";
    const NEWER_PI = "pi_settled_later";

    async function settleDuplicate() {
      return markBookingPaymentSucceeded({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        paymentIntentId: DUPLICATE_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });
    }

    function expectSettledBy(settledPaymentIntentId: string | null) {
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.sendAdminDuplicateCaptureRefundAlert).not.toHaveBeenCalled();
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentIntentId: DUPLICATE_PI,
          otherPaymentIntentId: settledPaymentIntentId,
          reason: "not-recorded",
        }),
        CLUB_FORMAT_TEST,
      );
    }

    it("reads the candidate in the shared ledger order, oldest first", async () => {
      primeLedger([
        ledgerRow({ id: "txn-settled", stripePaymentIntentId: SETTLED_PI }),
        ledgerRow({ id: "txn-duplicate", stripePaymentIntentId: DUPLICATE_PI }),
      ]);

      await settleDuplicate();

      expect(mocks.paymentTransactionFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [...LEDGER_ROWS_OLDEST_FIRST] }),
      );
    });

    it("two card captures tied on createdAt, heap order newest first: names and re-checks the one inserted first", async () => {
      primeLedger([
        ledgerRow({ id: "txn-newer", stripePaymentIntentId: NEWER_PI, insertionSeq: 2 }),
        ledgerRow({ id: "txn-older", stripePaymentIntentId: OLDER_PI, insertionSeq: 1 }),
        ledgerRow({
          id: "txn-duplicate",
          stripePaymentIntentId: DUPLICATE_PI,
          status: PaymentStatus.PROCESSING,
          insertionSeq: 3,
        }),
      ]);

      const result = await settleDuplicate();

      expect(result.outcome).toBe("duplicate_capture_kept");
      expectSettledBy(OLDER_PI);
      // (c′) re-checks the chosen settlement, never the later capture.
      const recheckedIntents = mocks.paymentRecoveryOperationFindFirst.mock.calls.map(
        ([args]) => (args as { where: { paymentIntentId: string } }).where.paymentIntentId,
      );
      expect(recheckedIntents).toEqual([OLDER_PI]);
    });

    it("createdAt outranks insertionSeq: the earlier-created capture is the settled one even with the higher sequence", async () => {
      primeLedger([
        ledgerRow({
          id: "txn-newer",
          stripePaymentIntentId: NEWER_PI,
          createdAt: new Date("2026-06-16T00:00:00.000Z"),
          insertionSeq: 1,
        }),
        ledgerRow({
          id: "txn-older",
          stripePaymentIntentId: OLDER_PI,
          createdAt: new Date("2026-06-15T00:00:00.000Z"),
          insertionSeq: 2,
        }),
        ledgerRow({ id: "txn-duplicate", stripePaymentIntentId: DUPLICATE_PI, insertionSeq: 3 }),
      ]);

      await settleDuplicate();

      expectSettledBy(OLDER_PI);
    });

    it.each([
      { settledFirst: "the cash settlement", cashSeq: 1, cardSeq: 2, settledBy: null },
      { settledFirst: "the card capture", cashSeq: 2, cardSeq: 1, settledBy: NEWER_PI },
    ])(
      "a non-Stripe settlement beside a card capture, heap order reversed: $settledFirst, inserted first, is the settled one",
      async ({ cashSeq, cardSeq, settledBy }) => {
        const cash = ledgerRow({
          id: "txn-cash",
          source: PaymentSource.INTERNET_BANKING,
          insertionSeq: cashSeq,
        });
        const card = ledgerRow({ id: "txn-card", stripePaymentIntentId: NEWER_PI, insertionSeq: cardSeq });
        const physical = cashSeq < cardSeq ? [card, cash] : [cash, card];
        primeLedger([
          ...physical,
          ledgerRow({ id: "txn-duplicate", stripePaymentIntentId: DUPLICATE_PI, insertionSeq: 3 }),
        ]);

        const result = await settleDuplicate();

        expect(result.outcome).toBe("duplicate_capture_kept");
        expectSettledBy(settledBy);
      },
    );
  });

  describe("SAME-intent replay stays already_paid with NO refund, from every legitimate caller path", () => {
    // Every caller invokes the same choke point with the SETTLED intent id;
    // what varies in production is only who carries it there. Pinning each
    // path by name documents that the duplicate-capture refund can never fire
    // for the normal exactly-once replay outcome of:
    const legitimateReplayPaths = [
      "stripe-webhook payment_intent.succeeded redelivery (stripe-webhook-service)",
      "confirm-payment route racing the webhook (bookings/[id]/confirm-payment)",
      "payment-link reconcile of an existing succeeded intent (createPaymentIntentForPaymentLink)",
      "charge-saved-method replaying its recorded attempt's own intent (#3267)",
      "cron-confirm-pending replaying its recorded attempt's own intent (#3267)",
      "create-payment-intent route recovery reconcile of a succeeded intent",
      "admin confirm-pending-guests retry of its recorded charge",
    ];

    it.each(legitimateReplayPaths)("%s", async () => {
      // Ledger holds ONLY the settled capture; the arriving intent IS it.
      primeLedger([
        ledgerRow({
          id: "txn-settled",
          stripePaymentIntentId: SETTLED_PI,
          amountCents: 10000,
        }),
      ]);

      const result = await markBookingPaymentSucceeded({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        paymentIntentId: SETTLED_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result).toEqual({
        outcome: "already_paid",
        bookingId: "booking-1",
        bumpedBookingIds: [],
      });
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      // #2007: neither the generic anomaly alert NOR the dedicated
      // duplicate-capture template fires on a benign same-intent replay.
      expect(
        mocks.sendAdminDuplicateCaptureRefundAlert
      ).not.toHaveBeenCalled();
    });
  });

  it("never refunds BOTH sides: once a duplicate-capture refund owns one capture, the settling capture's replay stays already_paid", async () => {
    // A duplicate-capture refund already owns DUPLICATE_PI (its operation row
    // exists). Now the SETTLED intent's webhook redelivers: from the ledger it
    // looks symmetric (a different SUCCEEDED capture exists), so without that
    // ownership this replay would refund the settlement too and leave the
    // booking PAID at zero net cash.
    primeLedger([
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        amountCents: 10000,
      }),
      ledgerRow({
        id: "txn-duplicate",
        stripePaymentIntentId: DUPLICATE_PI,
        amountCents: 10000,
      }),
    ]);
    mocks.listDuplicateCaptureRefundIntentIds.mockResolvedValue([DUPLICATE_PI]);

    const result = await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: SETTLED_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    expect(mocks.listDuplicateCaptureRefundIntentIds).toHaveBeenCalledWith({
      bookingId: "booking-1",
      store: tx,
    });
    // Non-vacuity: the only other capture was matched by the ledger shape and
    // excluded by guard (c) alone.
    expect(mocks.paymentTransactionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              stripePaymentIntentId: { not: SETTLED_PI, notIn: [DUPLICATE_PI] },
            }),
          ]),
        }),
      }),
    );
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  // The BLOCKER regression: the pre-existing superseded-intent machinery
  // transiently creates a SUCCEEDED PRIMARY Stripe capture whose money is
  // already spoken for. Superseded intent X's late capture is diverted by the
  // webhook (queueSupersededPaymentIntentRefundRecovery) or by the recovery
  // cron's cancel-lost-race handoff into markSupersededTransactionSucceeded —
  // X becomes SUCCEEDED/refunded=0 with a queued REFUND_SUPERSEDED_PAYMENT
  // operation, and X never passes through markBookingPaymentSucceeded, so no
  // duplicate-capture refund owns it. If the member then pays
  // fresh intent Y (booking → PAID via the route) and Y's own first webhook
  // delivery arrives (#772 route-vs-webhook race — event dedup does not
  // apply), the unguarded predicate would find X, owned by no duplicate-capture
  // refund, and refund Y — the REAL settlement — in full, while the cron later
  // refunds X: booking PAID at zero net cash, both sides refunded.
  describe("superseded-intent handoff window: the arriving REAL settlement stays already_paid, never refunded (#1992 guards b′/c′)", () => {
    const SUPERSEDED_PI = "pi_superseded_x";
    const SETTLEMENT_PI = "pi_fresh_settlement_y";

    function primeHandoffLedger() {
      primeLedger([
        // X: the superseded intent's late capture after the handoff — from
        // the ledger alone, indistinguishable from a settlement.
        ledgerRow({
          id: "txn-superseded-x",
          stripePaymentIntentId: SUPERSEDED_PI,
          status: PaymentStatus.SUCCEEDED,
          amountCents: 10000,
          refundedAmountCents: 0,
        }),
        // Y: the fresh intent that actually settled the booking via the route.
        ledgerRow({
          id: "txn-settlement-y",
          stripePaymentIntentId: SETTLEMENT_PI,
          status: PaymentStatus.SUCCEEDED,
          amountCents: 10000,
        }),
      ]);
    }

    it("X handed off (SUCCEEDED + queued REFUND_SUPERSEDED_PAYMENT op): Y's webhook replay is already_paid — no refund op for Y, no refund, no admin email; X's queued refund op is left for the cron untouched", async () => {
      primeHandoffLedger();
      primeRecoveryOperations([
        {
          id: "op-refund-superseded-x",
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          status: PaymentRecoveryOperationStatus.PENDING,
          paymentId: "payment-1",
          paymentIntentId: SUPERSEDED_PI,
        },
      ]);

      const result = await markBookingPaymentSucceeded({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        paymentIntentId: SETTLEMENT_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result).toEqual({
        outcome: "already_paid",
        bookingId: "booking-1",
        bumpedBookingIds: [],
      });
      // The real settlement Y is NEVER refunded and no duplicate-capture
      // refund debt is opened against it.
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      // Admins are NOT emailed — this is the benign replay outcome, not an
      // anomaly. Neither the generic anomaly alert nor the #2007 dedicated
      // duplicate-capture template fires.
      expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      expect(
        mocks.sendAdminDuplicateCaptureRefundAlert
      ).not.toHaveBeenCalled();
      // X's money still belongs to the superseded machinery: its queued
      // REFUND_SUPERSEDED_PAYMENT operation is read, never written (the tx
      // stub exposes NO write methods on paymentRecoveryOperation, so any
      // attempt to complete/clobber it would have crashed this test). The
      // cron then refunds X normally — that replay (including its
      // idempotency-by-ledger retry safety) is pinned in
      // payment-recovery.test.ts ("queues refund recovery when the superseded
      // PaymentIntent already succeeded" / "does not double-count a
      // previously written refund when the recovery retries").
      expect(mocks.paymentRecoveryOperationFindMany).toHaveBeenCalled();
    });

    it("CANCEL_PAYMENT_INTENT variant: X mid-handoff (cancel op still live, refund op not yet enqueued) — Y's replay stays already_paid with no refund", async () => {
      primeHandoffLedger();
      // The cancel-lost-race handoff window: markSupersededTransactionSucceeded
      // has committed (X is SUCCEEDED) but the REFUND_SUPERSEDED_PAYMENT op is
      // not yet enqueued and the CANCEL_PAYMENT_INTENT op has not yet been
      // completed — it is the live marker that X's money is spoken for.
      primeRecoveryOperations([
        {
          id: "op-cancel-superseded-x",
          type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
          status: PaymentRecoveryOperationStatus.PROCESSING,
          paymentId: "payment-1",
          paymentIntentId: SUPERSEDED_PI,
        },
      ]);

      const result = await markBookingPaymentSucceeded({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        paymentIntentId: SETTLEMENT_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result.outcome).toBe("already_paid");
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      expect(
        mocks.sendAdminDuplicateCaptureRefundAlert
      ).not.toHaveBeenCalled();
    });

    it("an exhausted (FAILED) superseded refund op still owns X's money: Y's replay stays already_paid", async () => {
      primeHandoffLedger();
      primeRecoveryOperations([
        {
          id: "op-refund-superseded-x",
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          status: PaymentRecoveryOperationStatus.FAILED,
          paymentId: "payment-1",
          paymentIntentId: SUPERSEDED_PI,
        },
      ]);

      const result = await markBookingPaymentSucceeded({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        paymentIntentId: SETTLEMENT_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result.outcome).toBe("already_paid");
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      // #4211: a capture superseded machinery owns is no unknown settlement either.
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
    });

    it("guard (c′) belt-and-braces: even if the candidate slips the (b′) notIn exclusion, the direct intent-id re-check suppresses the refund", async () => {
      primeHandoffLedger();
      // Simulate a (b′) miss with a divergent query shape: the payment-scoped
      // findMany returns nothing, while the direct intent-id findFirst still
      // sees the live operation.
      mocks.paymentRecoveryOperationFindMany.mockResolvedValue([]);
      mocks.paymentRecoveryOperationFindFirst.mockImplementation(
        async ({ where }: { where: { paymentIntentId: string } }) =>
          where.paymentIntentId === SUPERSEDED_PI ? { id: "op-refund-superseded-x" } : null,
      );

      const result = await markBookingPaymentSucceeded({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        paymentIntentId: SETTLEMENT_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result.outcome).toBe("already_paid");
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
      // (c′) query shape: direct lookup by the CANDIDATE's intent id (X, the
      // matched "settlement"), the same live-status/type filter as (b′).
      expect(mocks.paymentRecoveryOperationFindFirst).toHaveBeenCalledWith({
        where: {
          paymentIntentId: SUPERSEDED_PI,
          type: {
            in: [
              PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
              PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
            ],
          },
          status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
        },
        select: { id: true },
      });
    });

    it("terminal (SUCCEEDED) superseded-machinery ops do NOT suppress the true double-charge path: the arriving distinct capture is still auto-refunded", async () => {
      // The true #1967 double-charge shape (auto-charge X vs link capture Y,
      // NEITHER owned by a live superseded/cancel op) must keep auto-refunding.
      // Long-completed superseded machinery elsewhere on the payment is
      // history, not ownership.
      primeDuplicateCaptureLedger();
      primeRecoveryOperations([
        {
          id: "op-old-cancel",
          type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
          paymentId: "payment-1",
          paymentIntentId: SETTLED_PI,
        },
        {
          id: "op-old-refund",
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
          paymentId: "payment-1",
          paymentIntentId: SETTLED_PI,
        },
      ]);

      const result = await markBookingPaymentSucceeded({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        paymentIntentId: DUPLICATE_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(result.outcome).toBe("duplicate_capture_refunded");
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledTimes(
        1
      );
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledTimes(1);
      // #2262 non-vacuity control for the guard tests above: with the SAME
      // ledger and the SAME (rewritten) predicate mock, a sibling IS matched
      // once no live superseded operation owns it. So the already_paid
      // outcomes above come from the guards doing their job, not from a mock
      // that quietly stopped understanding the where-clause shape.
      expect(reachedSibling).toBe(true);
    });

    it("#2262 non-vacuity: the same handoff ledger DOES match a sibling once no live superseded operation owns the candidate", async () => {
      primeHandoffLedger();
      primeRecoveryOperations([]);

      const result = await markBookingPaymentSucceeded({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        paymentIntentId: SETTLEMENT_PI,
        amountCents: 10000,
        paymentMethodId: "pm_1",
      });

      expect(reachedSibling).toBe(true);
      // #4211: nothing recorded which capture settled this booking, so the
      // match is reported to the admins and nothing is refunded automatically.
      expect(result.outcome).toBe("duplicate_capture_kept");
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: SETTLEMENT_PI, otherPaymentIntentId: SUPERSEDED_PI }),
        CLUB_FORMAT_TEST,
      );
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    });
  });

  it("a redelivery of the duplicate AFTER its refund executed stays already_paid via the #1765 refunded-history guard (no second refund op, no ledger clobber)", async () => {
    primeLedger([
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        amountCents: 10000,
      }),
      ledgerRow({
        id: "txn-duplicate",
        stripePaymentIntentId: DUPLICATE_PI,
        status: PaymentStatus.REFUNDED,
        amountCents: 10000,
        refundedAmountCents: 10000,
      }),
    ]);

    const result = await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    // #1765 — the refunded transaction row is never clobbered back to
    // SUCCEEDED, and no duplicate machinery runs for refund history.
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(mocks.paymentTransactionFindFirst).not.toHaveBeenCalled();
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("repay-generation replay (#1765): the repay capture arriving alongside its fully REFUNDED predecessor is NOT a duplicate", async () => {
    // Paid via pi_old, deliberately refunded, repaid via pi_repay, booking
    // PAID again. A pi_repay webhook redelivery must stay already_paid: the
    // only other capture on the ledger is fully REFUNDED, which the
    // distinctness predicate excludes — auto-refunding the repay would strand
    // the booking PAID with zero net cash.
    primeLedger([
      ledgerRow({
        id: "txn-old",
        stripePaymentIntentId: "pi_old",
        status: PaymentStatus.REFUNDED,
        amountCents: 10000,
        refundedAmountCents: 10000,
      }),
      ledgerRow({
        id: "txn-repay",
        stripePaymentIntentId: "pi_repay",
        amountCents: 10000,
      }),
    ]);

    const result = await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: "pi_repay",
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("a normal success on a not-yet-paid booking is untouched by the duplicate machinery", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      ...makePaidBooking(),
      status: BookingStatus.PENDING,
    });
    primeLedger([]);

    const result = await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: "pi_fresh",
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("paid");
    expect(mocks.paymentTransactionFindFirst).not.toHaveBeenCalled();
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  describe("#4300 (INV-PAY-138): the settle refuses a capture the superseded machinery owns, under lock(1)", () => {
    function settleUnpaid(paymentIntentId: string) {
      mocks.bookingFindUnique.mockResolvedValue({ ...makePaidBooking(), status: BookingStatus.PAYMENT_PENDING });
      return markBookingPaymentSucceeded({ format: CLUB_FORMAT_TEST, bookingId: "booking-1", paymentIntentId, amountCents: 10000, paymentMethodId: "pm_1" });
    }
    function expectNotSettled() {
      expect(mocks.bookingUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: BookingStatus.PAID }) }));
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    }

    it("a live superseded-intent row on the capture: superseded_capture, not settled, handed off and alerted", async () => {
      primeLedger([]);
      primeRecoveryOperations([{ id: "op-x", type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, status: PaymentRecoveryOperationStatus.PENDING, paymentId: "payment-1", paymentIntentId: "pi_superseded" }]);

      expect((await settleUnpaid("pi_superseded")).outcome).toBe("superseded_capture");
      expectNotSettled();
      expect(mocks.queueSupersededPaymentIntentRefundRecovery).toHaveBeenCalledWith({ id: "pi_superseded", amount: 10000, payment_method: "pm_1" });
      // Its own unmuteable alert, worded for a booking that still owes - never "Payment Failed".
      expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      expect(mocks.sendAdminSupersededCaptureRefusedAlert).toHaveBeenCalledTimes(1);
      expect(mocks.sendAdminSupersededCaptureRefusedAlert.mock.calls[0]![0]).toMatchObject({ paymentIntentId: "pi_superseded", bookingId: "booking-1", bookingCancelled: false, amountCents: 10000 });
    });

    it("a capture open rows owe back only PART of (no live row): still refused - never settle with money partly going back", async () => {
      primeLedger([]);
      primeRecoveryOperations([]);
      mocks.supersededOwedBackAtAll.mockResolvedValue(["pi_superseded"]);

      expect((await settleUnpaid("pi_superseded")).outcome).toBe("superseded_capture");
      expectNotSettled();
    });

    it("an ordinary capture nothing owns settles as before", async () => {
      primeLedger([]);
      primeRecoveryOperations([]);

      expect((await settleUnpaid("pi_fresh")).outcome).toBe("paid");
      expect(mocks.queueSupersededPaymentIntentRefundRecovery).not.toHaveBeenCalled();
    });
  });

  it("a duplicate whose transaction row cannot be resolved falls back to already_paid (no blind refund)", async () => {
    // Other settled capture exists, but the arriving intent has no ledger row
    // to pin the refund slice to — refuse to move money on a guess.
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      ledgerRow({
        id: "txn-settled",
        stripePaymentIntentId: SETTLED_PI,
        amountCents: 10000,
      })
    );
    mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);

    const result = await markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });
});

// #4211 (`INV-PAY-043`, `INV-PAY-133`): guard (c) used to keep an arriving
// capture whenever ANY other duplicate-capture refund existed on the booking, so
// once one duplicate was refunded a THIRD capture (a member paying from three
// stale tabs) was kept, with no task or alert. Now a capture a duplicate-capture
// refund owns is never the settlement, and every capture beyond the settling
// one is refunded.
describe("#4211 every capture beyond the settling one is refunded, a third included", () => {
  const SETTLING_PI = "pi_settling";
  const SECOND_PI = "pi_second_tab";
  const THIRD_PI = "pi_third_tab";

  const arrive = (paymentIntentId: string) =>
    markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

  it("a third capture after one duplicate refund is refunded alone, and the alert and history event name the settling capture, not the refunded one inserted before it", async () => {
    primeLedger([
      // The second tab's intent was minted first, so its row is the oldest; a
      // duplicate-capture refund already owns it.
      ledgerRow({ id: "txn-second", stripePaymentIntentId: SECOND_PI, insertionSeq: 1 }),
      ledgerRow({ id: "txn-settling", stripePaymentIntentId: SETTLING_PI, insertionSeq: 2 }),
      ledgerRow({
        id: "txn-third",
        stripePaymentIntentId: THIRD_PI,
        status: PaymentStatus.PROCESSING,
        insertionSeq: 3,
      }),
    ], { settledBy: "txn-settling" });
    mocks.listDuplicateCaptureRefundIntentIds.mockResolvedValue([SECOND_PI]);

    const result = await arrive(THIRD_PI);

    expect(result.outcome).toBe("duplicate_capture_refunded");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: THIRD_PI,
        amountCents: 10000,
        allocationPlan: [{ paymentTransactionId: "txn-third", amountCents: 10000 }],
        store: tx,
      }),
    );
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledTimes(1);
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        allocation: [{ paymentTransactionId: "txn-third", amountCents: 10000 }],
        idempotencyKeyPrefix: `duplicate_capture_refund_booking-1_${THIRD_PI}`,
      }),
    );
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: THIRD_PI,
        settledPaymentIntentId: SETTLING_PI,
        refundFailed: false,
        operationReference: `duplicate_capture_booking-1_${THIRD_PI}`,
      }),
      CLUB_FORMAT_TEST,
    );
    expect(mocks.recordDuplicateCaptureRefundEvent).toHaveBeenCalledWith({
      bookingId: "booking-1",
      amountCents: 10000,
      duplicatePaymentIntentId: THIRD_PI,
      settledPaymentIntentId: SETTLING_PI,
    });
    // (c′) re-checks the settling capture, never the refunded one.
    const recheckedIntents = mocks.paymentRecoveryOperationFindFirst.mock.calls.map(
      ([args]) => (args as { where: { paymentIntentId: string } }).where.paymentIntentId,
    );
    expect(recheckedIntents).toEqual([SETTLING_PI]);
  });

  it("with only refunded-or-owned captures beside it, the arriving capture is the settlement and stays already_paid", async () => {
    primeLedger([
      ledgerRow({ id: "txn-second", stripePaymentIntentId: SECOND_PI }),
      ledgerRow({ id: "txn-settling", stripePaymentIntentId: SETTLING_PI }),
      ledgerRow({ id: "txn-third", stripePaymentIntentId: THIRD_PI }),
    ]);
    mocks.listDuplicateCaptureRefundIntentIds.mockResolvedValue([SECOND_PI, THIRD_PI]);

    const result = await arrive(SETTLING_PI);

    expect(result.outcome).toBe("already_paid");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).not.toHaveBeenCalled();
  });

  /**
   * One booking the fakes keep state for: the arriving write marks a row
   * SUCCEEDED, an enqueue gives the capture to a duplicate-capture refund, and
   * an inline refund that Stripe makes leaves the row REFUNDED. `failInline`
   * names captures whose inline refund throws, leaving the operation queued.
   */
  function primeStatefulBooking(failInline: readonly string[] = []) {
    const rows = primeLedger([
      ledgerRow({ id: "txn-settling", stripePaymentIntentId: SETTLING_PI }),
      ledgerRow({ id: "txn-second", stripePaymentIntentId: SECOND_PI, status: PaymentStatus.PROCESSING }),
      ledgerRow({ id: "txn-third", stripePaymentIntentId: THIRD_PI, status: PaymentStatus.PROCESSING }),
    ], { settledBy: "txn-settling" });
    const owned = new Set<string>();
    const enqueued: string[] = [];
    const refunded: string[] = [];
    mocks.listDuplicateCaptureRefundIntentIds.mockImplementation(async () => [...owned]);
    mocks.enqueueDuplicateCaptureRefundRecovery.mockImplementation(
      async ({ paymentIntentId }: { paymentIntentId: string }) => {
        owned.add(paymentIntentId);
        enqueued.push(paymentIntentId);
        return { created: true, paymentIntentId };
      },
    );
    mocks.upsertPaymentIntentTransaction.mockImplementation(
      async ({ paymentIntentId, status }: { paymentIntentId: string; status: PaymentStatus }) => {
        const row = rows.find((candidate) => candidate.stripePaymentIntentId === paymentIntentId);
        if (row) row.status = status;
      },
    );
    mocks.refundPaymentTransactions.mockImplementation(
      async ({ allocation }: { allocation: Array<{ paymentTransactionId: string; amountCents: number }> }) => {
        const row = rows.find((candidate) => candidate.id === allocation[0]!.paymentTransactionId)!;
        if (failInline.includes(row.stripePaymentIntentId!)) throw new Error("Stripe is unavailable (503)");
        row.status = PaymentStatus.REFUNDED;
        row.refundedAmountCents = row.amountCents;
        refunded.push(row.stripePaymentIntentId!);
        return { refunds: [] };
      },
    );
    return { rows, enqueued, refunded };
  }

  const ARRIVALS = [SETTLING_PI, SECOND_PI, THIRD_PI];
  const permutations = (items: readonly string[]): string[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
        );

  it.each(permutations(ARRIVALS).map((order) => [order.join(" → "), order] as const))(
    "arrival order %s, the settling capture replayed among them: exactly one capture stays, two are refunded once each, and a replay of all three changes nothing",
    async (_label, order) => {
      const { rows, enqueued, refunded } = primeStatefulBooking();

      const outcomes = [];
      for (const paymentIntentId of order) outcomes.push((await arrive(paymentIntentId)).outcome);

      expect(outcomes.filter((outcome) => outcome === "duplicate_capture_refunded")).toHaveLength(2);
      expect([...enqueued].sort()).toEqual([SECOND_PI, THIRD_PI].sort());
      expect([...refunded].sort()).toEqual([SECOND_PI, THIRD_PI].sort());
      expect(rows.filter((row) => row.status === PaymentStatus.SUCCEEDED).map((row) => row.stripePaymentIntentId)).toEqual([
        SETTLING_PI,
      ]);
      for (const call of mocks.sendAdminDuplicateCaptureRefundAlert.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ settledPaymentIntentId: SETTLING_PI }));
      }

      vi.clearAllMocks();
      const replays = [];
      for (const paymentIntentId of [...order].reverse()) replays.push((await arrive(paymentIntentId)).outcome);

      expect(replays).toEqual(["already_paid", "already_paid", "already_paid"]);
      expect(enqueued).toHaveLength(2);
      expect(refunded).toHaveLength(2);
      expect(mocks.sendAdminDuplicateCaptureRefundAlert).not.toHaveBeenCalled();
    },
  );

  it("the second capture's inline refund failed and is still queued: the third is still refunded, the settling replay keeps its money, and the second's replay re-sends only its own frozen refund", async () => {
    const { rows, enqueued } = primeStatefulBooking([SECOND_PI]);

    expect((await arrive(SECOND_PI)).outcome).toBe("duplicate_capture_refund_failed");
    expect((await arrive(THIRD_PI)).outcome).toBe("duplicate_capture_refunded");
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({ paymentIntentId: THIRD_PI, settledPaymentIntentId: SETTLING_PI }),
      CLUB_FORMAT_TEST,
    );
    expect((await arrive(SETTLING_PI)).outcome).toBe("already_paid");
    expect(enqueued).toEqual([SECOND_PI, THIRD_PI]);

    // The second capture's own replay: the same operation key and Stripe key
    // prefix as its first attempt, so Stripe answers with the original refund.
    expect((await arrive(SECOND_PI)).outcome).toBe("duplicate_capture_refund_failed");
    expect(enqueued).toEqual([SECOND_PI, THIRD_PI, SECOND_PI]);
    expect(mocks.refundPaymentTransactions).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyKeyPrefix: `duplicate_capture_refund_booking-1_${SECOND_PI}` }),
    );
    expect(rows.find((row) => row.id === "txn-settling")!.status).toBe(PaymentStatus.SUCCEEDED);
  });
});

// #4211 (owner decision 17 Oct 2026, "Record the settler"): the PAID claim
// records which row settled the booking. Its replay is kept whatever else holds
// money; with no record, nothing is refunded automatically and the admins check.
describe("#4211 the recorded settler is never refunded; with no record the admins check by hand", () => {
  const SETTLING_PI = "pi_settling_y";
  const THIRD_PI = "pi_kept_third_z";
  const SUPERSEDED_PI = "pi_superseded_x";

  const arrive = (paymentIntentId: string) =>
    markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

  function expectNothingRefunded() {
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).not.toHaveBeenCalled();
  }

  it("the PAID claim records the arriving capture's own row as the settler", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ ...makePaidBooking(), status: BookingStatus.PENDING });
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI, status: PaymentStatus.PENDING })]);

    expect((await arrive(SETTLING_PI)).outcome).toBe("paid");
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment-1" },
      data: { settledByTransactionId: "txn-y" },
    });
  });

  it.each([
    {
      case: "(a) a third capture the old guard kept",
      other: ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI }),
      superseded: [] as RecoveryOperationRow[],
    },
    {
      case: "(b) a Xero bank receipt recorded after the card paid",
      other: ledgerRow({ id: "txn-bank", source: PaymentSource.INTERNET_BANKING }),
      superseded: [] as RecoveryOperationRow[],
    },
    {
      case: "(c) a superseded capture whose refund failed later (#4227)",
      other: ledgerRow({ id: "txn-x", stripePaymentIntentId: SUPERSEDED_PI }),
      // Its superseded refund completed, then failed at Stripe: no live operation.
      superseded: [
        {
          id: "op-x",
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
          paymentId: "payment-1",
          paymentIntentId: SUPERSEDED_PI,
        },
      ],
    },
  ])("$case holds money beside the recorded settler: the settler's replay is kept and nothing is refunded", async ({ other, superseded }) => {
    primeLedger([other, ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI })], { settledBy: "txn-y" });
    primeRecoveryOperations(superseded);

    expect(await arrive(SETTLING_PI)).toEqual({ outcome: "already_paid", bookingId: "booking-1", bumpedBookingIds: [] });
    expectNothingRefunded();
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
    // Rule 1 answers before the ledger is asked anything.
    expect(mocks.paymentTransactionFindFirst).not.toHaveBeenCalled();
  });

  it("(a) the kept third capture's own replay is refunded against the recorded settler", async () => {
    primeLedger(
      [ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI }), ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI })],
      { settledBy: "txn-y" },
    );

    expect((await arrive(THIRD_PI)).outcome).toBe("duplicate_capture_refunded");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ allocationPlan: [{ paymentTransactionId: "txn-z", amountCents: 10000 }] }),
    );
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: THIRD_PI, settledPaymentIntentId: SETTLING_PI }),
      CLUB_FORMAT_TEST,
    );
  });

  it("a recorded cash or bank settlement refunds any card capture that arrives, naming no card", async () => {
    primeLedger(
      [ledgerRow({ id: "txn-bank", source: PaymentSource.INTERNET_BANKING }), ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI })],
      { settledBy: "txn-bank" },
    );

    expect((await arrive(THIRD_PI)).outcome).toBe("duplicate_capture_refunded");
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: THIRD_PI, settledPaymentIntentId: null }),
      CLUB_FORMAT_TEST,
    );
  });

  it("with no record, a capture arriving beside another holding money is kept and the admins are told, once a day", async () => {
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI }), ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI })]);

    expect(await arrive(THIRD_PI)).toEqual({ outcome: "duplicate_capture_kept", bookingId: "booking-1", bumpedBookingIds: [] });
    expectNothingRefunded();
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
      {
        memberName: expect.any(String),
        checkIn: expect.any(Date),
        checkOut: expect.any(Date),
        bookingId: "booking-1",
        reason: "not-recorded",
        amountCents: 10000,
        paymentIntentId: THIRD_PI,
        otherPaymentIntentId: SETTLING_PI,
        otherHoldsMoney: true,
      },
      CLUB_FORMAT_TEST,
    );
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    expect(mocks.claimAlertCooldownFailOpen).toHaveBeenCalledWith(
      expect.objectContaining({ key: `duplicate-capture-unrecorded-settler:booking-1:${THIRD_PI}`, windowMs: 24 * 60 * 60 * 1000 }),
    );

    // A redelivery inside the window re-checks and keeps, but does not re-mail.
    mocks.claimAlertCooldownFailOpen.mockResolvedValueOnce(false);
    expect((await arrive(THIRD_PI)).outcome).toBe("duplicate_capture_kept");
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledTimes(1);
    expectNothingRefunded();
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
  });

  it("with no record, a send that throws gives the alert's claim back so the next repeat tries again", async () => {
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI }), ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI })]);
    mocks.sendAdminDuplicateCaptureKeptAlert.mockRejectedValueOnce(new Error("no recipients readable"));

    expect((await arrive(THIRD_PI)).outcome).toBe("duplicate_capture_kept");
    const claim = mocks.claimAlertCooldownFailOpen.mock.calls[0]![0] as { key: string; now: Date };
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledWith({ key: claim.key, claimedAt: claim.now });
    expectNothingRefunded();
  });

  it("with no record, a capture a duplicate-capture refund already owns still re-sends its own refund", async () => {
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI }), ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI })]);
    mocks.listDuplicateCaptureRefundIntentIds.mockResolvedValue([THIRD_PI]);

    expect((await arrive(THIRD_PI)).outcome).toBe("duplicate_capture_refunded");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: THIRD_PI }),
    );
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
  });

  it("a recorded settler that no longer holds money is no record: the arriving capture is kept and the admins told", async () => {
    primeLedger(
      [
        ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI, status: PaymentStatus.REFUNDED, refundedAmountCents: 10000 }),
        ledgerRow({ id: "txn-w", stripePaymentIntentId: "pi_other_w" }),
        ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI }),
      ],
      { settledBy: "txn-y" },
    );

    expect((await arrive(THIRD_PI)).outcome).toBe("duplicate_capture_kept");
    expectNothingRefunded();
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "settler-released", otherPaymentIntentId: "pi_other_w" }),
      CLUB_FORMAT_TEST,
    );
  });

  it("a recorded settler that no longer holds money and nothing else holding money: kept, and the admins are told (not a silent keep)", async () => {
    primeLedger(
      [
        ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI, status: PaymentStatus.REFUNDED, refundedAmountCents: 10000 }),
        ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI }),
      ],
      { settledBy: "txn-y" },
    );

    expect((await arrive(THIRD_PI)).outcome).toBe("duplicate_capture_kept");
    expectNothingRefunded();
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "settler-released", otherPaymentIntentId: null, otherHoldsMoney: false }),
      CLUB_FORMAT_TEST,
    );
  });

  it("a released settler and the replay of a duplicate whose refund is already owed: it re-sends its own refund, no alert", async () => {
    primeLedger(
      [
        ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI, status: PaymentStatus.REFUNDED, refundedAmountCents: 10000 }),
        ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI }),
      ],
      { settledBy: "txn-y" },
    );
    mocks.listDuplicateCaptureRefundIntentIds.mockResolvedValue([THIRD_PI]);

    expect((await arrive(THIRD_PI)).outcome).toBe("duplicate_capture_refunded");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: THIRD_PI, allocationPlan: [{ paymentTransactionId: "txn-z", amountCents: 10000 }] }),
    );
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: THIRD_PI, settledPaymentIntentId: SETTLING_PI }),
      CLUB_FORMAT_TEST,
    );
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
  });

  it("a recorded settler a live superseded-intent operation holds, seen by both (b′) and (c′): a silent keep, as the (c′) case", async () => {
    primeLedger(
      [ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI }), ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI })],
      { settledBy: "txn-y" },
    );
    primeRecoveryOperations([
      {
        id: "op-superseded-y",
        type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
        status: PaymentRecoveryOperationStatus.PENDING,
        paymentId: "payment-1",
        paymentIntentId: SETTLING_PI,
      },
    ]);

    expect((await arrive(THIRD_PI)).outcome).toBe("already_paid");
    expectNothingRefunded();
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
  });

  it("no record and nothing else holding money (a replay of the booking's only capture): a silent keep", async () => {
    primeLedger([ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI })]);

    expect((await arrive(THIRD_PI)).outcome).toBe("already_paid");
    expectNothingRefunded();
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
  });

  it("(c′) alone sees a live superseded operation on the RECORDED settler: nothing is refunded and nobody is asked to check", async () => {
    primeLedger(
      [ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI }), ledgerRow({ id: "txn-z", stripePaymentIntentId: THIRD_PI })],
      { settledBy: "txn-y" },
    );
    // (b′)'s payment-scoped read misses it; only the direct re-check sees it.
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([]);
    mocks.paymentRecoveryOperationFindFirst.mockImplementation(
      async ({ where }: { where: { paymentIntentId: string } }) => (where.paymentIntentId === SETTLING_PI ? { id: "op-superseded-y" } : null),
    );

    expect((await arrive(THIRD_PI)).outcome).toBe("already_paid");
    expectNothingRefunded();
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
    expect(mocks.paymentRecoveryOperationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ paymentIntentId: SETTLING_PI }) }),
    );
  });
});

// #4285 (`INV-PAY-043`): the post-stay cron moves PAID -> COMPLETED, so a
// capture arriving on a COMPLETED booking is judged exactly as on a PAID one,
// never thrown as "not payable" (a 500 Stripe retried for three days).
describe("#4285 a capture arriving on a COMPLETED booking is judged as on a PAID one", () => {
  const SETTLING_PI = "pi_settling_completed";
  const OTHER_PI = "pi_other_completed";

  const arrive = (paymentIntentId: string) =>
    markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

  beforeEach(() => {
    mocks.bookingFindUnique.mockResolvedValue({ ...makePaidBooking(), status: BookingStatus.COMPLETED });
  });

  function expectNothingWritten() {
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).not.toHaveBeenCalled();
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    // A finished stay's beds are left alone.
    expect(mocks.reconcileBedAllocationsForBooking).not.toHaveBeenCalled();
  }

  it("the recorded settler's redelivery is already_paid, and nothing is written", async () => {
    primeLedger(
      [ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI }), ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI })],
      { settledBy: "txn-y" },
    );

    expect(await arrive(SETTLING_PI)).toEqual({ outcome: "already_paid", bookingId: "booking-1", bumpedBookingIds: [] });
    expectNothingWritten();
  });

  it("paid before the record existed: the booking's only capture's redelivery is already_paid, with no alert", async () => {
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI })]);

    expect(await arrive(SETTLING_PI)).toEqual({ outcome: "already_paid", bookingId: "booking-1", bumpedBookingIds: [] });
    expectNothingWritten();
  });

  it("another capture while the recorded settler holds money is refunded as a duplicate, naming the settler", async () => {
    primeLedger(
      [ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI }), ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, status: PaymentStatus.PROCESSING })],
      { settledBy: "txn-y" },
    );

    expect((await arrive(OTHER_PI)).outcome).toBe("duplicate_capture_refunded");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: OTHER_PI, allocationPlan: [{ paymentTransactionId: "txn-z", amountCents: 10000 }] }),
    );
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: OTHER_PI, settledPaymentIntentId: SETTLING_PI }),
      CLUB_FORMAT_TEST,
    );
    // The booking stays COMPLETED: no status claim, and the settler is not rewritten.
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
  });

  it("with no record and another capture holding money, the arriving capture is kept and the admins are told", async () => {
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI }), ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI })]);

    expect(await arrive(OTHER_PI)).toEqual({ outcome: "duplicate_capture_kept", bookingId: "booking-1", bumpedBookingIds: [] });
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: OTHER_PI, otherPaymentIntentId: SETTLING_PI, reason: "not-recorded" }),
      CLUB_FORMAT_TEST,
    );
  });

  it("a refunded capture's redelivery stays already_paid (#1765), never the refunded-intent throw", async () => {
    primeLedger(
      [
        ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI }),
        ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, status: PaymentStatus.REFUNDED, refundedAmountCents: 10000 }),
      ],
      { settledBy: "txn-y" },
    );

    expect((await arrive(OTHER_PI)).outcome).toBe("already_paid");
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  // #4285 review: with no record and nothing else holding money, a lone capture
  // keeps silently only as a replay of a capture already recorded; one the app
  // never recorded before is new money - kept, and the admins told, whatever its amount.
  describe.each([BookingStatus.PAID, BookingStatus.COMPLETED])("no record, a lone capture on a %s booking", (status) => {
    const arriveAt = (amountCents: number) =>
      markBookingPaymentSucceeded({ format: CLUB_FORMAT_TEST, bookingId: "booking-1", paymentIntentId: OTHER_PI, amountCents, paymentMethodId: "pm_1" });

    beforeEach(() => {
      mocks.bookingFindUnique.mockResolvedValue({ ...makePaidBooking(), status });
    });

    it.each([PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED])(
      "never recorded before (its row was %s): kept, nothing refunded, and the unmuteable alert names it new - at the amount owed too",
      async (priorStatus) => {
        primeLedger([ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, status: priorStatus })]);

        expect(await arriveAt(10000)).toEqual({ outcome: "duplicate_capture_kept", bookingId: "booking-1", bumpedBookingIds: [] });
        expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
        expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
        expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledTimes(1);
        expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
          expect.objectContaining({ paymentIntentId: OTHER_PI, amountCents: 10000, otherPaymentIntentId: null, otherHoldsMoney: false, reason: "new-capture" }),
          CLUB_FORMAT_TEST,
        );
      },
    );

    it("#4285 review 6: the drain's closed alert carries the cancellation's recorded refund to the sender; the settle's alert carries none", async () => {
      const { alertCaptureKeptWithoutRecordedSettler } = await import("@/lib/duplicate-capture-guard");
      const cancellationRefund = { method: "credit" as const, amount: "$100.00" };

      expect(
        await alertCaptureKeptWithoutRecordedSettler({
          booking: makePaidBooking(),
          memberName: "Alice Member",
          paymentIntentId: OTHER_PI,
          amountCents: 20000,
          otherPaymentIntentId: null,
          otherHoldsMoney: false,
          reason: "new-capture-closed",
          cancellationRefund,
          format: CLUB_FORMAT_TEST,
        }),
      ).toBe("sent");
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "new-capture-closed", amountCents: 20000, cancellationRefund }),
        CLUB_FORMAT_TEST,
      );
    });

    it("#4285 review 7 F2: a capture behind a dead cancel beside it is not the settlement, so the capture is kept as new - and the alert names it, never 'no other payment'", async () => {
      primeLedger([
        ledgerRow({ id: "txn-dead", stripePaymentIntentId: "pi_dead_cancel" }),
        ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, status: PaymentStatus.PENDING }),
      ]);
      // Exhausted: the refund-safety reading (b′) still sets it aside; the telling reading does not.
      primeRecoveryOperations([
        { id: "op-dead", type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, status: PaymentRecoveryOperationStatus.FAILED, paymentId: "payment-1", paymentIntentId: "pi_dead_cancel" },
      ]);

      expect((await arriveAt(10000)).outcome).toBe("duplicate_capture_kept");
      expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "new-capture", otherPaymentIntentId: "pi_dead_cancel", otherHoldsMoney: true }),
        CLUB_FORMAT_TEST,
      );
    });

    it("#4285 review 7 F6: a capture whose duplicate-capture refund failed later, with nothing owing it again, is named by the alert", async () => {
      primeLedger([
        ledgerRow({ id: "txn-dup", stripePaymentIntentId: "pi_dup" }),
        ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, status: PaymentStatus.PENDING }),
      ]);
      mocks.listDuplicateCaptureRefundIntentIds.mockResolvedValue(["pi_dup"]);
      mocks.duplicateRefundsHolding.mockResolvedValue([]);

      expect((await arriveAt(10000)).outcome).toBe("duplicate_capture_kept");
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "new-capture", otherPaymentIntentId: "pi_dup", otherHoldsMoney: true }),
        CLUB_FORMAT_TEST,
      );
      expect(mocks.duplicateRefundsHolding).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ bookingId: "booking-1", paymentId: "payment-1" }),
      );
    });

    it("#4285 review 7 F10: the alert shows what the kept capture's card still holds after card refunds recorded against it, not the delivery's amount", async () => {
      primeLedger([ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, status: PaymentStatus.PENDING, amountCents: 10000 })]);
      mocks.sumRecordedRefundsForCapture.mockResolvedValue(2500);

      expect((await arriveAt(10000)).outcome).toBe("duplicate_capture_kept");
      expect(mocks.sumRecordedRefundsForCapture).toHaveBeenCalledWith(tx, expect.objectContaining({ id: "txn-z", paymentIntentId: OTHER_PI }));
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture", amountCents: 7500 }), CLUB_FORMAT_TEST);
    });

    it("a replay of the booking's only capture, already recorded: a silent keep at any amount, a later fee notwithstanding", async () => {
      primeLedger([ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, amountCents: 7000 })]);

      expect((await arriveAt(7000)).outcome).toBe("already_paid");
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
    });

    it("the guard decides on the row's status before this delivery wrote it, never after", async () => {
      // The settle's own write turns the row SUCCEEDED before the guard runs.
      const rows = primeLedger([ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, status: PaymentStatus.PENDING })]);
      mocks.upsertPaymentIntentTransaction.mockImplementation(async () => {
        rows[0]!.status = PaymentStatus.SUCCEEDED;
      });

      expect((await arriveAt(10000)).outcome).toBe("duplicate_capture_kept");
    });

    it("a RECORDED settler's replay is still a silent keep (rule 1)", async () => {
      primeLedger([ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, status: PaymentStatus.PENDING })], { settledBy: "txn-z" });

      expect((await arriveAt(10000)).outcome).toBe("already_paid");
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
    });

    it("F1: a capture its caller wrote SUCCEEDED just before (a saved-card pre-record) is new money, not a replay", async () => {
      primeLedger([ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI })]);

      const result = await markBookingPaymentSucceeded({
        format: CLUB_FORMAT_TEST, bookingId: "booking-1", paymentIntentId: OTHER_PI, amountCents: 10000, paymentMethodId: "pm_1", recordedByCaller: true,
      });

      expect(result.outcome).toBe("duplicate_capture_kept");
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture" }), CLUB_FORMAT_TEST);
    });

    it("F2: the alert is owed in the settle's transaction and cleared once delivered", async () => {
      primeLedger([ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, status: PaymentStatus.PENDING })]);
      const owedKey = `duplicate-capture-new-capture-owed:booking-1:${OTHER_PI}`;
      const owedAtSend: boolean[] = [];
      mocks.sendAdminDuplicateCaptureKeptAlert.mockImplementation(async () => void owedAtSend.push(mocks.owedMarkers.has(owedKey)));

      expect((await arriveAt(10000)).outcome).toBe("duplicate_capture_kept");

      expect(owedAtSend, "owed when the alert went out").toEqual([true]);
      expect(mocks.owedMarkers.has(owedKey), "cleared once delivered").toBe(false);
    });

    it("F4: any delivered alert for the capture answers its owed one - here the no-record alert, once another payment holds money", async () => {
      const owedKey = `duplicate-capture-new-capture-owed:booking-1:${OTHER_PI}`;
      mocks.owedMarkers.add(owedKey);
      primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: "pi_since" }), ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI })]);

      expect((await arriveAt(10000)).outcome).toBe("duplicate_capture_kept");

      expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(expect.objectContaining({ reason: "not-recorded", otherPaymentIntentId: "pi_since" }), CLUB_FORMAT_TEST);
      expect(mocks.owedMarkers.has(owedKey), "the delivered alert cleared the owed new-capture marker").toBe(false);
    });

    it("F2: a send that throws leaves the alert owed, so the capture's replay alerts again; once delivered, a replay is silent", async () => {
      const rows = primeLedger([ledgerRow({ id: "txn-z", stripePaymentIntentId: OTHER_PI, status: PaymentStatus.PENDING })]);
      mocks.upsertPaymentIntentTransaction.mockImplementation(async () => {
        rows[0]!.status = PaymentStatus.SUCCEEDED;
      });
      mocks.sendAdminDuplicateCaptureKeptAlert.mockRejectedValueOnce(new Error("mail down"));

      expect((await arriveAt(10000)).outcome).toBe("duplicate_capture_kept");
      expect(mocks.owedMarkers.size, "still owed after the failed send").toBe(1);

      // The replay reads the row SUCCEEDED, but the alert is still owed.
      expect((await arriveAt(10000)).outcome).toBe("duplicate_capture_kept");
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledTimes(2);
      expect(mocks.owedMarkers.size).toBe(0);

      expect((await arriveAt(10000)).outcome).toBe("already_paid");
      expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledTimes(2);
    });
  });

  it.each([BookingStatus.CANCELLED, BookingStatus.BUMPED, BookingStatus.WAITLISTED, BookingStatus.WAITLIST_OFFERED, BookingStatus.AWAITING_REVIEW])(
    "a booking %s is still not payable: the settle throws and judges nothing",
    async (status) => {
      mocks.bookingFindUnique.mockResolvedValue({ ...makePaidBooking(), status });
      primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: SETTLING_PI })], { settledBy: "txn-y" });

      await expect(arrive(SETTLING_PI)).rejects.toThrow(`Booking is not payable from status ${status}`);
      expect(mocks.paymentTransactionFindFirst).not.toHaveBeenCalled();
      expectNothingWritten();
    },
  );
});

// #4227 / #4283: what the superseded-intent machinery holds - a live operation,
// or (#4227) a superseded refund Stripe failed later that open rows owe back in
// full - is never another capture holding money, and never refunded as a
// duplicate when it is itself the capture arriving.
describe("#4227 / #4283 the superseded machinery's captures, arriving or beside", () => {
  const Y = "pi_settling_y";
  const X = "pi_superseded_x";
  const Z = "pi_third_z";
  const arrive = (paymentIntentId: string) =>
    markBookingPaymentSucceeded({ format: CLUB_FORMAT_TEST, bookingId: "booking-1", paymentIntentId, amountCents: 10000, paymentMethodId: "pm_1" });
  const liveRefundOf = (paymentIntentId: string): RecoveryOperationRow => ({
    id: `op-superseded-${paymentIntentId}`,
    type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
    status: PaymentRecoveryOperationStatus.PENDING,
    paymentId: "payment-1",
    paymentIntentId,
  });
  function expectNothingMoves() {
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).not.toHaveBeenCalled();
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).not.toHaveBeenCalled();
  }

  it("#4283: a superseded capture ARRIVING while its superseded refund is live is not refunded as a duplicate on top", async () => {
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: Y }), ledgerRow({ id: "txn-x", stripePaymentIntentId: X })], { settledBy: "txn-y" });
    primeRecoveryOperations([liveRefundOf(X)]);
    // The Xero conflict's reading: a superseded refund until it SUCCEEDED.
    mocks.supersededHoldsForMember.mockResolvedValue([X]);

    expect((await arrive(X)).outcome).toBe("already_paid");
    expectNothingMoves();
    expect(mocks.supersededHoldsForMember).toHaveBeenCalledWith(tx, "payment-1", expect.any(Array));
  });

  it("#4283 review: an arriving capture behind a DEAD cancel (handed to nobody) is a duplicate like any other and is refunded", async () => {
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: Y }), ledgerRow({ id: "txn-x", stripePaymentIntentId: X })], { settledBy: "txn-y" });
    // (b′) counts the dead cancel as live; the Xero reading does not.
    primeRecoveryOperations([{ ...liveRefundOf(X), type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, status: PaymentRecoveryOperationStatus.FAILED }]);
    mocks.supersededHoldsForMember.mockResolvedValue([]);

    expect((await arrive(X)).outcome).toBe("duplicate_capture_refunded");
    expect(mocks.enqueueDuplicateCaptureRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: X, allocationPlan: [{ paymentTransactionId: "txn-x", amountCents: 10000 }] }),
    );
  });

  it("#4283: held by the superseded machinery and also named by a duplicate-capture refund: no re-send", async () => {
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: Y }), ledgerRow({ id: "txn-x", stripePaymentIntentId: X })], { settledBy: "txn-y" });
    mocks.supersededHoldsForMember.mockResolvedValue([X]);
    mocks.listDuplicateCaptureRefundIntentIds.mockResolvedValue([X]);

    expect((await arrive(X)).outcome).toBe("already_paid");
    expectNothingMoves();
  });

  it("#4283: a superseded capture whose failed-later refund is owed back again, arriving, is not refunded on top either", async () => {
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: Y }), ledgerRow({ id: "txn-x", stripePaymentIntentId: X })], { settledBy: "txn-y" });
    mocks.supersededHoldsForMember.mockResolvedValue([X]);

    expect((await arrive(X)).outcome).toBe("already_paid");
    expectNothingMoves();
  });

  it("#4227: with no record, a replay beside a superseded capture owed back again in full keeps silently - no false 'paid twice' alert", async () => {
    primeLedger([ledgerRow({ id: "txn-x", stripePaymentIntentId: X }), ledgerRow({ id: "txn-y", stripePaymentIntentId: Y })]);
    mocks.supersededHoldsForMember.mockResolvedValue([X]);

    expect((await arrive(Y)).outcome).toBe("already_paid");
    expectNothingMoves();
    // The reading weighs every capture on the payment, in ledger order.
    expect(mocks.supersededHoldsForMember).toHaveBeenCalledWith(tx, "payment-1", expect.any(Array));
    expect(mocks.paymentTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
        where: expect.objectContaining({ paymentId: "payment-1", kind: PaymentTransactionKind.PRIMARY, source: PaymentSource.STRIPE }),
      }),
    );
  });

  it("#4227: non-vacuity - the same ledger with nothing owed back alerts, as before", async () => {
    primeLedger([ledgerRow({ id: "txn-x", stripePaymentIntentId: X }), ledgerRow({ id: "txn-y", stripePaymentIntentId: Y })]);

    expect((await arrive(Y)).outcome).toBe("duplicate_capture_kept");
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ otherPaymentIntentId: X }),
      CLUB_FORMAT_TEST,
    );
  });

  it("#4227: with no record, an owed-back superseded capture is skipped as the settlement, so a real second payment beside it is still reported", async () => {
    primeLedger([
      ledgerRow({ id: "txn-x", stripePaymentIntentId: X }),
      ledgerRow({ id: "txn-z", stripePaymentIntentId: Z }),
      ledgerRow({ id: "txn-y", stripePaymentIntentId: Y }),
    ]);
    mocks.supersededHoldsForMember.mockResolvedValue([X]);

    expect((await arrive(Y)).outcome).toBe("duplicate_capture_kept");
    expect(mocks.sendAdminDuplicateCaptureKeptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: Y, otherPaymentIntentId: Z }),
      CLUB_FORMAT_TEST,
    );
  });

  it("#4227: a recorded settler the superseded machinery owes back again, beside nothing else, keeps silently (as a live operation would)", async () => {
    primeLedger([ledgerRow({ id: "txn-y", stripePaymentIntentId: Y }), ledgerRow({ id: "txn-z", stripePaymentIntentId: Z })], { settledBy: "txn-y" });
    mocks.supersededHoldsForMember.mockResolvedValue([Y]);

    expect((await arrive(Z)).outcome).toBe("already_paid");
    expectNothingMoves();
  });

  it("#4227: a third capture beside the recorded settler and an owed-back superseded capture is refunded, naming the settler", async () => {
    primeLedger(
      [ledgerRow({ id: "txn-x", stripePaymentIntentId: X }), ledgerRow({ id: "txn-y", stripePaymentIntentId: Y }), ledgerRow({ id: "txn-z", stripePaymentIntentId: Z })],
      { settledBy: "txn-y" },
    );
    mocks.supersededHoldsForMember.mockResolvedValue([X]);

    expect((await arrive(Z)).outcome).toBe("duplicate_capture_refunded");
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: Z, settledPaymentIntentId: Y }),
      CLUB_FORMAT_TEST,
    );
  });
});

// #4103 (`INV-PAY-130`): Stripe can answer the duplicate's refund `failed` or
// `canceled` without throwing. Nothing went back: the pre-persisted row stays
// open, re-planned on the slice's next key, and the door reports a failure -
// never "refunded", never the admin-only REFUNDED history event. Its own
// failure alert is the refusal's one alert. The duplicate is one capture, so its
// plan is one slice: "one made beside one refused" and "refused then thrown"
// cannot arise here (the capacity race's suite covers them).
describe("#4103 a duplicate-capture refund Stripe refuses", () => {
  const refused = (status: string) => ({
    refunds: [
      {
        status,
        slice: { paymentTransactionId: "txn-duplicate", amountCents: 10000 },
        refundId: "re_dup",
        paymentIntentId: DUPLICATE_PI,
        amountCents: 10000,
      },
    ],
  });
  const settle = () =>
    markBookingPaymentSucceeded({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: DUPLICATE_PI,
      amountCents: 10000,
      paymentMethodId: "pm_1",
    });

  it.each([["failed"], ["canceled"]])("answered %s: the row stays open on the next key, the door reports a failure, and alerts once", async (status) => {
    primeDuplicateCaptureLedger();
    mocks.refundPaymentTransactions.mockResolvedValue(refused(status));

    const result = await settle();

    expect(result.outcome).toBe("duplicate_capture_refund_failed");
    expect(result.refundError).toMatch(/Stripe refused \$100\.00 .*still owed/);
    expect(mocks.markDuplicateCaptureRefundRecoverySucceeded).not.toHaveBeenCalled();
    expect(mocks.recordDuplicateCaptureRefundEvent).not.toHaveBeenCalled();
    expect(mocks.recoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        idempotencyKey: buildDuplicateCaptureRefundRecoveryIdempotencyKey("booking-1", DUPLICATE_PI),
        status: PaymentRecoveryOperationStatus.PENDING,
        attempts: 0,
        // #4103 review C2: compare-and-set on the plan the row held (none read, here).
        allocationPlan: { equals: Prisma.DbNull },
      },
      data: {
        allocationPlan: [{ paymentTransactionId: "txn-duplicate", amountCents: 10000, stripeKeySuffix: "refused1" }],
        lastError: result.refundError,
      },
    });
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).toHaveBeenCalledWith(
      expect.objectContaining({ refundFailed: true, errorMessage: expect.stringMatching(/Stripe refused/) }),
      CLUB_FORMAT_TEST,
    );
    // The shared refusal alert is not sent beside the door's own.
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("a replay whose row a worker already holds moves nothing and stays quiet: the worker alerts as it moves the slice", async () => {
    primeDuplicateCaptureLedger();
    mocks.refundPaymentTransactions.mockResolvedValue(refused("failed"));
    mocks.recoveryUpdateMany.mockResolvedValue({ count: 0 });

    const result = await settle();

    expect(result.outcome).toBe("duplicate_capture_refund_failed");
    expect(mocks.markDuplicateCaptureRefundRecoverySucceeded).not.toHaveBeenCalled();
    expect(mocks.sendAdminDuplicateCaptureRefundAlert).not.toHaveBeenCalled();
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });
});

describe("#1992 recovery key builders and replay-metadata mapping", () => {
  it("#4211: the duplicate intent is read back from its booking's operation key, and from nothing else", () => {
    const key = buildDuplicateCaptureRefundRecoveryIdempotencyKey("booking-1", "pi_x");
    expect(duplicateCaptureIntentIdForRecoveryKey("booking-1", key)).toBe("pi_x");
    // The bare prefix names no intent.
    expect(
      duplicateCaptureIntentIdForRecoveryKey("booking-1", buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking("booking-1")),
    ).toBeNull();
    // Another booking whose id merely begins with this one's.
    expect(
      duplicateCaptureIntentIdForRecoveryKey("booking-1", buildDuplicateCaptureRefundRecoveryIdempotencyKey("booking-12", "pi_x")),
    ).toBeNull();
    // Another prefix family: the Stripe key prefix and the capacity-race refund.
    expect(
      duplicateCaptureIntentIdForRecoveryKey("booking-1", buildDuplicateCaptureRefundStripeKeyPrefix("booking-1", "pi_x")),
    ).toBeNull();
    expect(
      duplicateCaptureIntentIdForRecoveryKey("booking-1", buildCapacityClaimFailedRefundRecoveryIdempotencyKey("booking-1", "pi_x")),
    ).toBeNull();
  });

  it("the operation idempotency key is duplicate_capture_<bookingId>_<intentId> and shares the per-booking prefix", () => {
    expect(
      buildDuplicateCaptureRefundRecoveryIdempotencyKey("booking-1", "pi_x")
    ).toBe("duplicate_capture_booking-1_pi_x");
    expect(
      buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking("booking-1")
    ).toBe("duplicate_capture_booking-1_");
    expect(
      buildDuplicateCaptureRefundRecoveryIdempotencyKey(
        "booking-1",
        "pi_x"
      ).startsWith(
        buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking("booking-1")
      )
    ).toBe(true);
  });

  it("the Stripe key prefix maps back to the inline metadata reason, so a cron replay reconstructs a byte-identical refund body", () => {
    const prefix = buildDuplicateCaptureRefundStripeKeyPrefix(
      "booking-1",
      "pi_x"
    );
    expect(prefix).toBe("duplicate_capture_refund_booking-1_pi_x");
    expect(bookingModificationRefundReasonForKeyPrefix(prefix)).toBe(
      "duplicate_capture"
    );
  });
});
