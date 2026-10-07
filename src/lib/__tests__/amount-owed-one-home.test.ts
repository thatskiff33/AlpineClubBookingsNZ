import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { bookingAmountOwedCents, bookingWorthCents } from "@/lib/booking-payment-state";

/**
 * #3750 (owner decision, 7 Oct 2026, "Add fee to amount owed"): what an unpaid
 * booking owes is its price PLUS the change fee recorded on its payment, less
 * applied credit — and every pay step reads that from ONE home,
 * `bookingAmountOwedCents` / `bookingWorthCents`. A surface that still
 * subtracted credit from the bare price would ask for less than the booking
 * owes, and a settle that compared against the bare price would refuse the
 * payment that did collect the fee.
 *
 * Two shapes, read as text with comments stripped (#3955 review F6):
 *  - over every non-test file under `src/`, by walk: a final price less
 *    anything named for credit, under ANY name and either case
 *    (`newFinalPriceCents - clamp.appliedCreditCents`,
 *    `booking.finalPriceCents -\n (await deriveBookingAppliedCreditCents(…))`);
 *  - over the pay steps: an `amountCents` set to a bare final price — an
 *    intent, a charge or a payment row sized without the recorded fee.
 *
 * WHAT THIS CANNOT SEE: an amount spelled another way (a sum in a different
 * order, a helper of its own, a variable that holds the bare price).
 */

const REPO = path.resolve(__dirname, "..", "..", "..");
const PAY_STEPS = [
  "src/app/api/payments/create-payment-intent/route.ts",
  "src/app/api/payments/switch-to-internet-banking/route.ts",
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-payment.ts",
  "src/app/api/bookings/[id]/confirm-payment/route.ts",
  "src/lib/stripe-webhook-service.ts",
  "src/lib/payment-reconciliation.ts",
  "src/lib/manual-booking-payment-state.ts",
  // #3955 review F1-F3: the edit lifecycle's credit clamp and $0 decision, the
  // date-only edit's, the payment link's intent, the saved-card charge and the
  // organiser's group total.
  "src/lib/booking-modify-settlement.ts",
  "src/lib/booking-date-modification-service.ts",
  "src/lib/payment-link-intent.ts",
  "src/lib/cron-confirm-pending.ts",
  "src/lib/group-settlement-invoice-binding.ts",
];
// A final price, then a minus, then — within the same expression — anything
// named for credit. `[^;,{}]` keeps it inside one expression across lines.
const BARE_PRICE_LESS_CREDIT = /[Ff]inalPriceCents\s*-\s*[^;,{}]{0,120}?[Cc]redit/;
// An intent, charge or payment amount that is a bare final price, in a pay step.
const BARE_PRICE_AMOUNT = /\bamountCents:\s*[\w.?!]*[Ff]inalPriceCents\b(?!\s*[-+])/;

/**
 * The member's edit PREVIEW, not a pay step: each shows what an edit's quote
 * leaves to pay against the credit an election would use, from figures the
 * quote returns (its own fee on its own row). Nothing is charged from them —
 * the pay step reads the one home — and a fee recorded on an unpaid booking's
 * payment comes from an officer's finished-stay correction, on a stay no
 * member can edit.
 */
const EDIT_PREVIEW_EXCEPTIONS: Readonly<Record<string, true>> = {
  "src/components/edit-booking/price-summary-card.tsx": true,
  "src/components/edit-booking-panel.tsx": true,
};

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(path.relative(REPO, full).split(path.sep).join("/"));
    }
  }
  return found;
}
const read = (file: string) => stripComments(fs.readFileSync(path.join(REPO, file), "utf8"));

describe("the amount an unpaid booking owes has one home (#3750)", () => {
  it("adds the recorded change fee to the price, then takes off applied credit", () => {
    expect(bookingWorthCents({ finalPriceCents: 10_000, changeFeeCents: 2_500 })).toBe(12_500);
    expect(bookingWorthCents({ finalPriceCents: 10_000, changeFeeCents: null })).toBe(10_000);
    expect(
      bookingAmountOwedCents({ finalPriceCents: 10_000, changeFeeCents: 2_500, appliedCreditCents: 3_000 }),
    ).toBe(9_500);
  });

  it("every pay step reads it there", () => {
    for (const file of PAY_STEPS) {
      expect(read(file), file).toMatch(/\bbooking(?:AmountOwed|Worth)Cents\(/);
    }
  });

  it("no pay step sizes an amount at the bare price", () => {
    const offenders = PAY_STEPS.filter((file) => BARE_PRICE_AMOUNT.test(read(file))).map(
      (file) => `${file}: ${read(file).match(BARE_PRICE_AMOUNT)?.[0]}`,
    );
    expect(offenders, "INV-PAY-119: size it through bookingAmountOwedCents / bookingWorthCents").toEqual([]);
  });

  it("no source file subtracts credit from the bare price any more", () => {
    const offenders = sourceFiles(path.join(REPO, "src"))
      .filter((file) => !(file in EDIT_PREVIEW_EXCEPTIONS))
      .filter((file) => BARE_PRICE_LESS_CREDIT.test(read(file)))
      .map((file) => `${file}: ${read(file).match(BARE_PRICE_LESS_CREDIT)?.[0].replace(/\s+/g, " ")}`);
    expect(offenders, "INV-PAY-119: read it through bookingAmountOwedCents").toEqual([]);
  });
});
