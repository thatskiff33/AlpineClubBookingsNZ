import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripCommentsAndStrings } from "./support/strip-comments";

import {
  BOOKING_LEDGER_CENSUS_CAPTURED_PAYMENT_STATUSES,
  BOOKING_LEDGER_CENSUS_EXCLUDED_BOOKING_STATUSES,
  BOOKING_LEDGER_IDENTITY_TERMS,
  bookingLedgerCensusSql,
  bookingLedgerResidualCents,
  bookingLedgerResidualSql,
  bookingLedgerVerdict,
  describeBookingLedgerResidual,
  sizeAdditionalAsk,
  sizeReviewChargeAsk,
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
  that never calls the one home is invisible to it by construction,
  and one such door (`guests/route.ts`) was open when this file was first
  written. The second half is therefore a CALL-SITE census over the source tree,
  which is the half that can see a new door.

  WHAT MAKES THE FIRST HALF A GUARD AND NOT A TABLE OF NUMBERS I CHOSE. The fixtures are
  not hand-written ledgers; each is BUILT by replaying booking edits through the
  production sizing functions, `sizeAdditionalAsk` and `sizeReviewChargeAsk`,
  and then paying (or not paying) the ask each produced. So the identity is being asked of what the real
  code decides, and a regression in the sizing rule — a revert to the bare
  per-modification delta, say — makes a fixture stop balancing rather than making
  a literal stop matching a literal.

  Mutation-verified per `docs/TESTING.md`: dropping the superseded term from
  `sizeAdditionalAsk` fails `two consecutive increases, the first left unpaid`
  with a residual of +7000 cents and the invariant id in the message, and
  dropping it from `sizeReviewChargeAsk` fails the #3371 shape below with
  +20000.

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
 * production path writes it: the ask comes from `sizeAdditionalAsk`, and
 * minting it RETIRES whatever ask was there before (which is the whole defect —
 * `queueSupersededAdditionalIntentCancellations` cancels the old intent, so the
 * new figure is the only one anybody will ever collect).
 */
function applyPriceIncrease(
  ledger: Ledger,
  params: { priceDiffCents: number; changeFeeCents?: number },
): Ledger {
  const changeFeeCents = params.changeFeeCents ?? 0;
  const ask = sizeAdditionalAsk({
    priceDiffCents: params.priceDiffCents,
    changeFeeCents,
    payment: ledger,
  });
  return {
    ...ledger,
    finalPriceCents: ledger.finalPriceCents + params.priceDiffCents,
    changeFeeCents: ledger.changeFeeCents + changeFeeCents,
    additionalAmountCents: ask.amountCents,
    additionalPaymentStatus: "PENDING",
  };
}

/**
 * #3371 - AN OFFICER SETTLES A PARKED FINANCIAL REVIEW AS MONEY OWED.
 *
 * Written the way that production path writes it, which is the whole point of
 * putting it in this file: the ask comes from `sizeReviewChargeAsk`, and minting
 * it RETIRES whatever ask was there before, whoever raised it. `shareTotalCents`
 * is the sum of the shares settled against THIS edit; the booking's price rose
 * when the edit landed, so the price term is raised by the same figure and NOT
 * by the carried part - the carried part is money the price already names, owed
 * from an earlier change.
 */
function applyReviewCharge(
  ledger: Ledger,
  params: { shareTotalCents: number },
): Ledger {
  const ask = sizeReviewChargeAsk({
    shareTotalCents: params.shareTotalCents,
    payment: ledger,
  });
  return {
    ...ledger,
    finalPriceCents: ledger.finalPriceCents + params.shareTotalCents,
    additionalAmountCents: ask.amountCents,
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
    label: "#3371: two parked edits settled as review charges, $200 then $60",
    // THE #3371 SHAPE. Before the fix the second review charge asked $60 and the
    // first $200 ceased to be owed: $260 priced, $60 collected, +20000 here for
    // ever and no surface reporting it.
    build: () => {
      let ledger = newBooking({ finalPriceCents: 13000, paidCents: 13000 });
      ledger = applyReviewCharge(ledger, { shareTotalCents: 20000 });
      ledger = applyReviewCharge(ledger, { shareTotalCents: 6000 });
      return ledger;
    },
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "#3371: an ordinary unpaid extra, then a review charge (ordering 1)",
    build: () => {
      let ledger = newBooking({ finalPriceCents: 13000, paidCents: 13000 });
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 7000 });
      ledger = applyReviewCharge(ledger, { shareTotalCents: 6000 });
      return ledger;
    },
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "#3371: a review charge, then an ordinary edit, then both paid",
    build: () => {
      let ledger = newBooking({ finalPriceCents: 13000, paidCents: 13000 });
      ledger = applyReviewCharge(ledger, { shareTotalCents: 20000 });
      ledger = applyPriceIncrease(ledger, { priceDiffCents: 7000 });
      return payOutstandingAsk(ledger);
    },
    verdict: "balanced",
    expectedResidualCents: 0,
  },
  {
    label: "#3371: the first review charge was PAID before the second",
    build: () => {
      let ledger = newBooking({ finalPriceCents: 13000, paidCents: 13000 });
      ledger = applyReviewCharge(ledger, { shareTotalCents: 20000 });
      ledger = payOutstandingAsk(ledger);
      ledger = applyReviewCharge(ledger, { shareTotalCents: 6000 });
      return ledger;
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
  #3340 fix round - THE CALL-SITE CENSUS. Widened by #3371.

  ENFORCES `INV-PAY-047`, `INV-PAY-098` and `INV-ADDPAY-023`. Minting an
  ADDITIONAL PaymentIntent RETIRES every other outstanding ask on the payment
  (`queueSupersededAdditionalIntentCancellations`), so every door that mints one
  is a door that can delete money. The arithmetic guard above cannot see them:
  it replays the sizing functions, so a door that never calls one is invisible.

  This half scans the tree instead. Every file that calls the shared minter must
  reach its figure through a constructor exported by `@/lib/additional-payment-ask`
  - directly, or through `applyPaymentAdjustments`, which is the one place three
  of them share. A sixth door added later fails here with the invariant id rather
  than being noticed in a review two rounds on, which is how the fifth one was
  found.

  #3371 REMOVED THE ONE EXEMPTION AND THE MACHINERY THAT CARRIED IT. The review
  charge sized itself from its own settled shares and was exempt while nobody had
  ruled on how the two rules compose; the owner ruled on 13 Sep 2026, and the
  answer is that they are ONE rule - a replacement ask carries the unpaid balance
  of the ask it supersedes. There is no exempt door now and no field to declare
  one, deliberately: a future exemption should be a visible change to this
  manifest's shape rather than a string somebody adds.

  It has no import edge to the files it scans, so `vitest related` cannot select
  it from a diff; that is deliberate and it is CI-caught by design
  (`AGENTS.md`, "What `test:related` does NOT cover").
*/
/**
 * Every door that mints an ADDITIONAL PaymentIntent, the MODULE that sizes its
 * figure, and the CONSTRUCTOR it is built with. Three of them share
 * `booking-modify-settlement`'s `applyPaymentAdjustments`; two size for
 * themselves.
 *
 * `sizedIn` is a tracked file that must call `builtWith`, and the door must
 * reference `reachedBy` (its own path, or the module specifier it imports it by)
 * - so the chain is checked rather than assumed.
 */
const ASK_MINTING_DOORS: readonly {
  door: string;
  sizedIn: string;
  reachedBy: string;
  builtWith: string;
}[] = [
  {
    // Settles for itself, so it calls the one home directly (#3340 fix round).
    door: "src/app/api/bookings/[id]/guests/route.ts",
    sizedIn: "src/app/api/bookings/[id]/guests/route.ts",
    reachedBy: "sizeAdditionalAsk",
    builtWith: "sizeAdditionalAsk",
  },
  {
    door: "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    sizedIn: "src/lib/booking-modify-settlement.ts",
    reachedBy: "@/lib/booking-guest-removal-service",
    builtWith: "sizeAdditionalAsk",
  },
  {
    door: "src/lib/booking-batch-modification-service.ts",
    sizedIn: "src/lib/booking-modify-settlement.ts",
    reachedBy: "applyPaymentAdjustments",
    builtWith: "sizeAdditionalAsk",
  },
  {
    door: "src/lib/booking-date-modification-service.ts",
    sizedIn: "src/lib/booking-modify-settlement.ts",
    reachedBy: "applyPaymentAdjustments",
    builtWith: "sizeAdditionalAsk",
  },
  {
    /**
     * WAS THE ONE EXEMPTION (#3371). Its ask is the SUM of one edit's settled
     * shares rather than a price delta, so it has its own constructor - but it
     * is the same rule, and it now folds in the unpaid balance of the ask its
     * mint is about to retire exactly as the other four do.
     */
    door: "src/lib/edit-financial-review-charge.ts",
    sizedIn: "src/lib/edit-financial-review-charge.ts",
    reachedBy: "sizeReviewChargeAsk",
    builtWith: "sizeReviewChargeAsk",
  },
];

/** Every constructor the one home exports. Nothing else may build an ask. */
const ASK_CONSTRUCTORS: readonly string[] = [
  "sizeAdditionalAsk",
  "sizeReviewChargeAsk",
  "raiseReviewChargeAsk",
];
const ASK_HOME = "src/lib/additional-payment-ask.ts";
const MINTER = "createModificationAdditionalPaymentIntent";
const RETIRER = "queueSupersededAdditionalIntentCancellations";

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
    it(`${entry.door} sizes through the one home`, () => {
      expect(
        read(entry.door).includes(entry.reachedBy),
        `INV-PAY-047: ${entry.door} mints an ADDITIONAL PaymentIntent, which retires ` +
          "every other outstanding ask on the payment, and no longer reaches its " +
          `sizing through ${entry.reachedBy}. A bare delta there deletes the unpaid ` +
          "balance of the ask it replaces (#3340, #3371).",
      ).toBe(true);
      expect(
        read(entry.sizedIn).includes(`${entry.builtWith}({`),
        `INV-PAY-047 / INV-ADDPAY-023: ${entry.sizedIn} sizes the ask for ` +
          `${entry.door} and no longer calls ${entry.builtWith}.`,
      ).toBe(true);
    });
  }

  it("leaves no door exempt (#3371 closed the only one)", () => {
    expect(
      ASK_MINTING_DOORS.filter(
        (entry) => !ASK_CONSTRUCTORS.includes(entry.builtWith),
      ).map((entry) => entry.door),
      "INV-PAY-098: every ask-minting door must build its figure with a " +
        "constructor from @/lib/additional-payment-ask. The review-charge " +
        "exemption was closed by #3371 and no replacement was reviewed.",
    ).toEqual([]);
  });

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
        "sizeAdditionalAsk (#3340, #3371).",
    ).toMatch(
      /if \(hasSucceededPayment && priceDiffCents > 0\) \{\s*additionalAsk = sizeAdditionalAsk\(\{/,
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
    const home = read(ASK_HOME);
    for (const constructor of ASK_CONSTRUCTORS) {
      expect(home).toContain(`export function ${constructor}`);
    }
    const redefined = [
      ...new Set(
        ASK_MINTING_DOORS.flatMap((entry) => [entry.door, entry.sizedIn]),
      ),
    ].filter((file) =>
      ASK_CONSTRUCTORS.some((constructor) =>
        read(file).includes(`function ${constructor}`),
      ),
    );
    expect(
      redefined,
      "INV-SSOT-001: an ask constructor is defined outside its one home.",
    ).toEqual([]);
  });
});

