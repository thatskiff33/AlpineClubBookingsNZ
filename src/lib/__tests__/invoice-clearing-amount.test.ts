/**
 * `INV-PAY-017` (#3535): the one sizing of a note that clears an unpaid
 * booking's invoicing. The release, the cancel path, the repair tool and the
 * hold-clearing audit all call it, so these cases are the rule itself.
 */
import { describe, expect, it } from "vitest";
import { unpaidInvoiceClearingAmountCents } from "@/lib/invoice-clearing-amount";

describe("unpaidInvoiceClearingAmountCents (INV-PAY-017)", () => {
  it("clears the full price plus any change fee", () => {
    expect(
      unpaidInvoiceClearingAmountCents({
        finalPriceCents: 15000,
        changeFeeCents: 1000,
        xeroAllocatedAppliedCreditCents: 0,
      }),
    ).toBe(16000);
  });

  it("subtracts only applied credit already allocated to the invoice in Xero", () => {
    expect(
      unpaidInvoiceClearingAmountCents({
        finalPriceCents: 15000,
        changeFeeCents: 0,
        xeroAllocatedAppliedCreditCents: 5000,
      }),
    ).toBe(10000);
  });

  it("floors at zero, and never adds a negative allocation back", () => {
    expect(
      unpaidInvoiceClearingAmountCents({
        finalPriceCents: 15000,
        changeFeeCents: 0,
        xeroAllocatedAppliedCreditCents: 20000,
      }),
    ).toBe(0);
    expect(
      unpaidInvoiceClearingAmountCents({
        finalPriceCents: 15000,
        changeFeeCents: 0,
        xeroAllocatedAppliedCreditCents: -500,
      }),
    ).toBe(15000);
  });
});
