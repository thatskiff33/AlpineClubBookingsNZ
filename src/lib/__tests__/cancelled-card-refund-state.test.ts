import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentRecoveryOperationStatus } from "@prisma/client";

import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { buildOrganiserChildCancellationRefundKey } from "@/lib/payment-recovery-keys";
import { paidAnotherWayCloseCents } from "@/lib/paid-another-way-close-cents";

/**
 * #4125: where a card cancel's refund stands when no REFUNDED event says it was
 * made - read from its recovery row (the member's cancel or the capacity race),
 * so the booking page never reads a dead refund as "on its way".
 */
const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findClose: vi.fn(),
  tasks: vi.fn(),
  payments: vi.fn(),
  findRecord: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: { findMany: db.findMany, findUnique: db.findUnique },
    manualRefundTask: { findFirst: db.findClose, findMany: db.tasks, findUnique: db.findRecord },
    payment: { findMany: db.payments },
  },
}));

import { readCancelledCardRefund, readCardShortfallTaskStatuses, readOrganiserChildCancelledCardRefund } from "@/lib/cancel-card-refund-shortfall-status";

const readCancelledCardRefundState = async (bookingId: string) => (await readCancelledCardRefund(bookingId)).cardRefundState;

type Row = { id: string; idempotencyKey: string; paymentId: string; status: PaymentRecoveryOperationStatus; attempts: number; nextRetryAt: Date | null };
const row = (overrides: Partial<Row> = {}): Row => ({
  id: "op-1",
  paymentId: "pay-1",
  idempotencyKey: "capacity_claim_failed_refund_recovery_booking-1_pi_1",
  status: PaymentRecoveryOperationStatus.PENDING,
  attempts: 0,
  nextRetryAt: new Date("2026-07-01T00:05:00.000Z"),
  ...overrides,
});

/** The payment the closed rows hang on: `made` refunds recorded against op-1's first slice. */
function paymentWith(made: number[], operations: Array<{ id: string; amountCents: number; plan: Array<{ paymentTransactionId: string; amountCents: number; madeRefundId?: string }> }>) {
  return {
    id: "pay-1",
    status: "PARTIALLY_REFUNDED",
    amountCents: 20_000,
    refundedAmountCents: made.reduce((sum, cents) => sum + cents, 0),
    recoveryOperations: operations.map(({ id, amountCents, plan }) => ({
      id,
      type: "REFUND_BOOKING_MODIFICATION",
      status: "SUCCEEDED",
      idempotencyKey: `capacity_claim_failed_refund_recovery_booking-1_pi_${id}`,
      amountCents,
      allocationPlan: plan,
      paymentTransactionId: null,
      createdAt: new Date("2026-06-20T00:00:00.000Z"),
      succeededAt: new Date("2026-06-30T00:00:00.000Z"),
    })),
    refunds: made.map((cents, index) => ({
      stripeRefundId: `re_${index}`,
      paymentTransactionId: "txn-1",
      amountCents: cents,
      status: "succeeded",
      createdAt: new Date("2026-06-21T00:00:00.000Z"),
      stripeCreatedAt: new Date("2026-06-21T00:00:00.000Z"),
    })),
  };
}

