// #4144 (`INV-PAY-130`, `INV-SSOT`): a pre-persisted refund door closes its
// recovery row only while the row is open and still on the plan the door sent
// (or, for the late-capture approval, still untouched - #4126). A close that
// matches nothing is read back: closed, gone, or held or re-planned by another
// writer is logged and left to the runner; a row still untouched is an anomaly,
// alerted once for the row. The fence itself is proved against PostgreSQL in
// `refused-card-refund-retry.realdb.test.ts`; this pins its shape and the
// reporter's branches.
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.hoisted(() => vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })));
const findUnique = vi.hoisted(() =>
  vi.fn<(args: unknown) => Promise<{ id: string; status: string; attempts: number } | null>>(async () => null),
);
const findBooking = vi.hoisted(() => vi.fn<(args: unknown) => Promise<{ id: string } | null>>(async () => ({ id: "b1" })));
// #5255: the owed row the lost-close alert is stored in for the sweep.
const storeOwed = vi.hoisted(() => vi.fn<(args: unknown) => Promise<unknown>>(async () => ({})));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: { updateMany, findUnique },
    booking: { findUnique: findBooking },
    alertCooldown: { create: storeOwed, deleteMany: vi.fn(async () => ({ count: 1 })) },
  },
}));

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: logger }));

const alertPaymentRecoveryOfficers = vi.hoisted(() => vi.fn<(args: unknown, format: unknown) => Promise<void>>(async () => undefined));
vi.mock("@/lib/payment-recovery-alert", () => ({
  alertPaymentRecoveryOfficers,
  NOBODY_ALERTED: { deliveryAllowed: true, recipients: 0, sent: 0, queuedForRetry: 0, notDelivered: 0 },
}));

const sendAdminAlertOnceEver = vi.hoisted(() => vi.fn<(args: { key: string; send: () => Promise<unknown> }) => Promise<boolean>>(async () => true));
vi.mock("@/lib/admin-alert-once", () => ({ sendAdminAlertOnceEver, readOnceEverClaimState: async () => "none" }));

import { closeDoorRow, closePrePersistedRefundRow, type LostCloseContext } from "@/lib/pre-persisted-refund-close";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const a: RefundAllocationSlice = { paymentTransactionId: "txn_a", amountCents: 3000 };
const b: RefundAllocationSlice = { paymentTransactionId: "txn_b", amountCents: 2000 };

const lost: LostCloseContext = {
  door: "capacity-race",
  idempotencyKey: "op_key",
  bookingId: "b1",
  paymentIntentId: "pi_1",
  amountCents: 5000,
  refundId: "re_1",
  format: CLUB_FORMAT_TEST,
};

beforeEach(() => {
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
  findUnique.mockResolvedValue(null);
  findBooking.mockResolvedValue({ id: "b1" });
});

