import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  enqueue: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: { bookingModification: { findFirst: mocks.findFirst } } }));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroSupplementaryInvoiceOperation: mocks.enqueue }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { CHANGE_FEE_LINE_DESCRIPTION } from "@/lib/xero-modification-line-items";
import { billedChangeFeeCents, queuePrimaryInvoiceChangeFeeGap } from "@/lib/xero-primary-invoice-fee-gap";

const guestLine = { description: "Jordan - (ADULT, Member) - 2 nights", quantity: 1, unitAmount: 200 };
const feeLine = (dollars: number) => ({ description: CHANGE_FEE_LINE_DESCRIPTION, quantity: 1, unitAmount: dollars });

/**
 * #3955 review X4: a primary invoice built before a fee was recorded (an edit
 * committed mid-create, or a lost response replayed under the same key) bills
 * less fee than the payment records; the remainder goes on a supplementary
 * invoice anchored on the latest fee-bearing edit, never dropped.
 */
describe("queuePrimaryInvoiceChangeFeeGap (#3955 X4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue({ id: "mod_fee" });
    mocks.enqueue.mockResolvedValue({ queueOperationId: "op_gap" });
  });

  it("reads only the change-fee lines, as Xero adds them", () => {
    expect(billedChangeFeeCents([guestLine, feeLine(12.5), feeLine(7.5)])).toBe(2_000);
    expect(billedChangeFeeCents([guestLine])).toBe(0);
  });

  it("does nothing when the invoice bills the recorded fee", async () => {
    await expect(
      queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        billedLineItems: [guestLine, feeLine(25)],
        recordedChangeFeeCents: 2_500,
      }),
    ).resolves.toEqual({ gapCents: 0, queueOperationId: null });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("bills the gap on a supplementary invoice anchored on the latest fee-bearing edit", async () => {
    await expect(
      queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        // The invoice Xero returned was built before the 40.00 fee was recorded.
        billedLineItems: [guestLine, feeLine(25)],
        recordedChangeFeeCents: 6_500,
        createdByMemberId: "officer_1",
      }),
    ).resolves.toEqual({ gapCents: 4_000, queueOperationId: "op_gap" });
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: "booking_1", changeFeeCents: { gt: 0 } },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { bookingId: "booking_1", priceDiffCents: 0, changeFeeCents: 4_000, bookingModificationId: "mod_fee" },
      { createdByMemberId: "officer_1" },
    );
  });

  it("is loud, and raises nothing, when the invoice bills more fee than is recorded", async () => {
    await queuePrimaryInvoiceChangeFeeGap({
      bookingId: "booking_1",
      billedLineItems: [feeLine(30)],
      recordedChangeFeeCents: 2_500,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalled();
  });
});
