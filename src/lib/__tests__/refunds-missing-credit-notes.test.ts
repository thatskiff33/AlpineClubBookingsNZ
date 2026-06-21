import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #818: surface refunds whose Xero credit-note follow-up never completed
// (money refunded via Stripe but xeroRefundCreditNoteId never set on an invoiced
// payment that has gone quiet past the grace window).

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findMany: mocks.findMany },
  },
}));

import {
  REFUND_CREDIT_NOTE_GRACE_HOURS,
  getRefundsMissingXeroCreditNotes,
} from "@/lib/xero-admin-health";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getRefundsMissingXeroCreditNotes (issue #818)", () => {
  it("queries refunded, invoiced Stripe payments with no credit note past the grace window", async () => {
    mocks.findMany.mockResolvedValue([]);
    const now = new Date("2026-06-21T12:00:00.000Z");

    const result = await getRefundsMissingXeroCreditNotes({ now });

    expect(result).toEqual({ count: 0, payments: [] });
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.source).toBe("STRIPE");
    expect(where.refundedAmountCents).toEqual({ gt: 0 });
    expect(where.xeroRefundCreditNoteId).toBeNull();
    expect(where.xeroInvoiceId).toEqual({ not: null });
    expect(where.updatedAt.lt).toEqual(
      new Date(now.getTime() - REFUND_CREDIT_NOTE_GRACE_HOURS * 60 * 60 * 1000),
    );
  });

  it("formats divergent payments with member context and honours the limit", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "pay_1",
        bookingId: "book_1",
        refundedAmountCents: 4200,
        updatedAt: new Date("2026-06-19T00:00:00.000Z"),
        booking: {
          member: {
            firstName: "Sam",
            lastName: "Lee",
            email: "sam@example.com",
          },
        },
      },
    ]);

    const result = await getRefundsMissingXeroCreditNotes({ limit: 1 });

    expect(result.count).toBe(1);
    expect(result.payments[0]).toEqual({
      paymentId: "pay_1",
      bookingId: "book_1",
      memberName: "Sam Lee",
      memberEmail: "sam@example.com",
      refundedAmountCents: 4200,
      refundedAt: "2026-06-19T00:00:00.000Z",
    });
  });
});