describe("closePrePersistedRefundRow (#4144)", () => {
  const closeArgs = () => updateMany.mock.calls[0]?.[0] as { where: Record<string, unknown>; data: Record<string, unknown> };

  it("closes an open row only on the plan the door sent - any status but SUCCEEDED", async () => {
    await closePrePersistedRefundRow({ idempotencyKey: "op_key", sentPlan: [a, b] });
    expect(closeArgs().where).toEqual({ idempotencyKey: "op_key", status: { not: "SUCCEEDED" }, allocationPlan: { equals: [a, b] } });
    expect(closeArgs().data).toMatchObject({ status: "SUCCEEDED", nextRetryAt: null, lastError: null, processingStartedAt: null });
  });

  it("an empty plan is a row raised with none, as the enqueue stores it", async () => {
    await closePrePersistedRefundRow({ idempotencyKey: "op_key", sentPlan: [] });
    // `toBe`: DbNull has no fields of its own, so a structural match would accept any value.
    expect((closeArgs().where.allocationPlan as { equals: unknown }).equals).toBe(Prisma.DbNull);
  });

  it("#4126: the late-capture approval's close takes only an untouched row on the plan it sent", async () => {
    await closePrePersistedRefundRow({ idempotencyKey: "op_key", sentPlan: [a], untouchedOnly: true });
    expect(closeArgs().where).toEqual({ idempotencyKey: "op_key", status: "PENDING", attempts: 0, allocationPlan: { equals: [a] } });
  });

  it("closes in the caller's transaction when given one", async () => {
    const tx = { paymentRecoveryOperation: { updateMany: vi.fn(async () => ({ count: 1 })) } };
    await closePrePersistedRefundRow({ idempotencyKey: "op_key", sentPlan: [a], store: tx as never });
    expect(tx.paymentRecoveryOperation.updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("closeDoorRow (#4144)", () => {
  it("hands the close its row's key - built once, so the close and the read-back name one row", async () => {
    const close = vi.fn<(key: string) => Promise<boolean>>(async () => false);
    findUnique.mockResolvedValue({ id: "op_row", status: "FAILED", attempts: 1 });
    await closeDoorRow(lost, close);
    expect(close).toHaveBeenCalledWith("op_key");
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { idempotencyKey: "op_key" } }));
  });

  it("a close that moved the row reads nothing back and alerts nobody", async () => {
    expect(await closeDoorRow(lost, async () => true)).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
    expect(sendAdminAlertOnceEver).not.toHaveBeenCalled();
  });

  it("a close that threw is logged and left to the runner: no read-back, no alert", async () => {
    expect(await closeDoorRow(lost, async () => Promise.reject(new Error("pool timeout")))).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ door: "capacity-race", bookingId: "b1", paymentIntentId: "pi_1", idempotencyKey: "op_key" }),
      expect.stringContaining("Failed to close the capacity race's refund recovery operation"),
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(sendAdminAlertOnceEver).not.toHaveBeenCalled();
  });

  it.each([
    ["re-planned by another writer (FAILED, tried)", { id: "op_row", status: "FAILED", attempts: 1 }, "warn"],
    ["held by the runner (PROCESSING)", { id: "op_row", status: "PROCESSING", attempts: 1 }, "warn"],
    ["already closed by the runner", { id: "op_row", status: "SUCCEEDED", attempts: 1 }, "info"],
  ] as const)("a lost close on a row %s is logged and left to the runner, never alerted", async (_label, row, level) => {
    findUnique.mockResolvedValue(row);
    expect(await closeDoorRow(lost, async () => false)).toBe(false);
    expect(logger[level]).toHaveBeenCalledWith(
      expect.objectContaining({ door: "capacity-race", idempotencyKey: "op_key", status: row.status }),
      "The capacity race's refund was made, but the capacity race's close matched no open row it could close - already closed, held by the runner, or re-planned (#4144): left to the recovery runner",
    );
    expect(sendAdminAlertOnceEver).not.toHaveBeenCalled();
  });

  it("a row that is gone - nothing deletes a door's refund row - is logged as an error, not alerted", async () => {
    findUnique.mockResolvedValue(null);
    expect(await closeDoorRow(lost, async () => false)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "op_key" }), expect.stringContaining("no longer exists"));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(sendAdminAlertOnceEver).not.toHaveBeenCalled();
  });

  it("a lost close on a row still untouched is an anomaly: logged and alerted once for the row, naming the refund", async () => {
    findUnique.mockResolvedValue({ id: "op_row", status: "PENDING", attempts: 0 });
    expect(await closeDoorRow(lost, async () => false)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op_row" }), expect.stringContaining("still untouched"));
    expect(sendAdminAlertOnceEver).toHaveBeenCalledTimes(1);
    const [{ key, send }] = sendAdminAlertOnceEver.mock.calls[0]!;
    expect(key).toBe("capacity-race-close-lost:op_row");
    // #5255: nothing raises it again, so it is stored for the sweep first.
    expect(storeOwed).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "once-ever-owed:capacity-race-close-lost:op_row",
        replayAlert: expect.objectContaining({ alert: expect.objectContaining({ kind: "payment-recovery", operationId: "op_row", amountCents: 5000 }) }),
      }),
    });
    await send();
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "b1",
        operationId: "op_row",
        amountCents: 5000,
        paymentIntentId: "pi_1",
        errorMessage: expect.stringMatching(/^The capacity race's refund was made at Stripe \(re_1\)/),
      }),
      CLUB_FORMAT_TEST,
    );
  });

  it("an untouched row whose booking is gone is logged, not alerted", async () => {
    findUnique.mockResolvedValue({ id: "op_row", status: "PENDING", attempts: 0 });
    findBooking.mockResolvedValue(null);
    await closeDoorRow(lost, async () => false);
    expect(sendAdminAlertOnceEver).not.toHaveBeenCalled();
  });

  it("a read-back that throws is logged and never escapes", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    await expect(closeDoorRow(lost, async () => false)).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Failed to check a lost close for the capacity race"));
  });
});
