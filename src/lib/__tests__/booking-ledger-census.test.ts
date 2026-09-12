import { describe, expect, it } from "vitest";

import {
  bookingLedgerResidualCents,
  bookingLedgerVerdict,
  describeBookingLedgerResidual,
  sizeAdditionalAskCents,
  type BookingLedgerIdentityRow,
} from "@/lib/additional-payment-ask";

/*
  #3340 scope item 6 — THE CENSUS GUARD.

  ENFORCES `INV-PAY-047` (docs/invariants/payment-and-settlement.md). Every
  assertion below names that id in its failure message, so whoever trips one is
  handed the rule rather than having to go and find it — the same arrangement as
  `raw-sql-shape-guard.test.ts`.

  WHAT MAKES THIS A GUARD AND NOT A TABLE OF NUMBERS I CHOSE. The fixtures are
  not hand-written ledgers; each is BUILT by replaying booking edits through the
  production sizing function, `sizeAdditionalAskCents`, and then paying (or not
  paying) the ask it produced. So the identity is being asked of what the real
  code decides, and a regression in the sizing rule — a revert to the bare
  per-modification delta, say — makes a fixture stop balancing rather than making
  a literal stop matching a literal.

  Mutation-verified per `docs/TESTING.md`: dropping the superseded term from
  `sizeAdditionalAskCents` fails `two consecutive increases, the first left
  unpaid` with a residual of +7000 cents and the invariant id in the message.

  Frozen clock inherited and never consulted: every figure here is integer cents.
*/

/** A booking's money as the identity reads it, plus the running edit state. */
type Ledger = BookingLedgerIdentityRow;

function newBooking(params: {
  finalPriceCents: number;
  paidCents: number;
}): Ledger {
  return {
    finalPriceCents: params.finalPriceCents,
    changeFeeCents: 0,
    amountCents: params.paidCents,
    refundedAmountCents: 0,
    creditAppliedCents: 0,
    additionalAmountCents: 0,
    additionalPaymentStatus: null,
  };
}

/**
 * One price-increasing edit against a captured card payment, written the way the
 * production path writes it: the ask comes from `sizeAdditionalAskCents`, and
 * minting it RETIRES whatever ask was there before (which is the whole defect —
 * `queueSupersededAdditionalIntentCancellations` cancels the old intent, so the
 * new figure is the only one anybody will ever collect).
 */
function applyPriceIncrease(
  ledger: Ledger,
  params: { priceDiffCents: number; changeFeeCents?: number },
): Ledger {
  const changeFeeCents = params.changeFeeCents ?? 0;
  const ask = sizeAdditionalAskCents({
    priceDiffCents: params.priceDiffCents,
    changeFeeCents,
    payment: ledger,
  });
  return {
    ...ledger,
    finalPriceCents: ledger.finalPriceCents + params.priceDiffCents,
    changeFeeCents: ledger.changeFeeCents + changeFeeCents,
    additionalAmountCents: ask,
    additionalPaymentStatus: "PENDING",
  };
}

/** The member pays the live ask. Stripe captures it, so `amountCents` grows. */
function payOutstandingAsk(ledger: Ledger): Ledger {
  return {
    ...ledger,
    amountCents: ledger.amountCents + ledger.additionalAmountCents,
    additionalPaymentStatus: "SUCCEEDED",
  };
}

/** The member's card declines. Still owed, so the term stays. */
function failOutstandingAsk(ledger: Ledger): Ledger {
  return { ...ledger, additionalPaymentStatus: "FAILED" };
}

interface Scenario {
  label: string;
  build: () => Ledger;
  /** What the identity must say. `retained` shapes are reported, never failed. */
  verdict: "balanced" | "retained";
  expectedResidualCents: number;
}

