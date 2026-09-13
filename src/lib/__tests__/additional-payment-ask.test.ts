import { PaymentSource, PaymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  bookingLedgerCensusSql,
  bookingLedgerResidualCents,
  bookingLedgerResidualSql,
  bookingLedgerVerdict,
  NO_ADDITIONAL_ASK,
  outstandingAdditionalAskCents,
  raiseReviewChargeAsk,
  sizeAdditionalAsk,
  sizeReviewChargeAsk,
  type BookingLedgerIdentityRow,
} from "@/lib/additional-payment-ask";
import { applyPaymentAdjustments } from "@/lib/booking-modify-settlement";
import type { LoadedBookingForModify } from "@/lib/booking-modify-validation";

// `booking-modify-settlement` reaches `@/lib/cancellation`, which constructs the
// Prisma adapter at import time and therefore needs a `DATABASE_URL`. Nothing
// under test here touches a client — `applyPaymentAdjustments` is handed a stub
// transaction — so the module is stubbed rather than the environment faked.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/*
  #3340 — the arithmetic behind an additional-payment ask.

  The defect: minting a replacement ADDITIONAL PaymentIntent retires every other
  outstanding ask on the payment, so an ask sized on its own delta DELETED the
  unpaid balance of the ask it replaced. Two consecutive +$70 edits on a $130
  paid booking asked $70 and lost $70, for ever and silently.

  Clock: every assertion here is over integer cents and carries no date, so the
  frozen clock (`vitest.clock-setup.ts`) is inherited and never consulted.
*/

/**
 * The issue's headline rule, written out here exactly as the issue states it so
 * the agreement below is a MEASUREMENT and not a claim in a comment:
 * `finalPriceCents - (amountCents - refundedAmountCents) - creditAppliedCents`.
 */
function priceDerivedOutstandingCents(row: {
  finalPriceCents: number;
  amountCents: number;
  refundedAmountCents: number;
  creditAppliedCents: number;
}): number {
  return (
    row.finalPriceCents -
    (row.amountCents - row.refundedAmountCents) -
    row.creditAppliedCents
  );
}

function askPayment(
  additionalAmountCents: number,
  additionalPaymentStatus: string | null,
) {
  return { additionalAmountCents, additionalPaymentStatus };
}

describe("outstandingAdditionalAskCents", () => {
  it("is the ask when it is uncollected, and zero once it is paid", () => {
    expect(outstandingAdditionalAskCents(askPayment(7000, "PENDING"))).toBe(7000);
    expect(outstandingAdditionalAskCents(askPayment(7000, "FAILED"))).toBe(7000);
    // A legacy row with no status is uncollected, not collected.
    expect(outstandingAdditionalAskCents(askPayment(7000, null))).toBe(7000);
    expect(outstandingAdditionalAskCents(askPayment(7000, "SUCCEEDED"))).toBe(0);
    expect(outstandingAdditionalAskCents(askPayment(0, "PENDING"))).toBe(0);
  });

  it("carries nothing for a booking that has never minted a Payment row", () => {
    expect(outstandingAdditionalAskCents(null)).toBe(0);
    expect(outstandingAdditionalAskCents(undefined)).toBe(0);
  });
});