describe("readCancelledCardRefund (#4125)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findClose.mockResolvedValue(null);
  });

  it("reads the member's cancel row and this booking's capacity-race rows, in one query", async () => {
    db.findMany.mockResolvedValue([]);

    expect(await readCancelledCardRefundState("booking-1")).toBeUndefined();

    expect(db.findMany).toHaveBeenCalledTimes(1);
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        // On the bookingId index, never a scan of every row's key.
        bookingId: "booking-1",
        OR: [
          { idempotencyKey: "booking_cancel_refund_recovery_booking-1" },
          // The trailing underscore keeps booking-1's prefix from matching booking-10's rows.
          { idempotencyKey: { startsWith: "capacity\\_claim\\_failed\\_refund\\_recovery\\_booking-1\\_" } }, // #4146: escaped
        ],
      },
    }));
    expect(db.findClose).not.toHaveBeenCalled();
  });

  it.each([
    ["a row the runner will still send", row(), "on-its-way"],
    ["a FAILED row with a retry scheduled", row({ status: PaymentRecoveryOperationStatus.FAILED, attempts: 2 }), "on-its-way"],
    ["a row being worked", row({ status: PaymentRecoveryOperationStatus.PROCESSING, attempts: 1 }), "on-its-way"],
    ["a FAILED row with its retries spent", row({ status: PaymentRecoveryOperationStatus.FAILED, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null }), "stalled"],
    ["a FAILED row with no retry scheduled", row({ status: PaymentRecoveryOperationStatus.FAILED, attempts: 1, nextRetryAt: null }), "stalled"],
    ["a PENDING row raised dead at the ceiling", row({ attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS }), "stalled"],
    ["a closed row", row({ status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null }), "settled"],
  ] as const)("%s reads %s", async (_label, found, expected) => {
    db.findMany.mockResolvedValue([found]);

    expect(await readCancelledCardRefundState("booking-1")).toBe(expected);
  });

  it("a closed row with a 'Paid another way' record reads as paid another way, with what that record paid back and left unpaid, and what its slices took (#4145)", async () => {
    // #4516 round-4: a row read with its amount, as the read selects it - what the close's figures are capped at.
    db.findMany.mockResolvedValue([{ ...row({ status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null }), amountCents: 10_000 }]);
    // $100.00 due: $30.00 went back to the card; of the $70.00 still owed, $50.00 was paid back.
    db.findClose.mockResolvedValue({ amountCents: 5_000, raisedAmountCents: 7_000 });
    db.payments.mockResolvedValue([paymentWith([3_000], [{ id: "op-1", amountCents: 10_000, plan: [{ paymentTransactionId: "txn-1", amountCents: 3_000, madeRefundId: "re_0" }, { paymentTransactionId: "txn-1", amountCents: 7_000 }] }])]);

    expect(await readCancelledCardRefund("booking-1")).toEqual({
      cardRefundState: "paid-another-way",
      cardRefundPlanCents: 10_000,
      cardRefundClose: { paidBackCents: 5_000, unpaidCents: 2_000, madeCents: 3_000 },
    });
    expect(db.findClose).toHaveBeenCalledWith({
      where: { occurrenceKey: { in: expect.arrayContaining([expect.stringContaining("op-1")]) } },
      select: { amountCents: true, raisedAmountCents: true },
    });
    expect(db.payments).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["pay-1"] } } }));
  });

  it("MUTATION #4145: a capped close's made part is what its refunds took, never the due less what the row still owed", async () => {
    // $90.00 due, nothing reached the card, and the payment held only $60.00: closed in full for that.
    db.findMany.mockResolvedValue([{ ...row({ status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null }), amountCents: 9_000 }]);
    db.findClose.mockResolvedValue({ amountCents: 6_000, raisedAmountCents: 6_000 });
    db.payments.mockResolvedValue([paymentWith([], [{ id: "op-1", amountCents: 9_000, plan: [{ paymentTransactionId: "txn-1", amountCents: 9_000 }] }])]);

    expect((await readCancelledCardRefund("booking-1")).cardRefundClose).toEqual({ paidBackCents: 6_000, unpaidCents: 0, madeCents: 0 });
  });

  it("#4145: a capacity race's rows paid another way read as what they paid back, left unpaid and took together; a row not paid another way carries no figure", async () => {
    const closed = (id: string, amountCents: number) =>
      ({ ...row({ id, idempotencyKey: `capacity_claim_failed_refund_recovery_booking-1_pi_${id}`, status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null }), amountCents });
    db.findMany.mockResolvedValue([closed("a", 3_000), closed("b", 4_000)]);
    db.findClose.mockResolvedValueOnce({ amountCents: 2_000, raisedAmountCents: 2_000 }).mockResolvedValueOnce({ amountCents: 3_000, raisedAmountCents: 4_000 });
    db.payments.mockResolvedValue([
      paymentWith([1_000], [
        { id: "a", amountCents: 3_000, plan: [{ paymentTransactionId: "txn-1", amountCents: 1_000, madeRefundId: "re_0" }, { paymentTransactionId: "txn-1", amountCents: 2_000 }] },
        { id: "b", amountCents: 4_000, plan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }] },
      ]),
    ]);
    expect(await readCancelledCardRefund("booking-1")).toEqual({
      cardRefundState: "paid-another-way",
      cardRefundPlanCents: 7_000,
      cardRefundClose: { paidBackCents: 5_000, unpaidCents: 1_000, madeCents: 1_000 },
    });

    db.findMany.mockResolvedValue([closed("a", 3_000)]);
    db.findClose.mockResolvedValue(null);
    expect(await readCancelledCardRefund("booking-1")).toEqual({ cardRefundState: "settled", cardRefundPlanCents: 3_000 });
  });

  it("MUTATION #4145: a capacity race's rows read with their frozen plans together, in every state; a member's cancel carries none", async () => {
    const raced = (id: string, extra: Record<string, unknown>) => ({ ...row({ id, idempotencyKey: `capacity_claim_failed_refund_recovery_booking-1_pi_${id}` }), ...extra });
    db.findMany.mockResolvedValue([
      raced("a", { amountCents: 9_000, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 6_000 }, { paymentTransactionId: "txn-2", amountCents: 3_000 }] }),
      // A row with no plan reads at its amount.
      raced("b", { amountCents: 2_000, allocationPlan: null }),
    ]);
    expect(await readCancelledCardRefund("booking-1")).toEqual({ cardRefundState: "on-its-way", cardRefundPlanCents: 11_000 });

    db.findMany.mockResolvedValue([{ ...row({ idempotencyKey: "booking_cancel_refund_recovery_booking-1" }), amountCents: 9_000, allocationPlan: null }]);
    expect(await readCancelledCardRefund("booking-1")).toEqual({ cardRefundState: "on-its-way" });
  });

  // SQL LIKE reads `_` as any one character, so the database can hand back a
  // row of booking `booking-1x`'s for booking-1's prefix; it is not this booking's.
  it("ignores a row the LIKE wildcard matched that is not this booking's, and reads the member's cancel row", async () => {
    db.findMany.mockResolvedValue([
      row({ id: "op-other", idempotencyKey: "capacity_claim_failed_refund_recovery_booking-1x_pi_1", status: PaymentRecoveryOperationStatus.FAILED, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null }),
      row({ id: "op-own", idempotencyKey: "booking_cancel_refund_recovery_booking-1" }),
    ]);

    expect(await readCancelledCardRefundState("booking-1")).toBe("on-its-way");
  });

  it("several rows read as the one furthest from done", async () => {
    const closed = row({ id: "op-closed", status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null });
    const live = row({ id: "op-live" });
    const dead = row({ id: "op-dead", status: PaymentRecoveryOperationStatus.FAILED, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null });

    db.findMany.mockResolvedValue([closed, live]);
    expect(await readCancelledCardRefundState("booking-1")).toBe("on-its-way");

    db.findMany.mockResolvedValue([closed, live, dead]);
    expect(await readCancelledCardRefundState("booking-1")).toBe("stalled");
  });
});

