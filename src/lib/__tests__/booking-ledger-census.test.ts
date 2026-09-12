import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  IT IS TWO GUARDS, AND SAYING SO IS THE POINT. The first half below is an
  ARITHMETIC guard: it replays edits through the production sizing function and
  checks the identity. It reads no fixture and no seed data, so it proves the
  sizing RULE and says nothing whatever about which call sites use it — a door
  that never calls `sizeAdditionalAskCents` is invisible to it by construction,
  and one such door (`guests/route.ts`) was open when this file was first
  written. The second half is therefore a CALL-SITE census over the source tree,
  which is the half that can see a new door.

  WHAT MAKES THE FIRST HALF A GUARD AND NOT A TABLE OF NUMBERS I CHOSE. The fixtures are
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

/*
  #3340 fix round — THE CALL-SITE CENSUS.

  ENFORCES `INV-PAY-047` and `INV-ADDPAY-023`. Minting an ADDITIONAL
  PaymentIntent RETIRES every other outstanding ask on the payment
  (`queueSupersededAdditionalIntentCancellations`), so every door that mints one
  is a door that can delete money. The arithmetic guard above cannot see them:
  it replays the sizing function, so a door that never calls it is invisible.

  This half scans the tree instead. Every file that calls the shared minter must
  reach its figure through `sizeAdditionalAskCents` — directly, or through
  `applyPaymentAdjustments`, which is the one place three of them share — or be
  named below with the issue that owns it. A sixth door added later fails here
  with the invariant id rather than being noticed in a review two rounds on,
  which is how the fifth one was found.

  It has no import edge to the files it scans, so `vitest related` cannot select
  it from a diff; that is deliberate and it is CI-caught by design
  (`AGENTS.md`, "What `test:related` does NOT cover").
*/
/**
 * Every door that mints an ADDITIONAL PaymentIntent, and the MODULE that sizes
 * its figure. Three of them share `booking-modify-settlement`'s
 * `applyPaymentAdjustments`; one sizes for itself; one is exempt.
 *
 * `sizedIn` is a tracked file that must call `sizeAdditionalAskCents`, and the
 * door must reference it (its own path, or the module specifier it imports it
 * by) - so the chain is checked rather than assumed.
 */
const ASK_MINTING_DOORS: readonly {
  door: string;
  sizedIn: string;
  reachedBy: string;
  exemptIssue?: string;
}[] = [
  {
    // Settles for itself, so it calls the one home directly (#3340 fix round).
    door: "src/app/api/bookings/[id]/guests/route.ts",
    sizedIn: "src/app/api/bookings/[id]/guests/route.ts",
    reachedBy: "sizeAdditionalAskCents",
  },
  {
    door: "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    sizedIn: "src/lib/booking-modify-settlement.ts",
    reachedBy: "@/lib/booking-guest-removal-service",
  },
  {
    door: "src/lib/booking-batch-modification-service.ts",
    sizedIn: "src/lib/booking-modify-settlement.ts",
    reachedBy: "applyPaymentAdjustments",
  },
  {
    door: "src/lib/booking-date-modification-service.ts",
    sizedIn: "src/lib/booking-modify-settlement.ts",
    reachedBy: "applyPaymentAdjustments",
  },
  {
    /**
     * THE ONE EXEMPTION, and the reason it cannot simply be routed.
     *
     * `syncEditFinancialReviewChargeRequest` derives this ask as the SUM of one
     * edit's settled shares, and compares that sum against the recorded
     * request's amount to decide whether a later share needs a raise
     * (`totalCents <= existing.amountCents` writes nothing). Folding a
     * superseded balance into the first mint corrupts that yardstick: a second
     * share smaller than the folded-in balance reads as already covered and is
     * DROPPED, and re-folding on the later run double-counts, because by then
     * the payment's ask column mirrors the review's own intent. The fix needs
     * the folded amount tracked apart from the share total, which is a design
     * change rather than a call swap.
     */
    door: "src/lib/edit-financial-review-charge.ts",
    sizedIn: "src/lib/edit-financial-review-charge.ts",
    reachedBy: "sumEditReviewChargeSharesCents",
    exemptIssue: "#3371",
  },
];

