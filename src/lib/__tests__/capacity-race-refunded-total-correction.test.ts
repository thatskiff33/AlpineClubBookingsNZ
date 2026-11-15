import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4154 (`INV-PAY-135`, owner decision 15 Oct 2026: "Guarded recalculation"):
 * a capacity race's card charge whose refunded total reads more than its refund
 * rows is corrected - lowered to them - before its hand-back is recorded, and
 * only when every condition holds. Each condition is shown blocking ALONE
 * against a baseline that corrects; the write is shown never to raise.
 *
 * The totals' writers are doubled (`compareAndSetRefundedAmount` is driven
 * through the function the correction hands it, so the never-raise rule is
 * the module's own); the real-database proof is
 * `capacity-race-refund-shortfall-task.realdb.test.ts`.
 */
const doubles = vi.hoisted(() => ({
  ledgerStart: vi.fn<() => Promise<number | null>>(),
  lock: vi.fn(async () => {}),
  compareAndSet: vi.fn(),
  reconcile: vi.fn(async () => null),
  credit: vi.fn<() => Promise<number>>(),
  audit: vi.fn(async () => {}),
  resolvedNotes: vi.fn(async () => ({ coveredCents: 0, correlationKeys: [] as string[], operationIds: [] as string[], unreadableOperationIds: [] as string[] })),
  noteCoverage: vi.fn(async () => 0),
  taskHead: vi.fn(),
  getPaymentIntent: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/payment-transactions", async (importOriginal) => {
  // The refund-row sums are the real ones: they read the store's aggregate.
  const actual = (await importOriginal()) as typeof import("@/lib/payment-transactions");
  return {
    sumRecordedRefundsForTransaction: actual.sumRecordedRefundsForTransaction,
    sumRecordedRefundsForPayment: actual.sumRecordedRefundsForPayment,
    refundLedgerStartSeconds: doubles.ledgerStart,
    lockPaymentForRefundedTotal: doubles.lock,
    compareAndSetRefundedAmount: doubles.compareAndSet,
    reconcilePaymentAggregates: doubles.reconcile,
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: { manualRefundTask: { findUnique: doubles.taskHead } } }));
vi.mock("@/lib/stripe", () => ({ getPaymentIntent: doubles.getPaymentIntent }));
vi.mock("@/lib/card-refund-status-sync", () => ({ READ_BACK_TIMEOUT_MS: 10_000 }));
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({ accountCreditDispositionCents: doubles.credit }));
vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({
  readResolvedRefundCreditNoteCoverage: doubles.resolvedNotes,
  sumRefundCreditNoteCoverageCents: doubles.noteCoverage,
  // Round 5: what one close's own notes put in coverage (`readPaidAnotherWayCloseShare`), keyed by the record it names.
  sumRefundCreditNoteCoverageOfRowsCents: async (_paymentId: string, rowsWhere: { requestPayload: { equals: string } }) =>
    closeNotesInCoverage.get(rowsWhere.requestPayload.equals) ?? 0,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: doubles.audit }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/manual-booking-payment-error", () => ({
  ManualBookingPaymentError: class extends Error {
    constructor(message: string, readonly status = 400) {
      super(message);
    }
  },
}));

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  CAPACITY_RACE_CORRECTION_BLOCKED_REASON,
  CAPACITY_RACE_XERO_SENTENCE,
  CAPACITY_RACE_STRIPE_UNREADABLE_MESSAGE,
  capacityRaceChargeForHandBack,
  capacityRaceNothingToAllocateMessage,
  readCapacityRaceStripeRefundedForTask,
  type CapacityRaceCorrectionBlocked,
  type CapacityRaceStripeRefunded,
} from "@/lib/capacity-race-refunded-total-correction";

const at = (seconds: number) => new Date(seconds * 1000);
const LEDGER_START = 1_000;

type Charge = { id: string; amountCents: number; refundedAmountCents: number; createdAt: Date };
type Refund = { amountCents: number; status: string; stripeCreatedAt: Date | null; paymentTransactionId?: string };