describe("sizeAdditionalAsk", () => {
  it("is the bare net when no ask is being superseded (pre-#3340 behaviour)", () => {
    expect(
      sizeAdditionalAsk({
        priceDiffCents: 7000,
        changeFeeCents: 0,
        payment: askPayment(0, null),
      }).amountCents,
    ).toBe(7000);
  });

  it("folds in the unpaid balance of the ask the mint is about to retire", () => {
    // The completed-booking shape from acceptance criterion 1.
    expect(
      sizeAdditionalAsk({
        priceDiffCents: 7000,
        changeFeeCents: 0,
        payment: askPayment(7000, "PENDING"),
      }).amountCents,
    ).toBe(14000);
  });

  it("does not double-ask when the first extra was already paid (AC 1a)", () => {
    expect(
      sizeAdditionalAsk({
        priceDiffCents: 7000,
        changeFeeCents: 0,
        payment: askPayment(7000, "SUCCEEDED"),
      }).amountCents,
    ).toBe(7000);
  });

  it("folds in an ask the member's card DECLINED, which is still owed", () => {
    expect(
      sizeAdditionalAsk({
        priceDiffCents: 7000,
        changeFeeCents: 0,
        payment: askPayment(6500, "FAILED"),
      }).amountCents,
    ).toBe(13500);
  });

  it("adds the change fee, which joins an ask but never the price", () => {
    expect(
      sizeAdditionalAsk({
        priceDiffCents: 7000,
        changeFeeCents: 1500,
        payment: askPayment(7000, "PENDING"),
      }).amountCents,
    ).toBe(15500);
  });
});

describe("#3371 - a review charge is the SAME rule with a different own figure", () => {
  it("carries the unpaid extra an ordinary edit left behind (ordering 1)", () => {
    const ask = sizeReviewChargeAsk({
      shareTotalCents: 6000,
      payment: askPayment(7000, "PENDING"),
    });
    expect(ask.amountCents).toBe(13000);
    expect(ask.carriedCents).toBe(7000);
  });

  it("carries an EARLIER REVIEW's unpaid charge - the proved sequence", () => {
    // The #3371 proof: $200 priced and unpaid, then $60 priced. Before the fix
    // the mint asked $60 and the $200 simply ceased to be owed.
    const ask = sizeReviewChargeAsk({
      shareTotalCents: 6000,
      payment: askPayment(20000, "PENDING"),
    });
    expect(ask.amountCents).toBe(26000);
    expect(ask.carriedCents).toBe(20000);
  });

  it("carries nothing once the earlier charge has been paid", () => {
    const ask = sizeReviewChargeAsk({
      shareTotalCents: 6000,
      payment: askPayment(20000, "SUCCEEDED"),
    });
    expect(ask.amountCents).toBe(6000);
    expect(ask.carriedCents).toBe(0);
  });

  it("carries nothing when there was no ask to retire", () => {
    const ask = sizeReviewChargeAsk({
      shareTotalCents: 20000,
      payment: askPayment(0, null),
    });
    expect(ask.amountCents).toBe(20000);
    expect(ask.carriedCents).toBe(20000 - 20000);
    expect(ask.carriedCents).toBe(0);
  });

  it("carries a DECLINED earlier charge, which is still owed", () => {
    const ask = sizeReviewChargeAsk({
      shareTotalCents: 6000,
      payment: askPayment(20000, "FAILED"),
    });
    expect(ask.amountCents).toBe(26000);
    expect(ask.carriedCents).toBe(20000);
  });
});