/*
  #3371 - THE STRUCTURAL DEVICE, ASSERTED RATHER THAN TRUSTED.

  ENFORCES `INV-PAY-098`. The owner's 13 Sep 2026 decision is that recording what
  a mint absorbed must be STRUCTURALLY HARD TO OMIT rather than merely required,
  because the alternative is a permanent obligation on every future writer and
  "the day one forgets, the money vanishes again".

  THE DEVICE IS A CLASS WITH A `#private` FIELD, and the previous shape is why
  the wording here is careful. `AdditionalAsk` used to be an object type carrying
  a module-private `unique symbol` brand, and the docblock claimed "there is no
  cast that helps". BOTH of these compiled clean against it, measured with this
  repository's own compiler:

      const spread: AdditionalAsk = { ...NO_ADDITIONAL_ASK, amountCents: 50000 };
      const cast = { amountCents: 50000, carriedCents: 0 } as AdditionalAsk;

  The first needed no cast at all - TypeScript carries a symbol-keyed property
  through an object spread - and it is the ACCIDENT shape: a future writer adding
  a second arm as `{ ...NO_ADDITIONAL_ASK, amountCents: priceDiffCents }` would
  have recorded a positive ask carrying nothing. A `#private` field is dropped by
  a spread, so that one is now a type error naming the missing member.

  The second still compiles, and no type can stop it: `x as T` is permitted
  whenever `T` is assignable to the type of `x`, and a class is always assignable
  to the bare object type of its own public members. So the assertion is refused
  HERE instead, by name, over comment- and string-blanked source. That split is
  deliberate and is stated in the one home's docblock too: the type stops the
  accident, this census stops the shortcut.
*/
const ASK_TYPE = "AdditionalAsk";
const ASK_CLASS = "AdditionalAskValue";