/** The baseline: a $200 charge made after the ledger started, reading all of it refunded, with $140 of card refund on record. */
/** A completed task on the payment whose bank cash the note pipeline reads (`readPaidAnotherWayCash`), noted by `noteRows`. */
/** Its own notes put `inCoverageCents` into the payment's coverage: sent and linked, or (round 5) none, when FAILED or queued. */
type BankCashRecord = { id: string; kind: string; occurrenceKey: string; amountCents: number; reviewContext: unknown; noteRows: number; inCoverageCents: number };
const closeNotesInCoverage = new Map<string, number>();

function world(over: { charges?: Charge[]; otherCharges?: Charge[]; refunds?: Refund[]; otherTasks?: number; bankCash?: BankCashRecord[] } = {}) {
  closeNotesInCoverage.clear();
  for (const record of over.bankCash ?? []) closeNotesInCoverage.set(record.id, record.inCoverageCents);
  const charges = over.charges ?? [{ id: "txn-race", amountCents: 20_000, refundedAmountCents: 20_000, createdAt: at(2_000) }];
  const otherCharges = over.otherCharges ?? [];
  const refunds = (over.refunds ?? [{ amountCents: 14_000, status: "succeeded", stripeCreatedAt: at(3_000) }]).map((refund) => ({ paymentTransactionId: "txn-race", ...refund }));
  return {
    // The race intent's charges, or (round 3) the payment's other captured charges, as the query asks.
    paymentTransaction: { findMany: vi.fn(async ({ where }: { where: { id?: { not: string } } }) => (where.id ? otherCharges : charges)) },
    manualRefundTask: { count: vi.fn(async () => over.otherTasks ?? 0), update: vi.fn(async () => ({})), findMany: vi.fn(async () => over.bankCash ?? []),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => over.bankCash?.find((task) => task.id === where.id) ?? null) },
    xeroSyncOperation: { count: vi.fn(async ({ where }: { where: { requestPayload: { equals: string } } }) => over.bankCash?.find((task) => task.id === where.requestPayload.equals)?.noteRows ?? 0) },
    paymentRefund: {
      findMany: vi.fn(async () => refunds.filter((refund) => refund.paymentTransactionId === "txn-race")),
      // What a Prisma aggregate answers: the rows on the charge (or the whole payment), less the statuses it is told to leave out.
      aggregate: vi.fn(async ({ where }: { where: { paymentTransactionId?: string; status: { notIn: string[] } } }) => ({
        _sum: {
          amountCents: refunds
            .filter((refund) => (where.paymentTransactionId === undefined || refund.paymentTransactionId === where.paymentTransactionId) && !where.status.notIn.includes(refund.status))
            .reduce((sum, refund) => sum + refund.amountCents, 0),
        },
      })),
    },
  };
}

/** What Stripe says the charge refunded: by default, exactly the card refund on record. */
const STRIPE_AGREES: CapacityRaceStripeRefunded = { readable: true, refundedCents: 14_000 };

const run = (store: ReturnType<typeof world>, over: { amountCents?: number; stripe?: CapacityRaceStripeRefunded | null; invoiced?: boolean } = {}) =>
  capacityRaceChargeForHandBack(store as never, {
    task: { id: "task-race", bookingId: "booking-1", paymentId: "payment-1", booking: { memberId: "member-1" } },
    raceIntentId: "pi_race",
    amountCents: over.amountCents ?? 6_000,
    stripe: over.stripe === undefined ? STRIPE_AGREES : over.stripe,
    invoiced: over.invoiced ?? true,
    actingMemberId: "officer-1",
    format: CLUB_FORMAT_TEST,
  });

const nothingWritten = () => {
  expect(doubles.compareAndSet).not.toHaveBeenCalled();
  expect(doubles.reconcile).not.toHaveBeenCalled();
  expect(doubles.audit).not.toHaveBeenCalled();
};

const expectBlocked = async (store: ReturnType<typeof world>, blocked: CapacityRaceCorrectionBlocked) => {
  await expect(run(store)).rejects.toMatchObject({
    status: 400,
    message: `${capacityRaceNothingToAllocateMessage(blocked === "noted" ? "noted" : "invoiced")} (The app could not correct the charge's records itself: ${CAPACITY_RACE_CORRECTION_BLOCKED_REASON[blocked]}.)`,
  });
  nothingWritten();
};