describe("#3371 - a later share reads the carried figure back off the row", () => {
  /*
    THE TRAP THIS EXISTS TO AVOID, and the reason the raise takes the ROW rather
    than the payment. By the time a second share settles, the payment's ask
    column mirrors THIS request - so re-deriving the carried part from the
    payment would fold the request into itself and bill the carried money twice.
  */
  it("re-derives the total from the shares and keeps the carried part fixed", () => {
    const minted = sizeReviewChargeAsk({
      shareTotalCents: 6000,
      payment: askPayment(20000, "PENDING"),
    });
    expect(minted.amountCents).toBe(26000);

    // A second task of the SAME edit settles for another $40.
    const raised = raiseReviewChargeAsk({
      shareTotalCents: 10000,
      request: { carriedAskCents: minted.carriedCents },
    });
    expect(raised.amountCents).toBe(30000);
    expect(raised.carriedCents).toBe(20000);
  });

  it("is MONOTONE, which is what makes the lock-free compare-and-set safe", () => {
    // The share sum only grows (a settled share is terminal) and the carried
    // part is fixed at the mint, so a stale run can only ever compute a SMALLER
    // figure - never a larger one that would raise a live intent wrongly.
    const request = { carriedAskCents: 20000 };
    const stale = raiseReviewChargeAsk({ shareTotalCents: 6000, request });
    const fresh = raiseReviewChargeAsk({ shareTotalCents: 10000, request });
    expect(stale.amountCents).toBeLessThan(fresh.amountCents);
  });

  it("re-reading the PAYMENT instead would double-count - measured, not asserted", () => {
    // What the ledger looks like a moment after the mint above: the payment's
    // ask column now mirrors the request's own $260.
    const afterMint = askPayment(26000, "PENDING");
    const wrong = sizeReviewChargeAsk({
      shareTotalCents: 10000,
      payment: afterMint,
    });
    // $100 of shares plus the $260 that already contains them: the request would
    // be raised to $360 for $300 of real debt.
    expect(wrong.amountCents).toBe(36000);
    const right = raiseReviewChargeAsk({
      shareTotalCents: 10000,
      request: { carriedAskCents: 20000 },
    });
    expect(right.amountCents).toBe(30000);
  });
});

describe("#3371 - the zero ask", () => {
  it("asks for nothing and carries nothing, so it can never mint", () => {
    expect(NO_ADDITIONAL_ASK.amountCents).toBe(0);
    expect(NO_ADDITIONAL_ASK.carriedCents).toBe(0);
  });
});

describe("#3371 fix round - an ask cannot be taken apart and put back together", () => {
  /*
    THE RUNTIME HALF OF THE STRUCTURAL DEVICE, and the reason it is worth a test
    rather than a sentence. The forgery the type must refuse is
    `{ ...NO_ADDITIONAL_ASK, amountCents: someDelta }` - a positive ask recording
    a zero carried balance, which is exactly the money leak #3340 and #3371 both
    closed. It compiled clean against the `unique symbol` brand this replaced,
    because TypeScript carries a symbol-keyed property through a spread.

    The compiler is what refuses it now (`#carriedCents` is dropped by a spread,
    so the result is missing a member of the type), and a compile error is not
    something a runtime suite can assert. What IS observable here is the same
    fact from the other side: the spread really does lose the carried figure, so
    a forgery would have been silently wrong rather than merely ill-typed.
  */
  it("loses the carried figure when spread, which is why the type refuses one", () => {
    const ask = sizeReviewChargeAsk({
      shareTotalCents: 6000,
      payment: askPayment(20000, "PENDING"),
    });
    expect(ask.amountCents).toBe(26000);
    expect(ask.carriedCents).toBe(20000);
    expect(Object.keys({ ...ask })).toEqual(["amountCents"]);
  });
});