const SCENARIOS: Scenario[] = [
  {
    label: "a paid booking nobody has edited",
    build: () => newBooking({ finalPriceCents: 13000, paidCents: 13000 }),
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "one increase, still unpaid",
    build: () =>
      applyPriceIncrease(
        newBooking({ finalPriceCents: 13000, paidCents: 13000 }),
        { priceDiffCents: 7000 },
      ),
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "two consecutive increases, the first left unpaid",
    // THE #3340 SHAPE. Before the fix the second edit asked $70 and the first
    // $70 ceased to be owed, leaving +7000 here for ever.
    build: () => {
      let ledger = newBooking({ finalPriceCents: 13000, paidCents: 13000 });
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 7000 });
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 7000 });
      return ledger;
    },
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "the live shape: $65 paid, then +$65, then +$300",
    build: () => {
      let ledger = newBooking({ finalPriceCents: 6500, paidCents: 6500 });
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 6500 });
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 30000 });
      return ledger;
    },
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "the first extra was PAID before the second edit",
    build: () => {
      let ledger = newBooking({ finalPriceCents: 13000, paidCents: 13000 });
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 7000 });
      ledger = payOutstandingAsk(ledger);
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 7000 });
      return ledger;
    },
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "the first extra was DECLINED before the second edit",
    build: () => {
      let ledger = newBooking({ finalPriceCents: 13000, paidCents: 13000 });
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 7000 });
      ledger = failOutstandingAsk(ledger);
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 7000 });
      return ledger;
    },
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "three increases with change fees, every ask paid at the end",
    build: () => {
      let ledger = newBooking({ finalPriceCents: 13000, paidCents: 13000 });
      ledger = applyPriceIncrease(ledger, {
        priceDiffCents: 7000,
        changeFeeCents: 1500,
      });
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 3000 });
      ledger = applyPriceIncrease(ledger, {
        priceDiffCents: 2000,
        changeFeeCents: 500,
      });
      return payOutstandingAsk(ledger);
    },
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "account credit paid part of the price, then an increase",
    build: () => {
      const ledger = {
        ...newBooking({ finalPriceCents: 20000, paidCents: 15000 }),
        creditAppliedCents: 5000,
      };
      return applyPriceIncrease(ledger, { priceDiffCents: 4000 });
    },
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "a policy-tiered reduction kept a slice the price no longer names",
    // `INV-MOD-011`: $200 paid, reduced to $100, only the tiered $50 refunded.
    // The club holds $150 against a $100 price, which is the policy working.
    build: () => ({
      ...newBooking({ finalPriceCents: 10000, paidCents: 20000 }),
      refundedAmountCents: 5000,
    }),
    verdict: "retained",
    expectedResidualCents: -5000,
  },
];

describe("INV-PAY-047: every live booking's money balances", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.label, () => {
      const row = scenario.build();
      const residual = bookingLedgerResidualCents(row);
      const message = describeBookingLedgerResidual({
        label: scenario.label,
        row,
        residualCents: residual,
      });

      // The headline assertion: NOTHING built by the production sizing rule may
      // leave money the price says is owed that no ask is collecting.
      expect(bookingLedgerVerdict(residual), message).not.toBe("unasked");
      expect(bookingLedgerVerdict(residual), message).toBe(scenario.verdict);
      expect(residual, message).toBe(scenario.expectedResidualCents);
    });
  }

  it("names INV-PAY-047 and every term when it fails", () => {
    // A seeded mis-sized booking: the pre-#3340 answer to the two-edit shape.
    const misSized: BookingLedgerIdentityRow = {
      finalPriceCents: 27000,
      changeFeeCents: 0,
      amountCents: 13000,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
      additionalAmountCents: 7000,
      additionalPaymentStatus: "PENDING",
    };
    const residual = bookingLedgerResidualCents(misSized);
    expect(residual).toBe(7000);
    expect(bookingLedgerVerdict(residual)).toBe("unasked");

    const message = describeBookingLedgerResidual({
      label: "a seeded mis-sized booking",
      row: misSized,
      residualCents: residual,
    });
    expect(message).toContain("INV-PAY-047");
    expect(message).toContain("Residual 7000 cents");
    expect(message).toContain("the uncollected ask");
    expect(message).toContain("change fees");
  });
});
