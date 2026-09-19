/**
 * `INV-PAY-101` (#3529): the three ways a booking's money goes back, as the
 * ONE home for the words Xero reads. The owner's exact wording is pinned here
 * verbatim, and a census over `src/lib` holds that nothing else spells it — a
 * second copy is how the card wording ended up on a bank-transfer hand-back.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PaymentSource } from "@prisma/client";
import {
  buildRefundDocumentDescription,
  buildRefundDocumentReference,
  buildRefundPaymentReference,
  defaultRefundMethodForPaymentSource,
  describeRefundMethod,
  parseRefundMethod,
  REFUND_METHOD_WORDING,
  REFUND_METHODS,
  refundMethodForSettlementMethod,
  refundSettlementMappingKey,
} from "@/lib/xero-refund-method";

describe("the owner's three wordings (INV-PAY-101)", () => {
  it("are exactly these, and there are exactly three", () => {
    expect(REFUND_METHODS).toEqual(["card", "internet-banking", "account-credit"]);
    expect(describeRefundMethod("card")).toBe("Refund against original credit card");
    expect(describeRefundMethod("internet-banking")).toBe(
      "Refund requested via internet banking",
    );
    expect(describeRefundMethod("account-credit")).toBe("Account Credit");
  });

  it("head every document description and reference", () => {
    expect(
      buildRefundDocumentDescription({
        method: "card",
        bookingId: "cmabcdefgh123",
        stay: { checkIn: "2026-08-16", checkOut: "2026-08-18" },
      }),
    ).toBe("Refund against original credit card - Booking cmabcdef (2026-08-16 - 2026-08-18)");
    expect(
      buildRefundDocumentDescription({
        method: "account-credit",
        bookingId: "cmabcdefgh123",
        modificationId: "cmmodific123",
        stay: { checkIn: "2026-08-16", checkOut: "2026-08-18" },
      }),
    ).toBe("Account Credit - Booking cmabcdef - booking change cmmodifi");
    expect(
      buildRefundDocumentDescription({ method: "internet-banking", bookingId: "cmabcdefgh123" }),
    ).toBe("Refund requested via internet banking - Booking cmabcdef");
    expect(buildRefundDocumentReference({ method: "internet-banking", bookingId: "cmabcdefgh123" })).toBe(
      "Refund requested via internet banking - Booking cmabcdef",
    );
    expect(
      buildRefundPaymentReference({ method: "card", clubName: "Test Club", paymentId: "cmpaymentx1" }),
    ).toBe("Refund against original credit card - Test Club payment cmpaymen");
  });
});

describe("where the method comes from when nobody said", () => {
  it("reads a Stripe payment as a card refund and anything else as a bank transfer", () => {
    expect(defaultRefundMethodForPaymentSource(PaymentSource.STRIPE)).toBe("card");
    expect(defaultRefundMethodForPaymentSource(PaymentSource.INTERNET_BANKING)).toBe(
      "internet-banking",
    );
    expect(defaultRefundMethodForPaymentSource(null)).toBe("card");
  });

  it("reads the member's two-way settlement choice as credit kept or card refunded", () => {
    expect(refundMethodForSettlementMethod("credit")).toBe("account-credit");
    expect(refundMethodForSettlementMethod("card")).toBe("card");
    expect(refundMethodForSettlementMethod(null)).toBe("card");
  });

  it("accepts only the three from a stored payload", () => {
    expect(parseRefundMethod("internet-banking")).toBe("internet-banking");
    expect(parseRefundMethod("bank")).toBeNull();
    expect(parseRefundMethod(undefined)).toBeNull();
    expect(parseRefundMethod(3)).toBeNull();
  });

  it("settles a card refund from the Stripe account and a bank transfer from the club's refund account", () => {
    expect(refundSettlementMappingKey("card")).toBe("stripeBankAccount");
    expect(refundSettlementMappingKey("internet-banking")).toBe("bankTransferRefundAccount");
  });
});

/**
 * INV-SSOT: nothing under `src/lib` — where every Xero document is built —
 * other than the module spells a wording. A member-facing page may head a
 * section "Account Credit" in its own right; what must not exist is a second
 * copy on the path to Xero. The walk is by hand rather than through the test's
 * own import graph because the defect this guards against is a copy that
 * imports nothing.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("nobody else spells the wording (INV-SSOT)", () => {
  it("finds each of the three strings in exactly one module under src/lib", () => {
    const root = join(process.cwd(), "src", "lib");
    const files = walk(root);
    for (const wording of Object.values(REFUND_METHOD_WORDING)) {
      const homes = files
        .filter((file) => readFileSync(file, "utf8").includes(`"${wording}"`))
        .map((file) => relative(root, file));
      expect(homes, `"${wording}" is spelled outside its home`).toEqual([
        "xero-refund-method.ts",
      ]);
    }
  });
});