describe("the two forms of the rule agree wherever the ledger is clean", () => {
  /*
    Both of the issue's acceptance criteria, and its 1a variants, computed BOTH
    ways. This is the test that would fail if the module's docblock were wrong
    about the agreement — the claim is checked, not asserted.
  */
  const shapes = [
    {
      name: "AC1 — the completed-booking shape: $130 paid, +$70 unpaid, +$70",
      priceDiffCents: 7000,
      changeFeeCents: 0,
      ledger: {
        finalPriceCents: 27000,
        amountCents: 13000,
        refundedAmountCents: 0,
        creditAppliedCents: 0,
      },
      ask: askPayment(7000, "PENDING"),
      expected: 14000,
    },
    {
      name: "AC2 — the live shape: $65 net paid, price now $430",
      priceDiffCents: 30000,
      changeFeeCents: 0,
      ledger: {
        finalPriceCents: 43000,
        amountCents: 6500,
        refundedAmountCents: 0,
        creditAppliedCents: 0,
      },
      ask: askPayment(6500, "PENDING"),
      expected: 36500,
    },
    {
      name: "AC1a — the first extra was PAID before the second edit",
      priceDiffCents: 7000,
      changeFeeCents: 0,
      ledger: {
        finalPriceCents: 27000,
        amountCents: 20000,
        refundedAmountCents: 0,
        creditAppliedCents: 0,
      },
      ask: askPayment(7000, "SUCCEEDED"),
      expected: 7000,
    },
    {
      name: "AC1a — the other ordering: paid extra first, then an unpaid one",
      priceDiffCents: 7000,
      changeFeeCents: 0,
      ledger: {
        finalPriceCents: 34000,
        amountCents: 20000,
        refundedAmountCents: 0,
        creditAppliedCents: 0,
      },
      ask: askPayment(7000, "PENDING"),
      expected: 14000,
    },
    {
      name: "account credit paid part of the price",
      priceDiffCents: 5000,
      changeFeeCents: 0,
      ledger: {
        finalPriceCents: 20000,
        amountCents: 10000,
        refundedAmountCents: 0,
        creditAppliedCents: 5000,
      },
      ask: askPayment(0, null),
      expected: 5000,
    },
  ];

  for (const shape of shapes) {
    it(`${shape.name}`, () => {
      const sized = sizeAdditionalAsk({
        priceDiffCents: shape.priceDiffCents,
        changeFeeCents: shape.changeFeeCents,
        payment: shape.ask,
      });
      expect(sized.amountCents).toBe(shape.expected);
      expect(priceDerivedOutstandingCents(shape.ledger)).toBe(shape.expected);
    });
  }
});

describe("where the two forms part company, and why this one is right", () => {
  /*
    Recorded as a TEST rather than only as prose, because it is the one place
    this implementation knowingly answers differently from the issue's headline
    formula, and a future reader must be able to see the numbers.

    Both shapes are the club legitimately holding money that is NOT the booking's
    price. Reading the outstanding balance off the price hands that money back on
    the member's next increase.
  */
  it("a policy-tiered reduction: the retained slice is a charge, not a prepayment", () => {
    // $200 booking paid in full. A reduction to $100 refunds only the tiered
    // half (`INV-MOD-011`), so the club keeps $50 as a policy charge.
    const afterReduction = {
      finalPriceCents: 10000,
      amountCents: 20000,
      refundedAmountCents: 5000,
      creditAppliedCents: 0,
    };
    // A later +$30 edit. Nothing is being superseded — no ask is outstanding.
    const sized = sizeAdditionalAsk({
      priceDiffCents: 3000,
      changeFeeCents: 0,
      payment: askPayment(0, null),
    });
    expect(sized.amountCents).toBe(3000);

    const priceDerived = priceDerivedOutstandingCents({
      ...afterReduction,
      finalPriceCents: afterReduction.finalPriceCents + 3000,
    });
    // The price-derived form says the member owes NOTHING for the guest they
    // just added, because it reads the retained policy charge as an overpayment.
    expect(priceDerived).toBe(-2000);
  });

  it("a reduction settled as account credit: no refund, so `amountCents` is untouched", () => {
    const afterCreditSettledReduction = {
      finalPriceCents: 10000,
      amountCents: 20000,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
    };
    const sized = sizeAdditionalAsk({
      priceDiffCents: 3000,
      changeFeeCents: 0,
      payment: askPayment(0, null),
    });
    expect(sized.amountCents).toBe(3000);
    expect(
      priceDerivedOutstandingCents({
        ...afterCreditSettledReduction,
        finalPriceCents: afterCreditSettledReduction.finalPriceCents + 3000,
      }),
    ).toBe(-7000);
  });

  it("a pre-#3340 under-collection is NOT folded into the next ask", () => {
    // One of the two bookings the production census found: $270 owed, $200
    // collected, $70 lost. The owner's 8 Sep 2026 decision is that no code path
    // retro-corrects it — the members are being invoiced by hand.
    const short = {
      finalPriceCents: 28000,
      amountCents: 20000,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
    };
    expect(
      sizeAdditionalAsk({
        priceDiffCents: 1000,
        changeFeeCents: 0,
        payment: askPayment(7000, "SUCCEEDED"),
      }).amountCents,
    ).toBe(1000);
    // The price-derived form would ask for the $70 as well — a retro-correction.
    expect(priceDerivedOutstandingCents(short)).toBe(8000);
  });
});