/** Every tracked `.ts`/`.tsx` under `src`, which is where a forgery could live. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(join(process.cwd(), dir), {
    withFileTypes: true,
  })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      sourceFiles(relative, found);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      found.push(relative);
    }
  }
  return found;
}

describe("a mint cannot forget what it absorbed (INV-PAY-098)", () => {
  it("keeps the ask unconstructible outside the one home", () => {
    const home = read(ASK_HOME);
    expect(
      home,
      "INV-PAY-098: the private field that makes an AdditionalAsk unforgeable is " +
        "gone. Without it `{ ...NO_ADDITIONAL_ASK, amountCents: someDelta }` " +
        "type-checks again and hands the minter a positive ask carrying nothing.",
    ).toContain("readonly #carriedCents: number;");
    expect(
      home,
      `INV-PAY-098: the ${ASK_CLASS} class is EXPORTED, so any caller can reach ` +
        "its constructor and the type no longer proves anything. Export the " +
        "instance type alone.",
    ).not.toMatch(/export\s+(abstract\s+)?class\s+AdditionalAskValue\b/);
    expect(
      home,
      `INV-PAY-098: ${ASK_TYPE} is no longer the ${ASK_CLASS} instance type, so ` +
        "the private field no longer stands behind the name callers use.",
    ).toContain(`export type ${ASK_TYPE} = ${ASK_CLASS};`);
  });

  it("refuses a hand-cast ask anywhere outside the one home", () => {
    // Comment- AND string-blanked, because this repository documents a defect at
    // the site it removed it: the one home's own docblock quotes the forgery, and
    // so does the block above this test.
    //
    // The cheap `includes` runs FIRST and is not decoration: blanking every file
    // under `src` takes this suite past its five-second budget, while the type
    // name appears in a couple of dozen of them. The blanking then decides those.
    const offenders = sourceFiles("src")
      .filter((file) => file !== ASK_HOME)
      .map((file) => ({ file, source: read(file) }))
      .filter((entry) => entry.source.includes(ASK_TYPE))
      .filter((entry) =>
        /\bas\s+(unknown\s+as\s+)?AdditionalAsk\b/.test(
          stripCommentsAndStrings(entry.source),
        ),
      )
      .map((entry) => entry.file);
    expect(
      offenders,
      "INV-PAY-098: an AdditionalAsk is being ASSERTED into existence rather " +
        "than built by a constructor from @/lib/additional-payment-ask. The type " +
        "cannot refuse an assertion, which is why this refuses it: a hand-made " +
        "ask can record a positive amount and a zero carried balance, which is " +
        "the money leak #3340 and #3371 both closed.",
    ).toEqual([]);
  });

  it("keeps the minter taking the value rather than a number", () => {
    const minter = read("src/lib/booking-modification-settlement.ts");
    expect(
      minter,
      "INV-PAY-098: `createModificationAdditionalPaymentIntent` no longer reads " +
        "its figure from an AdditionalAsk. A plain `additionalAmountCents: number` " +
        "on its context is the shape the money leaked through in #3340 and #3371.",
    ).toContain("additionalAsk: AdditionalAsk;");
    expect(
      minter,
      "INV-PAY-098: the minter no longer records what it absorbed. The ADDITIONAL " +
        "row must be written with `carriedAskCents` from the SAME value that sized " +
        "the amount - once the retired rows are cancelled the figure is not " +
        "recoverable from anything.",
    ).toContain("carriedAskCents: result.additionalAsk.carriedCents,");
  });

  it("makes every retirement site record what it absorbed", () => {
    // The two sites that mint an ADDITIONAL intent and then retire the others.
    // `booking-payment-cleanup.ts` DEFINES the retirement and writes no ask, so
    // it is excluded by name rather than by a pattern that could drift.
    const retirers = [
      "src/lib/booking-modification-settlement.ts",
      "src/lib/payment-recovery.ts",
    ];
    for (const file of retirers) {
      const source = read(file);
      expect(
        source.includes(`${RETIRER}({`),
        `INV-PAY-098: ${file} no longer retires superseded asks. Update this ` +
          "list in the same change.",
      ).toBe(true);
      expect(
        source.includes("carriedAskCents:"),
        `INV-PAY-098: ${file} retires other asks and no longer records what the ` +
          "replacement absorbed. Once those rows are cancelled, what they were " +
          "owed for is not derivable from anything (#3371).",
      ).toBe(true);
    }
  });
});

/*
  #3340 fix round — THE SQL TWIN IS PINNED.

  `docs/MAINTENANCE.md` claimed the typed census and the operator SQL "cannot say
  different things" because both are folded from `BOOKING_LEDGER_IDENTITY_TERMS`.
  That is true of the term LIST — add a term and both grow — and it was false of
  each term's BODY, which is a `ts` closure and an independently written `sql`
  string with nothing holding them together. Nothing asserted anything about
  either SQL builder at all.

  What can honestly be checked offline is pinned here: the shape of the folded
  expression, one operand per term with the right sign, the filters coming from
  the same two exported lists the typed census uses, and the exact body of the
  one term whose two forms are genuinely a translation rather than a field read —
  the twin of `isAdditionalAmountUncollected`. What CANNOT be checked here is
  that PostgreSQL evaluates it to the same numbers; that needs a database, and
  the operator script does not depend on it either way, because the script reads
  TYPED through Prisma and only `--sql` prints this statement.
*/
/** A ledger that balances, for varying one column at a time. */
const BALANCED_ROW: BookingLedgerIdentityRow = {
  finalPriceCents: 13000,
  changeFeeCents: 0,
  amountCents: 13000,
  refundedAmountCents: 0,
  creditAppliedCents: 0,
  additionalAmountCents: 0,
  additionalPaymentStatus: null,
};

