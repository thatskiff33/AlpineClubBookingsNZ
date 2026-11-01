import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  auditRefundedTotalShortfalls,
  deriveRefundedTotalShortfall,
  formatRefundedTotalShortfallReport,
  type RefundedTotalShortfallRow,
} from "@/lib/refunded-total-shortfall-audit";
import { ACCOUNT_CREDIT_DISPOSITION_WHERE } from "@/lib/stripe-cash-refund-evidence";
import { CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE } from "@/lib/manual-refund-task-settlement-rules";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

function row(overrides: Partial<RefundedTotalShortfallRow> = {}): RefundedTotalShortfallRow {
  return {
    paymentId: "pay_1",
    bookingId: "booking_1",
    amountCents: 40000,
    refundedAmountCents: 10000,
    cardRefundCents: 5000,
    accountCreditCents: 10000,
    paidAnotherWayCents: 0,
    ...overrides,
  };
}

describe("deriveRefundedTotalShortfall (#3640)", () => {
  it("reports the payment the old max left behind: $100 credit + $50 card stored as $100", () => {
    expect(deriveRefundedTotalShortfall(row())).toMatchObject({
      expectedFloorCents: 15000,
      shortfallCents: 5000,
      attributableCents: 5000,
      unattributedCents: 0,
    });
  });

  it("does NOT attribute a credit with no card refund to the old arithmetic (e.g. IB cash that became credit on a cancelled booking)", () => {
    expect(
      deriveRefundedTotalShortfall(
        row({ amountCents: 30000, refundedAmountCents: 0, cardRefundCents: 0, accountCreditCents: 30000 }),
      ),
    ).toMatchObject({ shortfallCents: 30000, attributableCents: 0, unattributedCents: 30000 });
  });

  it("attributes at most the smaller of card refund and credit; the rest is another reason", () => {
    expect(
      deriveRefundedTotalShortfall(
        row({ refundedAmountCents: 0, cardRefundCents: 5000, accountCreditCents: 10000 }),
      ),
    ).toMatchObject({ shortfallCents: 15000, attributableCents: 5000, unattributedCents: 10000 });
  });

  it("reports nothing when the stored total already covers both", () => {
    expect(deriveRefundedTotalShortfall(row({ refundedAmountCents: 15000 }))).toBeNull();
  });

  it("reports nothing when the stored total is ABOVE the floor (pre-ledger refunds, folded notes)", () => {
    expect(deriveRefundedTotalShortfall(row({ refundedAmountCents: 18000 }))).toBeNull();
  });

  it("#4280: counts a Paid another way close's bank cash, and lists the total a failed late card refund left below it as another reason", () => {
    // $200 captured, closed as paid another way for $200; the late card refund
    // failed and took the total to $0 before #4280.
    expect(
      deriveRefundedTotalShortfall(
        row({ amountCents: 20000, refundedAmountCents: 0, cardRefundCents: 0, accountCreditCents: 0, paidAnotherWayCents: 20000 }),
      ),
    ).toMatchObject({ expectedFloorCents: 20000, shortfallCents: 20000, attributableCents: 0, unattributedCents: 20000 });
    // A part close: only what was paid back.
    expect(
      deriveRefundedTotalShortfall(
        row({ amountCents: 20000, refundedAmountCents: 12000, cardRefundCents: 0, accountCreditCents: 0, paidAnotherWayCents: 12000 }),
      ),
    ).toBeNull();
    // With credit beside it, capped at what was captured.
    expect(
      deriveRefundedTotalShortfall(
        row({ amountCents: 20000, refundedAmountCents: 5000, cardRefundCents: 0, accountCreditCents: 5000, paidAnotherWayCents: 20000 }),
      ),
    ).toMatchObject({ expectedFloorCents: 20000, shortfallCents: 15000 });
  });

  it("#4280: what only a close's bank cash explains is never attributed to the old arithmetic", () => {
    // $50 card + $100 credit stored as $300 with a $200 close: the floor
    // without the close ($150) is met, so none of the $50 short is attributed to
    // #3640. The figures cannot say which cause it is (a failure that took the
    // close's cash, or a #3640 loss the close's cash masks), so it is listed for
    // a person, never counted as #3640's.
    expect(
      deriveRefundedTotalShortfall(row({ refundedAmountCents: 30000, cardRefundCents: 5000, accountCreditCents: 10000, paidAnotherWayCents: 20000 })),
    ).toMatchObject({ expectedFloorCents: 35000, shortfallCents: 5000, attributableCents: 0, unattributedCents: 5000 });
    // Short below the floor without it too: #3640's part is what it was before the close counted.
    expect(
      deriveRefundedTotalShortfall(row({ refundedAmountCents: 10000, cardRefundCents: 5000, accountCreditCents: 10000, paidAnotherWayCents: 20000 })),
    ).toMatchObject({ expectedFloorCents: 35000, shortfallCents: 25000, attributableCents: 5000, unattributedCents: 20000 });
  });

  it("#4280: caps the floor at what was captured when a counted card refund and a close's cash exceed it", () => {
    // $200 captured, closed for $200, and a $50 card refund that succeeded too (paid twice): $250 > $200.
    expect(
      deriveRefundedTotalShortfall(
        row({ amountCents: 20000, refundedAmountCents: 20000, cardRefundCents: 5000, accountCreditCents: 0, paidAnotherWayCents: 20000 }),
      ),
    ).toBeNull();
  });

  it("caps the floor at what was captured", () => {
    expect(
      deriveRefundedTotalShortfall(
        row({ refundedAmountCents: 35000, cardRefundCents: 35000, accountCreditCents: 10000 }),
      ),
    ).toMatchObject({ expectedFloorCents: 40000, shortfallCents: 5000, attributableCents: 5000 });
  });
});