describe("a capacity race's charge corrected for its hand-back (#4154, INV-PAY-135)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.ledgerStart.mockResolvedValue(LEDGER_START);
    doubles.credit.mockResolvedValue(0);
    doubles.noteCoverage.mockResolvedValue(0);
    doubles.compareAndSet.mockImplementation(async (_db: unknown, _id: string, nextFrom: (row: { amountCents: number; refundedAmountCents: number }) => number) => {
      const row = { amountCents: 20_000, refundedAmountCents: 20_000 };
      return { previousCents: row.refundedAmountCents, nextCents: nextFrom(row) };
    });
  });

  it("CONTROL: every condition holding, lowers the charge to its refund rows, re-derives the payment, audits before and after, and hands back the charge", async () => {
    const store = world();

    await expect(run(store)).resolves.toMatchObject({ chargeId: "txn-race" });

    expect(store.paymentTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ paymentId: "payment-1", stripePaymentIntentId: "pi_race" }) }));
    expect(doubles.compareAndSet).toHaveBeenCalledWith(store, "txn-race", expect.any(Function), { writeStatus: true });
    expect(doubles.reconcile).toHaveBeenCalledWith({ paymentId: "payment-1", store });
    expect(doubles.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.capacity-race.refunded-total-corrected",
        summary: expect.stringContaining("corrected from $200.00 to $140.00"),
        actorMemberId: "officer-1",
        // #4154 review (M5): against the booking's owner, as the sibling hand-back writers' are.
        subjectMemberId: "member-1",
        category: "payment",
        entityId: "txn-race",
        metadata: expect.objectContaining({ refundedBeforeCents: 20_000, refundedAfterCents: 14_000, manualRefundTaskId: "task-race" }),
      }),
      store,
    );
  });

  it("MUTATION (review M7): takes the Payment row lock itself, before it reads the charge", async () => {
    const store = world();
    await run(store);
    expect(doubles.lock).toHaveBeenCalledWith(store, "payment-1");
    expect(doubles.lock.mock.invocationCallOrder[0]!).toBeLessThan(store.paymentTransaction.findMany.mock.invocationCallOrder[0]!);
  });

  it("a charge that already holds the task is not touched", async () => {
    const store = world({ charges: [{ id: "txn-race", amountCents: 20_000, refundedAmountCents: 14_000, createdAt: at(2_000) }] });
    await expect(run(store)).resolves.toMatchObject({ chargeId: "txn-race" });
    expect(doubles.ledgerStart).not.toHaveBeenCalled();
    expect(doubles.compareAndSet).not.toHaveBeenCalled();
  });

  it("MUTATION (never raise): the write takes the smaller of the row's total and the refund rows' - a row already below them stays", async () => {
    await run(world());
    const nextFrom = doubles.compareAndSet.mock.calls[0]![2] as (row: { amountCents: number; refundedAmountCents: number }) => number;
    expect(nextFrom({ amountCents: 20_000, refundedAmountCents: 20_000 })).toBe(14_000);
    expect(nextFrom({ amountCents: 20_000, refundedAmountCents: 9_000 })).toBe(9_000);
  });

  it("MUTATION: a row that moved under the write so the charge no longer holds the task is refused after all", async () => {
    doubles.compareAndSet.mockResolvedValue({ previousCents: 20_000, nextCents: 18_000 });
    await expect(run(world())).rejects.toMatchObject({ message: expect.stringContaining(CAPACITY_RACE_CORRECTION_BLOCKED_REASON["still-short"]) });
  });

  it("a refused or cancelled refund row is not a refund on record", async () => {
    const store = world({ refunds: [{ amountCents: 14_000, status: "succeeded", stripeCreatedAt: at(3_000) }, { amountCents: 6_000, status: "failed", stripeCreatedAt: at(3_100) }] });
    await expect(run(store)).resolves.toMatchObject({ chargeId: "txn-race" });
    expect(doubles.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ recordedCardRefundCents: 14_000 }) }), store);
  });

  it("an install with no migration history never ran pre-ledger code: the date conditions hold", async () => {
    doubles.ledgerStart.mockResolvedValue(null);
    await expect(run(world())).resolves.toMatchObject({ chargeId: "txn-race" });
  });

  describe("each condition blocks alone", () => {
    it("MUTATION: no captured charge for the race's intent", async () => {
      await expectBlocked(world({ charges: [] }), "no-charge");
    });

    it("MUTATION: the charge made before the refund ledger started", async () => {
      await expectBlocked(world({ charges: [{ id: "txn-race", amountCents: 20_000, refundedAmountCents: 20_000, createdAt: at(LEDGER_START - 1) }] }), "charge-before-ledger");
    });

    it("MUTATION: account credit given back from the booking", async () => {
      doubles.credit.mockResolvedValue(1);
      await expectBlocked(world(), "account-credit");
    });

    it("MUTATION: another refund task on the booking or its payment", async () => {
      const store = world({ otherTasks: 1 });
      await expectBlocked(store, "other-task");
      expect(store.manualRefundTask.count).toHaveBeenCalledWith({
        where: { id: { not: "task-race" }, OR: [{ bookingId: "booking-1" }, { paymentId: "payment-1" }] },
      });
    });

    it.each([
      ["dated before the ledger started", at(LEDGER_START - 1)],
      ["undated", null],
    ])("MUTATION: a refund row on the charge %s", async (_label, stripeCreatedAt) => {
      await expectBlocked(world({ refunds: [{ amountCents: 14_000, status: "succeeded", stripeCreatedAt }] }), "pre-ledger-refund");
    });

    it("MUTATION (never raise): the refund rows already account for all the charge reads refunded", async () => {
      await expectBlocked(world({ refunds: [{ amountCents: 20_000, status: "succeeded", stripeCreatedAt: at(3_000) }] }), "nothing-to-lower");
    });

    it("MUTATION: even corrected, the charge would not hold the task", async () => {
      await expectBlocked(world({ refunds: [{ amountCents: 16_000, status: "succeeded", stripeCreatedAt: at(3_000) }] }), "still-short");
    });
  });
  describe("review M2 and round 2 F1: Xero refund notes beyond the card refunds on record", () => {
    // The baseline task is $60.00, on a charge with $140.00 of card refunds on record.
    it("MUTATION (F1): a card note beyond the refund rows that the task's amount explains - the self-heal's note for the stray total - is recorded on the task as covering it, and the completion goes ahead", async () => {
      doubles.noteCoverage.mockResolvedValue(14_000 + 6_000);
      const store = world();
      await expect(run(store)).resolves.toMatchObject({ chargeId: "txn-race" });
      expect(store.manualRefundTask.update).toHaveBeenCalledWith({ where: { id: "task-race" }, data: { reviewContext: { paidAnotherWayCardNoteCover: 6_000 } } });
      expect(doubles.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ cardNoteCoversCents: 6_000 }) }), store);
      expect(doubles.noteCoverage).toHaveBeenCalledWith("payment-1", expect.objectContaining({ coveredCents: 0 }), expect.anything());
    });

    it("MUTATION (F1): one cent more than the task explains is refused, naming no note to raise, and nothing is written", async () => {
      doubles.noteCoverage.mockResolvedValue(14_000 + 6_001);
      const store = world();
      await expectBlocked(store, "noted");
      await expect(run(store)).rejects.toMatchObject({ message: expect.not.stringContaining("raise its refund credit note in Xero by hand") });
      expect(store.manualRefundTask.update).not.toHaveBeenCalled();
    });

    it("MUTATION: a note resolved by hand whose amount cannot be read blocks it too", async () => {
      doubles.resolvedNotes.mockResolvedValueOnce({ coveredCents: 0, correlationKeys: [], operationIds: ["op-1"], unreadableOperationIds: ["op-1"] });
      await expectBlocked(world(), "noted");
    });

    // Round 3 (1): a refusal where a card note already answers part of this money never says "raise it by hand".
    it("MUTATION (round 3, 1): still short with a card note's cover - refused naming the note already in Xero, never a note by hand", async () => {
      // $160.00 of card refunds on record, $190.00 of notes: a $30.00 card note's cover, and the charge still too short.
      doubles.noteCoverage.mockResolvedValue(19_000);
      const store = world({ refunds: [{ amountCents: 16_000, status: "succeeded", stripeCreatedAt: at(3_000) }] });
      await expect(run(store, { stripe: { readable: true, refundedCents: 16_000 } })).rejects.toMatchObject({
        status: 400,
        message: `${capacityRaceNothingToAllocateMessage("noted")} (The app could not correct the charge's records itself: ${CAPACITY_RACE_CORRECTION_BLOCKED_REASON["still-short"]}.)`,
      });
      await expect(run(store, { stripe: { readable: true, refundedCents: 16_000 } })).rejects.toMatchObject({ message: expect.not.stringContaining("raise its refund credit note in Xero by hand") });
      expect(store.manualRefundTask.update).not.toHaveBeenCalled();
    });

    it.each([
      ["account credit given back", () => doubles.credit.mockResolvedValue(1)],
      ["the charge made before the ledger", () => undefined],
    ])("MUTATION (round 3, 1): an earlier condition (%s) with a card note's cover says the same", async (label, arrange) => {
      doubles.noteCoverage.mockResolvedValue(14_000 + 1_000);
      arrange();
      const store = label.startsWith("the charge")
        ? world({ charges: [{ id: "txn-race", amountCents: 20_000, refundedAmountCents: 20_000, createdAt: at(LEDGER_START - 1) }] })
        : world();
      await expect(run(store)).rejects.toMatchObject({ message: expect.stringContaining(CAPACITY_RACE_XERO_SENTENCE.noted) });
    });

    // Round 3 (5): notes are kept per payment; the excess is the race charge's only while every other charge postdates the ledger.
    it("MUTATION (round 3, 5): a card note's cover on a payment with another charge made before the refund ledger is refused, nothing written", async () => {
      doubles.noteCoverage.mockResolvedValue(14_000 + 6_000);
      const store = world({ otherCharges: [{ id: "txn-old", amountCents: 5_000, refundedAmountCents: 5_000, createdAt: at(LEDGER_START - 1) }] });
      await expectBlocked(store, "noted");
      expect(store.manualRefundTask.update).not.toHaveBeenCalled();
    });

    it("CONTROL (round 3, 5): another charge made since the ledger leaves the cover the race's", async () => {
      doubles.noteCoverage.mockResolvedValue(14_000 + 6_000);
      const store = world({ otherCharges: [{ id: "txn-late", amountCents: 5_000, refundedAmountCents: 0, createdAt: at(2_500) }] });
      await expect(run(store)).resolves.toEqual({ chargeId: "txn-race", xero: "noted" });
      expect(store.manualRefundTask.update).toHaveBeenCalledWith({ where: { id: "task-race" }, data: { reviewContext: { paidAnotherWayCardNoteCover: 6_000 } } });
    });

    // Round 4 (F3): a note for another refund's bank cash on the payment is that refund's, not a cover for this money.
    it("MUTATION (round 4, F3): a note answering a completed hand-back's noted bank cash leaves the refusal asking for this money's own note", async () => {
      doubles.noteCoverage.mockResolvedValue(14_000 + 5_000);
      const store = world({
        otherTasks: 1,
        bankCash: [{ id: "task-bank", kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1", amountCents: 5_000, reviewContext: null, noteRows: 1, inCoverageCents: 5_000 }],
      });
      await expect(run(store)).rejects.toMatchObject({
        message: `${capacityRaceNothingToAllocateMessage("invoiced")} (The app could not correct the charge's records itself: ${CAPACITY_RACE_CORRECTION_BLOCKED_REASON["other-task"]}.)`,
      });
    });

    it("CONTROL (round 4, F3): coverage beyond that hand-back's noted cash still reads as a note that may cover this money", async () => {
      doubles.noteCoverage.mockResolvedValue(14_000 + 5_000 + 1);
      const store = world({
        otherTasks: 1,
        bankCash: [{ id: "task-bank", kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1", amountCents: 5_000, reviewContext: null, noteRows: 1, inCoverageCents: 5_000 }],
      });
      await expect(run(store)).rejects.toMatchObject({ message: expect.stringContaining(CAPACITY_RACE_XERO_SENTENCE.noted) });
    });

    // Round 5 (1): a noted record's own note explains coverage only once it is in it.
    it("MUTATION (round 5, 1): a hand-back noted but whose note is not in coverage (FAILED) explains none of a card note's excess - the refusal says to check that note", async () => {
      // $140.00 of card refunds on record, and an $80.00 card note beside them; the $100.00 hand-back's own note never sent.
      doubles.noteCoverage.mockResolvedValue(14_000 + 8_000);
      const store = world({
        otherTasks: 1,
        bankCash: [{ id: "task-bank", kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1", amountCents: 10_000, reviewContext: null, noteRows: 1, inCoverageCents: 0 }],
      });
      await expect(run(store)).rejects.toMatchObject({ message: expect.stringContaining(CAPACITY_RACE_XERO_SENTENCE.noted) });
      await expect(run(store)).rejects.toMatchObject({ message: expect.not.stringContaining("raise its refund credit note in Xero by hand") });
    });

    it("CONTROL (round 5, 1): the same hand-back with its note sent explains the coverage it put there", async () => {
      doubles.noteCoverage.mockResolvedValue(14_000 + 10_000);
      const store = world({
        otherTasks: 1,
        bankCash: [{ id: "task-bank", kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1", amountCents: 10_000, reviewContext: null, noteRows: 1, inCoverageCents: 10_000 }],
      });
      await expect(run(store)).rejects.toMatchObject({ message: expect.stringContaining("Then raise its refund credit note in Xero by hand") });
    });

    // Round 4 (F4): the gaps the lens named.
    it("MUTATION (round 4, F4): a payment with another charge made before the ledger and NO card note's cover completes normally", async () => {
      doubles.noteCoverage.mockResolvedValue(14_000);
      const store = world({ otherCharges: [{ id: "txn-old", amountCents: 5_000, refundedAmountCents: 5_000, createdAt: at(LEDGER_START - 1) }] });
      await expect(run(store)).resolves.toEqual({ chargeId: "txn-race", xero: "invoiced" });
      expect(doubles.compareAndSet).toHaveBeenCalled();
    });

    it("MUTATION (round 4, F4): an unreadable hand-resolved note makes an earlier refusal (other task) say to check the note there too", async () => {
      doubles.resolvedNotes.mockResolvedValueOnce({ coveredCents: 0, correlationKeys: [], operationIds: ["op-1"], unreadableOperationIds: ["op-1"] });
      await expect(run(world({ otherTasks: 1 }))).rejects.toMatchObject({
        message: `${capacityRaceNothingToAllocateMessage("noted")} (The app could not correct the charge's records itself: ${CAPACITY_RACE_CORRECTION_BLOCKED_REASON["other-task"]}.)`,
      });
    });

    it("CONTROL: notes covering exactly the card refunds on record record nothing on the task", async () => {
      doubles.noteCoverage.mockResolvedValue(14_000);
      const store = world();
      await expect(run(store)).resolves.toMatchObject({ chargeId: "txn-race" });
      expect(store.manualRefundTask.update).not.toHaveBeenCalled();
    });
  });

  describe("review M1: Stripe has refunded no more of the charge than its refund rows", () => {
    it.each([
      ["unread", { readable: false } as const],
      ["never asked (no read passed)", null],
    ])("MUTATION: Stripe %s - refused (409), retry later, nothing written, even where the charge holds the task", async (_label, stripe) => {
      for (const store of [world(), world({ charges: [{ id: "txn-race", amountCents: 20_000, refundedAmountCents: 14_000, createdAt: at(2_000) }] })]) {
        await expect(run(store, { stripe })).rejects.toMatchObject({ status: 409, message: CAPACITY_RACE_STRIPE_UNREADABLE_MESSAGE });
      }
      nothingWritten();
    });

    it("MUTATION: Stripe showing more refunded than the rows - a dashboard refund whose webhook is late - refused (409), naming both figures, even where the charge holds the task", async () => {
      for (const store of [world(), world({ charges: [{ id: "txn-race", amountCents: 20_000, refundedAmountCents: 14_000, createdAt: at(2_000) }] })]) {
        await expect(run(store, { stripe: { readable: true, refundedCents: 14_001 } })).rejects.toMatchObject({
          status: 409,
          message: "Stripe shows $140.01 of this card charge refunded, but the app has recorded only $140.00: a refund made in Stripe may not have reached the app yet. Try again in a few minutes, and do not pay it until the app accepts. If the member was refunded in Stripe, dismiss this task with a note saying how.",
        });
      }
      nothingWritten();
    });

    it("a refused refund row is not one Stripe counts either: Stripe at the counted rows passes", async () => {
      const store = world({ refunds: [{ amountCents: 14_000, status: "succeeded", stripeCreatedAt: at(3_000) }, { amountCents: 6_000, status: "failed", stripeCreatedAt: at(3_100) }] });
      await expect(run(store, { stripe: { readable: true, refundedCents: 14_000 } })).resolves.toMatchObject({ chargeId: "txn-race" });
    });
  });

  describe("the refusal's words (review M4, M6)", () => {
    it("says too little of the charge is left, and raises the Xero note by hand only where the booking has an invoice", async () => {
      await expect(run(world({ otherTasks: 1 }))).rejects.toMatchObject({
        message: expect.stringMatching(/^The payment's records show too little of this card charge left to refund.*Then raise its refund credit note in Xero by hand: the app will not raise one\. \(The app could not/),
      });
      const uninvoiced = run(world({ otherTasks: 1 }), { invoiced: false });
      await expect(uninvoiced).rejects.toMatchObject({ message: expect.stringContaining("The booking has no Xero invoice to credit, so no refund credit note is needed.") });
      await expect(run(world({ otherTasks: 1 }), { invoiced: false })).rejects.toMatchObject({ message: expect.not.stringContaining("raise its refund credit note") });
    });
  });

  describe("review M1: the Stripe read, before the transaction", () => {
    const RACE_TASK = { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1:capacity-race:pi_race:check", bookingId: "booking-1" };

    it("reads the race intent's latest charge, bounded and without retries, and hands back what it refunded", async () => {
      doubles.taskHead.mockResolvedValue(RACE_TASK);
      doubles.getPaymentIntent.mockResolvedValue({ latest_charge: { id: "ch_1", amount_refunded: 14_000 } });
      await expect(readCapacityRaceStripeRefundedForTask("task-race")).resolves.toEqual({ readable: true, refundedCents: 14_000 });
      expect(doubles.getPaymentIntent).toHaveBeenCalledWith("pi_race", { timeoutMs: 10_000, expand: ["latest_charge"] });
    });

    it("asks Stripe nothing for any other task", async () => {
      doubles.taskHead.mockResolvedValue({ ...RACE_TASK, occurrenceKey: "cancel-card-shortfall:booking-1:check" });
      await expect(readCapacityRaceStripeRefundedForTask("task-9")).resolves.toBeNull();
      doubles.taskHead.mockResolvedValue(null);
      await expect(readCapacityRaceStripeRefundedForTask("task-gone")).resolves.toBeNull();
      expect(doubles.getPaymentIntent).not.toHaveBeenCalled();
    });

    it.each([
      ["Stripe unreachable", () => doubles.getPaymentIntent.mockRejectedValue(new Error("timeout"))],
      ["no charge expanded", () => doubles.getPaymentIntent.mockResolvedValue({ latest_charge: "ch_1" })],
      ["no charge at all", () => doubles.getPaymentIntent.mockResolvedValue({ latest_charge: null })],
    ])("MUTATION: %s reads as unread, never as nothing refunded", async (_label, answer) => {
      doubles.taskHead.mockResolvedValue(RACE_TASK);
      answer();
      await expect(readCapacityRaceStripeRefundedForTask("task-race")).resolves.toEqual({ readable: false });
    });
  });
});
