import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { xeroSyncOperation: { findFirst: (...a: unknown[]) => mocks.findFirst(...a) } },
}));

import { XeroRefundCreditNoteInFlightError, isXeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { assertNoRefundCreditNoteInFlight } from "@/lib/xero-refund-note-in-flight";
import { STALE_RUNNING_XERO_OPERATION_MINUTES } from "@/lib/xero-stale-operations";

describe("#3880 assertNoRefundCreditNoteInFlight", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
  });

  it("asks for a LIVE running refund-note create or credit-note requeue on this payment, other than the caller's own claims", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const before = Date.now();

    await assertNoRefundCreditNoteInFlight("payment_1", ["op_own", undefined, "requeue_own", null]);

    const { where } = mocks.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(where).toMatchObject({
      id: { notIn: ["op_own", "requeue_own"] },
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      localModel: "Payment",
      localId: "payment_1",
      status: "RUNNING",
      OR: [
        { operationType: "CREATE", queueType: "REFUND_CREDIT_NOTE" },
        { operationType: "CREATE", queueType: null },
        { operationType: "REQUEUE" },
      ],
    });
    const floor = (where.startedAt as { gte: Date }).gte.getTime();
    expect(before - floor).toBeGreaterThanOrEqual(STALE_RUNNING_XERO_OPERATION_MINUTES * 60_000 - 5);
    expect(Date.now() - floor).toBeLessThanOrEqual(STALE_RUNNING_XERO_OPERATION_MINUTES * 60_000 + 1_000);
  });

  it("MUTATION: throws the outbox's busy error, naming the row it waits for", async () => {
    mocks.findFirst.mockResolvedValue({ id: "op_other" });

    const error = await assertNoRefundCreditNoteInFlight("payment_1", ["op_own"]).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(XeroRefundCreditNoteInFlightError);
    expect(isXeroAppliedCreditOperationBusyError(error)).toBe(true);
    expect((error as Error).message).toContain("op_other");
  });

  it("with no claim of its own, excludes nothing", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await assertNoRefundCreditNoteInFlight("payment_1", [null, undefined]);
    const { where } = mocks.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(where).not.toHaveProperty("id");
  });
});