describe("applyPaymentAdjustments sizes the real ask", () => {
  function bookingWith(
    payment: Partial<{
      status: PaymentStatus;
      source: PaymentSource;
      amountCents: number;
      refundedAmountCents: number;
      creditAppliedCents: number;
      additionalAmountCents: number;
      additionalPaymentStatus: string | null;
      xeroInvoiceId: string | null;
    }>,
  ) {
    return {
      id: "booking_1",
      status: "PAID",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      lodgeId: "lodge_1",
      memberId: "member_1",
      payment: {
        id: "payment_1",
        status: PaymentStatus.SUCCEEDED,
        source: PaymentSource.STRIPE,
        amountCents: 13000,
        refundedAmountCents: 0,
        creditAppliedCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        xeroInvoiceId: null,
        ...payment,
      },
    } as unknown as LoadedBookingForModify;
  }

  function stubTx() {
    return {
      payment: { update: vi.fn().mockResolvedValue({}) },
    } as unknown as Parameters<typeof applyPaymentAdjustments>[0];
  }

  it("asks for the WHOLE outstanding balance when it supersedes an unpaid ask", async () => {
    const result = await applyPaymentAdjustments(stubTx(), {
      booking: bookingWith({
        additionalAmountCents: 7000,
        additionalPaymentStatus: "PENDING",
      }),
      priceDiffCents: 7000,
      changeFeeCents: 0,
    });
    // Before #3340 this was 7000 and the first extra simply stopped being owed.
    expect(result.additionalAmountCents).toBe(14000);
  });

  it("reproduces the live shape at $365", async () => {
    const result = await applyPaymentAdjustments(stubTx(), {
      booking: bookingWith({
        amountCents: 6500,
        additionalAmountCents: 6500,
        additionalPaymentStatus: "PENDING",
      }),
      priceDiffCents: 30000,
      changeFeeCents: 0,
    });
    expect(result.additionalAmountCents).toBe(36500);
  });

  it("is unchanged when there is nothing to supersede", async () => {
    const result = await applyPaymentAdjustments(stubTx(), {
      booking: bookingWith({}),
      priceDiffCents: 7000,
      changeFeeCents: 0,
    });
    expect(result.additionalAmountCents).toBe(7000);
  });

  it("does not double-ask for an extra that has already been paid", async () => {
    const result = await applyPaymentAdjustments(stubTx(), {
      booking: bookingWith({
        amountCents: 20000,
        additionalAmountCents: 7000,
        additionalPaymentStatus: "SUCCEEDED",
      }),
      priceDiffCents: 7000,
      changeFeeCents: 0,
    });
    expect(result.additionalAmountCents).toBe(7000);
  });

  it("adds the change fee to the folded-in balance", async () => {
    const tx = stubTx();
    const result = await applyPaymentAdjustments(tx, {
      booking: bookingWith({
        additionalAmountCents: 7000,
        additionalPaymentStatus: "PENDING",
      }),
      priceDiffCents: 7000,
      changeFeeCents: 1500,
    });
    expect(result.additionalAmountCents).toBe(15500);
    // The fee itself is still recorded on the payment exactly as before.
    expect(tx.payment.update).toHaveBeenCalledWith({
      where: { id: "payment_1" },
      data: { changeFeeCents: { increment: 1500 } },
    });
  });

  it("leaves the Xero-only arm on the edit's own net, which supersedes nothing", async () => {
    // No captured Stripe payment, but a PRIMARY Xero invoice was issued: the
    // edit raises a SUPPLEMENTARY INVOICE for this edit's difference, collected
    // alongside whatever came before it rather than replacing it.
    const result = await applyPaymentAdjustments(stubTx(), {
      booking: bookingWith({
        status: PaymentStatus.PENDING,
        source: PaymentSource.INTERNET_BANKING,
        amountCents: 0,
        xeroInvoiceId: "INV-4452",
        additionalAmountCents: 7000,
        additionalPaymentStatus: "PENDING",
      }),
      priceDiffCents: 7000,
      changeFeeCents: 0,
    });
    expect(result.additionalAmountCents).toBe(7000);
    expect(result.xeroAdditionalAmountCents).toBe(7000);
  });

  it("leaves the captured-Internet-Banking arm on the edit's own net too", async () => {
    const result = await applyPaymentAdjustments(stubTx(), {
      booking: bookingWith({
        source: PaymentSource.INTERNET_BANKING,
        xeroInvoiceId: "INV-4452",
        additionalAmountCents: 7000,
        additionalPaymentStatus: "PENDING",
      }),
      priceDiffCents: 7000,
      changeFeeCents: 0,
    });
    expect(result.additionalAmountCents).toBe(7000);
  });
});