describe("auditRefundedTotalShortfalls (#3640) - read only", () => {
  // Only the read methods exist: a write would throw, so the audit cannot
  // write by accident. #4280: it reads inside ONE read-only snapshot, so the
  // client's `$transaction` hands the same reads to it as its transaction.
  function fakeDb() {
    const reads = {
      // `withReadOnlySnapshot`'s `SET TRANSACTION READ ONLY`, the only statement it runs.
      $executeRaw: vi.fn(async () => 0),
      payment: {
        findMany: vi.fn(async () => [
          { id: "pay_short", bookingId: "booking_short", amountCents: 40000, refundedAmountCents: 10000 },
          { id: "pay_ok", bookingId: "booking_ok", amountCents: 40000, refundedAmountCents: 15000 },
          { id: "pay_card_only", bookingId: "booking_card_only", amountCents: 20000, refundedAmountCents: 5000 },
          // IB cash paid after the booking was cancelled, held as credit: the
          // mirror was never touched, and the old arithmetic had no part in it.
          { id: "pay_ib_after_cancel", bookingId: "booking_ib", amountCents: 30000, refundedAmountCents: 0 },
          // #4280: a close's $200 taken out by a late card refund's failure, and one whose total still holds it.
          { id: "pay_paw_short", bookingId: "booking_paw_short", amountCents: 20000, refundedAmountCents: 0 },
          { id: "pay_paw_ok", bookingId: "booking_paw_ok", amountCents: 20000, refundedAmountCents: 20000 },
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
          { sourceBookingId: "booking_ib", _sum: { amountCents: 30000 } },
        ]),
      },
      // #4280: the closes' bank cash, through the one reader.
      manualRefundTask: {
        groupBy: vi.fn(async () => [
          { paymentId: "pay_paw_short", _sum: { amountCents: 20000 } },
          { paymentId: "pay_paw_ok", _sum: { amountCents: 20000 } },
        ]),
      },
    };
    const $transaction = vi.fn(async (run: (tx: typeof reads) => Promise<unknown>, options: unknown) => {
      void options;
      return run(reads);
    });
    return { ...reads, $transaction };
  }

  it("lists each payment short of card refunds + account credit, with the shortfall", async () => {
    const db = fakeDb();

    const result = await auditRefundedTotalShortfalls({ db: db as never });

    expect(result.scannedPayments).toBe(6);
    expect(result.findings).toEqual([
      expect.objectContaining({
        paymentId: "pay_short",
        cardRefundCents: 5000,
        accountCreditCents: 10000,
        expectedFloorCents: 15000,
        attributableCents: 5000,
        unattributedCents: 0,
      }),
      expect.objectContaining({
        paymentId: "pay_ib_after_cancel",
        attributableCents: 0,
        unattributedCents: 30000,
      }),
      expect.objectContaining({
        paymentId: "pay_paw_short",
        paidAnotherWayCents: 20000,
        expectedFloorCents: 20000,
        attributableCents: 0,
        unattributedCents: 20000,
      }),
    ]);
    expect(result.totalAttributableCents).toBe(5000);
    expect(result.totalUnattributedCents).toBe(50000);
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

  it("#4280: reads every source in ONE read-only snapshot, and the closes' cash through the one reader", async () => {
    const db = fakeDb();

    await auditRefundedTotalShortfalls({ db: db as never });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "RepeatableRead" }));
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(String((db.$executeRaw.mock.calls[0] as unknown[] | undefined)?.[0])).toContain("SET TRANSACTION READ ONLY");
    expect(db.manualRefundTask.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE) }),
    );
  });

  it("formats a report that names the payment and says nothing is repaired", async () => {
    const result = await auditRefundedTotalShortfalls({ db: fakeDb() as never });

    const report = formatRefundedTotalShortfallReport(result, CLUB_FORMAT_TEST);

    expect(report).toContain("read only");
    expect(report).toContain("Nothing here is repaired");
    expect(report).not.toContain("pay_ok");
    // The two causes are reported apart, so the #3640 repair question is asked
    // only about the payments it can explain.
    const [attributed, other] = report.split("## Short for another reason");
    expect(attributed).toContain("pay_short");
    expect(attributed).not.toContain("pay_ib_after_cancel");
    expect(other).toContain("pay_ib_after_cancel");
    // #4280 review (money F2, F3): the causes the figures cannot tell apart, said as such.
    expect(other).toContain("a #3640 loss that a later close's cash masked");
    expect(other).toContain("Stuck States' \"paid twice\" list");
    expect(other).toContain("still pending is transient");
    expect(other).toContain("paid another way $200.00");
  });
});
