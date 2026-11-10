/**
 * The owner's OPERATOR release of a card refund reservation (#4516, Ledger M4c; plan section 8). The release and its
 * audit row are one transaction: the audit is written on the release's own transaction client, after the release,
 * and a refused release writes no audit row. The journal side is exercised against PostgreSQL in
 * `member-money-refunds.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: { marker: "tx" },
  prisma: { $transaction: vi.fn() },
  releaseReservationByOperator: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/member-money", () => ({ releaseReservationByOperator: mocks.releaseReservationByOperator }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));

import { releaseCardRefundReservationByOperator } from "@/lib/card-refund-reservation-operator";

const context = { kind: "active" } as never;

describe("the owner's OPERATOR release of a card refund reservation (#4516)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation((run: (tx: unknown) => unknown) => run(mocks.tx));
  });

  it("releases, then audits on the same transaction client, with the owner's note", async () => {
    const order: string[] = [];
    mocks.releaseReservationByOperator.mockImplementation(async () => {
      order.push("release");
      return { bookingId: "b-1", attemptKey: "refund_slice_key", amountCents: 4_000 };
    });
    mocks.createAuditLog.mockImplementation(async () => { order.push("audit"); });

    const result = await releaseCardRefundReservationByOperator(context, { reservationId: "res-1", note: "rolled back across M4c" });

    expect(result).toEqual({ bookingId: "b-1", attemptKey: "refund_slice_key", amountCents: 4_000 });
    expect(order).toEqual(["release", "audit"]);
    expect(mocks.releaseReservationByOperator).toHaveBeenCalledWith(mocks.tx, context, { reservationId: "res-1" });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      category: "payment", action: "booking-payment.card-refund.reservation-released-by-operator", targetId: "b-1",
      entityType: "MemberMoneyRefundReservation", entityId: "res-1", severity: "critical", outcome: "success",
      details: "rolled back across M4c", metadata: { attemptKey: "refund_slice_key", amountCents: 4_000 },
    }), mocks.tx);
  });

  it("writes no audit row when the journal refuses the release", async () => {
    mocks.releaseReservationByOperator.mockRejectedValue(new Error("reservation res-9 does not exist"));

    await expect(releaseCardRefundReservationByOperator(context, { reservationId: "res-9", note: "why" }))
      .rejects.toThrow("reservation res-9 does not exist");
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });
});