// #4125: a card refund shortfall's card part reads its row the same way, so a
// dead one is stalled there too - never "on its way".
describe("readCardShortfallTaskStatuses reads a dead card part as stalled (#4125)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findClose.mockResolvedValue(null);
    db.tasks.mockResolvedValue([{ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1", status: "OPEN" }]);
  });

  it.each([
    ["dead", row({ idempotencyKey: "booking_cancel_refund_recovery_booking-1", status: PaymentRecoveryOperationStatus.FAILED, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null }), "stalled"],
    ["still being sent", row({ idempotencyKey: "booking_cancel_refund_recovery_booking-1" }), "on-its-way"],
  ] as const)("a %s card refund row", async (_label, found, card) => {
    db.findUnique.mockResolvedValue(found);

    expect(await readCardShortfallTaskStatuses("booking-1")).toEqual({ bank: "OPEN", card });
  });
});

// #4516 (round-2 review B, round-3 review 1): a part "Paid another way" close of the cancel's card refund whose rest
// stays owed on a row of its own (`card_refund_still_owed_<record>`). The cancel reads as closed "Paid another way",
// its rest said beside the close (`stillOwed`) - never "nothing left owed", and never the whole as still owed - and
// once a later close pays the rest, what that close paid back and left unpaid is the close's too.
describe("a cancel's card refund closed in part, its rest still owed (#4516 round-3 review 1)", () => {
  const CANCEL_KEY = "booking_cancel_refund_recovery_booking-1";
  const DEBT_KEY = buildOrganiserChildCancellationRefundKey("settlement-1", "booking-1");
  type Close = { id: string; closes: string; amountCents: number | null; raisedAmountCents: number | null };
  type Owed = Row & { amountCents: number };
  const closedRow = (id: string, idempotencyKey: string, amountCents: number): Owed =>
    ({ ...row({ id, idempotencyKey, status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null }), amountCents });
  /** A rest still owed: born dead, keyed by the close that left it. */
  const rest = (id: string, closeId: string, amountCents: number, overrides: Partial<Row> = {}): Owed =>
    ({ ...row({ id, idempotencyKey: `card_refund_still_owed_${closeId}`, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null, ...overrides }), amountCents });
  const restPaid = (id: string, closeId: string, amountCents: number) => rest(id, closeId, amountCents, { status: PaymentRecoveryOperationStatus.SUCCEEDED });

  /** The rows and the records closing them, as the store reads them. */
  function given(rows: Owed[], closes: Close[]) {
    db.findMany.mockImplementation(async ({ where }: { where: { OR?: unknown; idempotencyKey?: unknown } }) => {
      if (where.OR) return rows.filter((each) => each.idempotencyKey === CANCEL_KEY);
      return JSON.stringify(where.idempotencyKey ?? "").includes("still_owed") ? rows.filter((each) => each.idempotencyKey.startsWith("card_refund_still_owed_")) : [];
    });
    db.findUnique.mockImplementation(async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
      rows.find((each) => each.id === where.id || each.idempotencyKey === where.idempotencyKey) ?? null);
    db.findClose.mockImplementation(async ({ where }: { where: { occurrenceKey: { in: string[] } } }) => {
      const close = closes.find((each) => where.occurrenceKey.in.some((key) => key.split(":")[1] === each.closes));
      return close ? { amountCents: close.amountCents, raisedAmountCents: close.raisedAmountCents } : null;
    });
    db.findRecord.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const close = closes.find((each) => each.id === where.id);
      return close ? { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: `card-refund-paid-another-way:${close.closes}` } : null;
    });
  }
  // $300.00 died; the treasurer paid $100.00 by bank and left $200.00 still owed.
  const cancel = closedRow("op-cancel", CANCEL_KEY, 30_000);
  const firstClose: Close = { id: "close-1", closes: "op-cancel", amountCents: 10_000, raisedAmountCents: 10_000 };

  beforeEach(() => {
    vi.clearAllMocks();
    db.payments.mockResolvedValue([]);
    db.tasks.mockResolvedValue([{ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1", status: "OPEN" }]);
  });

  it("MUTATION: while the rest is owed, the cancel reads paid another way with the rest beside the close", async () => {
    given([cancel, rest("op-rest", "close-1", 20_000)], [firstClose]);
    expect(await readCancelledCardRefund("booking-1")).toEqual({
      cardRefundState: "paid-another-way",
      cardRefundClose: { paidBackCents: 10_000, unpaidCents: 0, madeCents: 0, stillOwed: { amountCents: 20_000, state: "stalled" } },
    });
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { bookingId: "booking-1", idempotencyKey: { startsWith: "card_refund_still_owed_" } },
    }));
  });

  it("MUTATION: once a later close pays the rest, what it paid back - and any it left unpaid - is the close's too", async () => {
    given([cancel, restPaid("op-rest", "close-1", 20_000)], [firstClose, { id: "close-2", closes: "op-rest", amountCents: 20_000, raisedAmountCents: 20_000 }]);
    expect(await readCancelledCardRefund("booking-1")).toEqual({
      cardRefundState: "paid-another-way",
      cardRefundClose: { paidBackCents: 30_000, unpaidCents: 0, madeCents: 0 },
    });
    // Paid back in part, the club keeping the rest of it.
    given([cancel, restPaid("op-rest", "close-1", 20_000)], [firstClose, { id: "close-2", closes: "op-rest", amountCents: 15_000, raisedAmountCents: 20_000 }]);
    expect((await readCancelledCardRefund("booking-1")).cardRefundClose).toEqual({ paidBackCents: 25_000, unpaidCents: 5_000, madeCents: 0 });
  });

  it("a rest closed in part again, its own rest still owed, is followed back to the cancel", async () => {
    given(
      [cancel, restPaid("op-rest", "close-1", 20_000), rest("op-rest-again", "close-2", 15_000)],
      [firstClose, { id: "close-2", closes: "op-rest", amountCents: 5_000, raisedAmountCents: 5_000 }],
    );
    expect((await readCancelledCardRefund("booking-1")).cardRefundClose).toEqual({
      paidBackCents: 15_000, unpaidCents: 0, madeCents: 0, stillOwed: { amountCents: 15_000, state: "stalled" },
    });
  });

  it("MUTATION: the shortfall's card part reads paid another way, so the narrative says both parts from the close", async () => {
    given([cancel, rest("op-rest", "close-1", 20_000)], [firstClose]);
    expect(await readCardShortfallTaskStatuses("booking-1")).toEqual({ bank: "OPEN", card: "paid-another-way" });
  });

  it("a rest whose origin is another door's row is not the cancel's", async () => {
    const appeal = closedRow("op-appeal", "refund_request_refund_req-1", 30_000);
    given([cancel, appeal, rest("op-rest", "close-appeal", 20_000)], [firstClose, { id: "close-appeal", closes: "op-appeal", amountCents: 10_000, raisedAmountCents: 10_000 }]);
    expect((await readCancelledCardRefund("booking-1")).cardRefundClose).toEqual({ paidBackCents: 10_000, unpaidCents: 0, madeCents: 0 });
  });

  // #4516 round-4 review 1: a rest is owed only while it is dead or still being sent. One closed with no close record
  // (`settled`) is never owed: it is told as made, by what its slices took from the refunds recorded on its payment.
  it("MUTATION: a rest still being sent is owed, on its way; one closed with no record is made, by what its slices took", async () => {
    const restOnItsWay = rest("op-rest", "close-1", 20_000, { attempts: 1, nextRetryAt: new Date("2026-07-01T00:05:00.000Z") });
    given([cancel, restOnItsWay], [firstClose]);
    expect((await readCancelledCardRefund("booking-1")).cardRefundClose).toEqual({
      paidBackCents: 10_000, unpaidCents: 0, madeCents: 0, stillOwed: { amountCents: 20_000, state: "on-its-way" },
    });

    const restSettled = rest("op-rest", "close-1", 20_000, { status: PaymentRecoveryOperationStatus.SUCCEEDED });
    given([cancel, restSettled], [firstClose]);
    // Nothing refunded on its slices: not owed, and nothing made either.
    expect((await readCancelledCardRefund("booking-1")).cardRefundClose).toEqual({ paidBackCents: 10_000, unpaidCents: 0, madeCents: 0 });
    // Its $200.00 slice filled by a refund recorded on the payment: made.
    db.payments.mockResolvedValue([paymentWith([20_000], [
      { id: "op-cancel", amountCents: 30_000, plan: [{ paymentTransactionId: "txn-1", amountCents: 30_000 }] },
      { id: "op-rest", amountCents: 20_000, plan: [{ paymentTransactionId: "txn-1", amountCents: 20_000, madeRefundId: "re_0" }] },
    ])]);
    expect((await readCancelledCardRefund("booking-1")).cardRefundClose).toEqual({ paidBackCents: 10_000, unpaidCents: 0, madeCents: 20_000 });
  });

  // #4516 round-4 review 2 (`INV-SSOT`): every close record is read by one rule (`paidAnotherWayCloseCents`): a
  // record with no figure paid back the whole of what its row owed, and nothing a record says is more than its row.
  it("MUTATION: a figureless record pays back its row's whole amount, and no record says more than its row owed", async () => {
    given([cancel, restPaid("op-rest", "close-1", 20_000)], [
      { ...firstClose, amountCents: null, raisedAmountCents: null },
      { id: "close-2", closes: "op-rest", amountCents: null, raisedAmountCents: null },
    ]);
    // The cancel's $300.00 row and its $200.00 rest, each paid back whole.
    expect((await readCancelledCardRefund("booking-1")).cardRefundClose).toEqual({ paidBackCents: 50_000, unpaidCents: 0, madeCents: 0 });

    given([cancel], [{ ...firstClose, amountCents: 40_000, raisedAmountCents: 45_000 }]);
    expect((await readCancelledCardRefund("booking-1")).cardRefundClose).toEqual({ paidBackCents: 30_000, unpaidCents: 0, madeCents: 0 });
  });

  it("MUTATION: an organiser-card child's debt closed in part says its rest still owed the same way", async () => {
    const debt = closedRow("op-debt", DEBT_KEY, 30_000);
    given([debt, rest("op-rest", "close-debt", 20_000)], [{ id: "close-debt", closes: "op-debt", amountCents: 10_000, raisedAmountCents: 10_000 }]);
    expect(await readOrganiserChildCancelledCardRefund("booking-1", "settlement-1")).toEqual({
      cardRefundState: "paid-another-way",
      cardRefundClose: { paidBackCents: 10_000, unpaidCents: 0, madeCents: 0, stillOwed: { amountCents: 20_000, state: "stalled" } },
      amountCents: 30_000,
    });
  });
});