describe("the operator SQL is folded from the same terms (INV-PAY-047, INV-SSOT-001)", () => {
  it("emits one signed operand per term, in order", () => {
    const sql = bookingLedgerResidualSql();
    for (const term of BOOKING_LEDGER_IDENTITY_TERMS) {
      const operand = term.sql.startsWith("CASE") ? `(${term.sql})` : term.sql;
      expect(
        sql,
        `INV-SSOT-001: the residual SQL no longer carries the term "${term.label}".`,
      ).toContain(operand);
    }
    // The first term is positive and unprefixed; every other term carries its
    // own sign, so the operator count is one less than the term count.
    const signs = sql.match(/(^|\s)[+-]\s/g) ?? [];
    expect(signs).toHaveLength(BOOKING_LEDGER_IDENTITY_TERMS.length - 1);
  });

  it("pins the SQL twin of isAdditionalAmountUncollected", () => {
    const askTerm = BOOKING_LEDGER_IDENTITY_TERMS.find(
      (term) => term.label === "the uncollected ask",
    );
    expect(askTerm).toBeDefined();
    expect(
      askTerm?.sql,
      "INV-PAY-047: the SQL twin of `isAdditionalAmountUncollected` changed. Both " +
        "halves are load-bearing: a positive amount, AND a status that is anything " +
        "but SUCCEEDED. `IS DISTINCT FROM` rather than `<>` because a legacy row's " +
        "NULL status counts as uncollected and `<>` would drop it.",
    ).toBe(
      `CASE WHEN p."additionalAmountCents" > 0 AND p."additionalPaymentStatus" IS DISTINCT FROM 'SUCCEEDED' THEN p."additionalAmountCents" ELSE 0 END`,
    );
    // …and the TypeScript half still answers the same two questions, so the pin
    // above is a translation of something live rather than a frozen literal.
    expect(askTerm?.ts({ ...BALANCED_ROW, additionalAmountCents: 7000, additionalPaymentStatus: "PENDING" })).toBe(7000);
    expect(askTerm?.ts({ ...BALANCED_ROW, additionalAmountCents: 7000, additionalPaymentStatus: null })).toBe(7000);
    expect(askTerm?.ts({ ...BALANCED_ROW, additionalAmountCents: 7000, additionalPaymentStatus: "SUCCEEDED" })).toBe(0);
    expect(askTerm?.ts({ ...BALANCED_ROW, additionalAmountCents: 0, additionalPaymentStatus: "PENDING" })).toBe(0);
  });

  it("takes its population filters from the same lists the typed census uses", () => {
    const sql = bookingLedgerCensusSql();
    for (const status of BOOKING_LEDGER_CENSUS_EXCLUDED_BOOKING_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
    for (const status of BOOKING_LEDGER_CENSUS_CAPTURED_PAYMENT_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toContain('b."deletedAt" IS NULL');
    // Report only: no write verb may ever appear in it.
    expect(sql).toMatch(/^SELECT\b/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  });
});