describe("the ledger identity, and its SQL twin", () => {
  function row(
    overrides: Partial<BookingLedgerIdentityRow> = {},
  ): BookingLedgerIdentityRow {
    return {
      finalPriceCents: 27000,
      changeFeeCents: 0,
      amountCents: 13000,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
      additionalAmountCents: 14000,
      additionalPaymentStatus: "PENDING",
      ...overrides,
    };
  }

  it("balances when the ask covers everything the price still wants", () => {
    expect(bookingLedgerResidualCents(row())).toBe(0);
    expect(bookingLedgerVerdict(0)).toBe("balanced");
  });

  it("reports the #3340 class as money nobody is asking for", () => {
    // The pre-#3340 answer: a $70 ask against a $140 shortfall.
    const residual = bookingLedgerResidualCents(
      row({ additionalAmountCents: 7000 }),
    );
    expect(residual).toBe(7000);
    expect(bookingLedgerVerdict(residual)).toBe("unasked");
  });

  it("reads a collected ask as collected, not as an outstanding term", () => {
    const residual = bookingLedgerResidualCents(
      row({ amountCents: 27000, additionalPaymentStatus: "SUCCEEDED" }),
    );
    expect(residual).toBe(0);
  });

  it("counts the change fee, which the price column never carries", () => {
    const residual = bookingLedgerResidualCents(
      row({
        changeFeeCents: 1500,
        amountCents: 28500,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      }),
    );
    expect(residual).toBe(0);
  });

  it("calls a policy-retained or credit-settled reduction retained, never a failure", () => {
    const residual = bookingLedgerResidualCents(
      row({
        finalPriceCents: 10000,
        amountCents: 20000,
        refundedAmountCents: 5000,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      }),
    );
    expect(residual).toBe(-5000);
    expect(bookingLedgerVerdict(residual)).toBe("retained");
  });

  it("generates the SQL from the same term list, in the same order", () => {
    expect(bookingLedgerResidualSql()).toBe(
      'b."finalPriceCents" + p."changeFeeCents" - p."amountCents" ' +
        '+ p."refundedAmountCents" - p."creditAppliedCents" ' +
        '- (CASE WHEN p."additionalAmountCents" > 0 AND p."additionalPaymentStatus" ' +
        "IS DISTINCT FROM 'SUCCEEDED' THEN p.\"additionalAmountCents\" ELSE 0 END)",
    );
  });

  it("ships a census that reads and never writes", () => {
    const sql = bookingLedgerCensusSql();
    expect(sql.startsWith("SELECT")).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/i);
    // The exclusions the identity depends on being true.
    expect(sql).toContain("b.\"deletedAt\" IS NULL");
    expect(sql).toContain("'CANCELLED', 'BUMPED'");
    expect(sql).toContain("'SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'");
  });
});