// #4285 review 8: the kept-capture alert's drain reads the same rows inside its
// one snapshot - every read through the store it passes, none on the app's client.
describe("the cancel's card refund read through a caller's store (#4285 review 8)", () => {
  /** A store whose reads are separate fakes: the app's client (`db`) must never be asked. */
  function separateStore(rows: Row[], debt: Row | null = null) {
    return {
      paymentRecoveryOperation: { findMany: vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(debt) },
      manualRefundTask: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([{ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1", status: "COMPLETED" }]) },
      payment: { findMany: vi.fn().mockResolvedValue([]) },
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("readCancelledCardRefund and readCardShortfallTaskStatuses read only through the store", async () => {
    const closed = row({ idempotencyKey: "booking_cancel_refund_recovery_booking-1", status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null });
    const store = separateStore([closed], closed);

    expect(await readCancelledCardRefund("booking-1", store as never)).toEqual({ cardRefundState: "settled" });
    expect(await readCardShortfallTaskStatuses("booking-1", store as never)).toEqual({ bank: "COMPLETED", card: "settled" });

    // The member's cancel rows, then (a row closed) the rows owing a refund Stripe failed later; the close record on the store too.
    expect(store.paymentRecoveryOperation.findMany).toHaveBeenCalledTimes(2);
    expect(store.manualRefundTask.findFirst).toHaveBeenCalled();
    for (const fake of [db.findMany, db.findUnique, db.findClose, db.tasks, db.payments]) expect(fake).not.toHaveBeenCalled();
  });

  it("readOrganiserChildCancelledCardRefund reads the child's debt to the organiser's card by its key, as a member's row is read", async () => {
    const debt = row({ id: "op-debt", idempotencyKey: "organiser_child_refund_cancel_settlement-1_booking-1", status: PaymentRecoveryOperationStatus.FAILED, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null });
    const store = separateStore([], { ...debt, amountCents: 8_000 } as Row);

    expect(await readOrganiserChildCancelledCardRefund("booking-1", "settlement-1", store as never)).toEqual({ cardRefundState: "stalled", amountCents: 8_000 });
    expect(store.paymentRecoveryOperation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { idempotencyKey: "organiser_child_refund_cancel_settlement-1_booking-1" } }),
    );

    // No debt: nothing recorded.
    expect(await readOrganiserChildCancelledCardRefund("booking-1", "settlement-1", separateStore([]) as never)).toEqual({});
    expect(db.findUnique).not.toHaveBeenCalled();
  });
});

// #4516 round-4 review 2 (`INV-SSOT`): the one rule for what a "Paid another way" close record says of its row.
describe("paidAnotherWayCloseCents", () => {
  it.each([
    ["a full close", { amountCents: 6_000, raisedAmountCents: 6_000 }, 6_000, { paidBackCents: 6_000, unpaidCents: 0 }],
    ["a part close, the rest kept", { amountCents: 4_000, raisedAmountCents: 6_000 }, 6_000, { paidBackCents: 4_000, unpaidCents: 2_000 }],
    ["a figureless record: the whole paid back", { amountCents: null, raisedAmountCents: null }, 6_000, { paidBackCents: 6_000, unpaidCents: 0 }],
    ["MUTATION: a paid-back figure past the row, capped at it", { amountCents: 9_000, raisedAmountCents: 9_000 }, 6_000, { paidBackCents: 6_000, unpaidCents: 0 }],
    ["MUTATION: paid back and unpaid together never past the row", { amountCents: 4_000, raisedAmountCents: 9_000 }, 6_000, { paidBackCents: 4_000, unpaidCents: 2_000 }],
    ["a negative figure reads as nothing", { amountCents: -100, raisedAmountCents: null }, 6_000, { paidBackCents: 0, unpaidCents: 0 }],
  ] as const)("%s", (_label, close, owedCents, expected) => {
    expect(paidAnotherWayCloseCents(close, owedCents)).toEqual(expected);
  });
});
