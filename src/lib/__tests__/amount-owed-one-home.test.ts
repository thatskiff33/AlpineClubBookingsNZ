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
 * WHAT THIS CANNOT SEE: an amount spelled another way (a sum in a different
 * order, a helper of its own). It reads text over every non-test file under
 * `src/`, by walk, for the shape the pay steps all used.
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
];
const BARE_PRICE_LESS_CREDIT =
  /finalPriceCents\s*-\s*(?:\([^)]*\)\s*)?\(?\s*(?:await\s+deriveBookingAppliedCreditCents|appliedCreditCents|creditAppliedCents|settlementAmountCents)/;

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

  it("no source file subtracts credit from the bare price any more", () => {
    const offenders = sourceFiles(path.join(REPO, "src")).filter((file) =>
      BARE_PRICE_LESS_CREDIT.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });
});
