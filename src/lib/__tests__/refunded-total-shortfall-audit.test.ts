import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  auditRefundedTotalShortfalls,
  deriveRefundedTotalShortfall,
  formatRefundedTotalShortfallReport,
  type RefundedTotalShortfallRow,
} from "@/lib/refunded-total-shortfall-audit";
import { ACCOUNT_CREDIT_DISPOSITION_WHERE } from "@/lib/stripe-cash-refund-evidence";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

function row(overrides: Partial<RefundedTotalShortfallRow> = {}): RefundedTotalShortfallRow {
  return {
    paymentId: "pay_1",
    bookingId: "booking_1",
    amountCents: 40000,
    refundedAmountCents: 10000,
    cardRefundCents: 5000,
    accountCreditCents: 10000,
    ...overrides,
  };
}

describe("deriveRefundedTotalShortfall (#3640)", () => {
  it("reports the payment the old max left behind: $100 credit + $50 card stored as $100", () => {
    expect(deriveRefundedTotalShortfall(row())).toMatchObject({
      expectedFloorCents: 15000,
      shortfallCents: 5000,
    });
  });

  it("reports nothing when the stored total already covers both", () => {
    expect(deriveRefundedTotalShortfall(row({ refundedAmountCents: 15000 }))).toBeNull();
  });

  it("reports nothing when the stored total is ABOVE the floor (pre-ledger refunds, folded notes)", () => {
    expect(deriveRefundedTotalShortfall(row({ refundedAmountCents: 18000 }))).toBeNull();
  });

  it("caps the floor at what was captured", () => {
    expect(
      deriveRefundedTotalShortfall(
        row({ refundedAmountCents: 35000, cardRefundCents: 35000, accountCreditCents: 10000 }),
      ),
    ).toMatchObject({ expectedFloorCents: 40000, shortfallCents: 5000 });
  });
});

describe("auditRefundedTotalShortfalls (#3640) - read only", () => {
  // Only the three read methods exist: a write would throw, so the audit
  // cannot write by accident.
  function fakeDb() {
    return {
      payment: {
        findMany: vi.fn(async () => [
          { id: "pay_short", bookingId: "booking_short", amountCents: 40000, refundedAmountCents: 10000 },
          { id: "pay_ok", bookingId: "booking_ok", amountCents: 40000, refundedAmountCents: 15000 },
          { id: "pay_card_only", bookingId: "booking_card_only", amountCents: 20000, refundedAmountCents: 5000 },
        ]),
      },
      paymentRefund: {
        groupBy: vi.fn(async () => [
          { paymentId: "pay_short", status: "succeeded", _sum: { amountCents: 5000 } },
          // A refund that returned no money is not counted.
          { paymentId: "pay_short", status: "failed", _sum: { amountCents: 2000 } },
          { paymentId: "pay_ok", status: "succeeded", _sum: { amountCents: 5000 } },
          { paymentId: "pay_card_only", status: "pending", _sum: { amountCents: 5000 } },
        ]),
      },
      memberCredit: {
        groupBy: vi.fn(async () => [
          { sourceBookingId: "booking_short", _sum: { amountCents: 10000 } },
          { sourceBookingId: "booking_ok", _sum: { amountCents: 10000 } },
        ]),
      },
    };
  }

  it("lists each payment short of card refunds + account credit, with the shortfall", async () => {
    const db = fakeDb();

    const result = await auditRefundedTotalShortfalls({ db: db as never });

    expect(result.scannedPayments).toBe(3);
    expect(result.findings).toEqual([
      expect.objectContaining({
        paymentId: "pay_short",
        cardRefundCents: 5000,
        accountCreditCents: 10000,
        expectedFloorCents: 15000,
        shortfallCents: 5000,
      }),
    ]);
    expect(result.totalShortfallCents).toBe(5000);
  });

  it("counts account credit with the one definition the cash-evidence module reads", async () => {
    const db = fakeDb();

    await auditRefundedTotalShortfalls({ db: db as never });

    expect(db.memberCredit.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining(ACCOUNT_CREDIT_DISPOSITION_WHERE),
      }),
    );
  });

  it("formats a report that names the payment and says nothing is repaired", async () => {
    const result = await auditRefundedTotalShortfalls({ db: fakeDb() as never });

    const report = formatRefundedTotalShortfallReport(result, CLUB_FORMAT_TEST);

    expect(report).toContain("pay_short");
    expect(report).toContain("read only");
    expect(report).toContain("Nothing here is repaired");
    expect(report).not.toContain("pay_ok");
  });
});