const SIZING_FUNCTION = "sizeAdditionalAskCents";
const MINTER = "createModificationAdditionalPaymentIntent";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("every ask-minting door routes through the sizing rule (INV-PAY-047)", () => {
  it("finds exactly the pinned set of doors, so a sixth cannot appear unreviewed", () => {
    const pinned = ASK_MINTING_DOORS.map((entry) => entry.door);
    // Only the minter's own module may call it without being a door.
    const callers = [
      ...pinned,
      "src/lib/booking-modification-settlement.ts",
    ].filter((file) => read(file).includes(`${MINTER}(`));
    expect(
      callers.length,
      `INV-PAY-047: a pinned ask-minting door no longer calls ${MINTER}. ` +
        "Update ASK_MINTING_DOORS in the same change.",
    ).toBe(pinned.length + 1);
  });

  for (const entry of ASK_MINTING_DOORS) {
    if (entry.exemptIssue) {
      it(`${entry.door} is exempt, and its exemption is still true (${entry.exemptIssue})`, () => {
        // The day this door DOES size through the rule, the manifest entry must
        // go - and this fails until it does, so an exemption cannot outlive its
        // reason.
        expect(
          read(entry.door).includes(SIZING_FUNCTION),
          `INV-PAY-047: ${entry.door} now calls ${SIZING_FUNCTION}. ` +
            `Delete its exemption (${entry.exemptIssue}) from ASK_MINTING_DOORS.`,
        ).toBe(false);
      });
      continue;
    }

    it(`${entry.door} sizes through the one home`, () => {
      expect(
        read(entry.door).includes(entry.reachedBy),
        `INV-PAY-047: ${entry.door} mints an ADDITIONAL PaymentIntent, which retires ` +
          "every other outstanding ask on the payment, and no longer reaches its " +
          `sizing through ${entry.reachedBy}. A bare delta there deletes the unpaid ` +
          "balance of the ask it replaces (#3340).",
      ).toBe(true);
      expect(
        read(entry.sizedIn).includes(`${SIZING_FUNCTION}({`),
        `INV-PAY-047 / INV-ADDPAY-023: ${entry.sizedIn} sizes the ask for ` +
          `${entry.door} and no longer calls ${SIZING_FUNCTION}.`,
      ).toBe(true);
    });
  }

  /*
    The guest-add door carries TWO arms over one variable, and they must stay
    different figures. The Stripe ask folds in the superseded balance because
    minting retires it; the Xero arm sizes a SUPPLEMENTARY INVOICE for this edit
    alone, which supersedes nothing - fold a Stripe balance into that and the
    club invoices the same money twice.
  */
  it("keeps the guest-add door's Stripe and Xero arms separately sized", () => {
    const source = read("src/app/api/bookings/[id]/guests/route.ts");
    expect(
      source,
      "INV-PAY-047: the guest-add door's STRIPE arm must size through " +
        `${SIZING_FUNCTION} (#3340).`,
    ).toMatch(
      /if \(hasSucceededPayment && priceDiffCents > 0\) \{\s*additionalAmountCents = sizeAdditionalAskCents\(\{/,
    );
    expect(
      source,
      "INV-MONEY / INV-INT: the guest-add door's XERO arm bills THIS edit's delta. " +
        "Folding a superseded Stripe balance into a supplementary invoice invoices " +
        "the same money twice.",
    ).toMatch(
      /\} else if \(hasIssuedXeroInvoice && priceDiffCents > 0\) \{\s*additionalAmountCents = priceDiffCents;/,
    );
  });

  it("keeps the sizing rule itself in one module (INV-SSOT-001)", () => {
    expect(read("src/lib/additional-payment-ask.ts")).toContain(
      `export function ${SIZING_FUNCTION}`,
    );
    const redefined = [
      ...new Set(
        ASK_MINTING_DOORS.flatMap((entry) => [entry.door, entry.sizedIn]),
      ),
    ].filter((file) => read(file).includes(`function ${SIZING_FUNCTION}`));
    expect(
      redefined,
      `INV-SSOT-001: ${SIZING_FUNCTION} is defined outside its one home.`,
    ).toEqual([]);
  });
});
