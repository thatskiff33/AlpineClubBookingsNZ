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
  modificationNoteWording,
  parseRefundMethod,
  readModificationNoteWording,
  REFUND_METHOD_WORDING,
  REFUND_METHODS,
  refundMethodForSettlementMethod,
  refundSettlementMappingKey,
  settledModificationNoteWording,
  UNPAID_INVOICE_CLEARING_WORDING,
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

/**
 * #3535 (`INV-PAY-017`): the note that closes an invoice nobody paid is not a
 * refund, so it is not a fourth method — it names why the invoice was cleared.
 */
describe("the unpaid-invoice clearing wording (INV-PAY-017)", () => {
  it("says the invoice was cleared because the booking was not paid, and claims no refund", () => {
    expect(UNPAID_INVOICE_CLEARING_WORDING).toBe("Invoice cleared - booking not paid");
    expect(UNPAID_INVOICE_CLEARING_WORDING).not.toMatch(/refund/i);
    expect(REFUND_METHODS).not.toContain("unpaid-invoice-clearing");
    expect(
      buildRefundDocumentDescription({ method: "unpaid-invoice-clearing", bookingId: "cmabcdefgh123" }),
    ).toBe("Invoice cleared - booking not paid - Booking cmabcdef");
    expect(
      buildRefundDocumentReference({ method: "unpaid-invoice-clearing", bookingId: "cmabcdefgh123" }),
    ).toBe("Invoice cleared - booking not paid - Booking cmabcdef");
  });

  it("is what a modification note says when told it clears an unpaid invoice, and card when told nothing", () => {
    expect(modificationNoteWording({ clearsUnpaidInvoice: true })).toBe("unpaid-invoice-clearing");
    expect(modificationNoteWording({ refundMethod: "internet-banking" })).toBe("internet-banking");
    expect(modificationNoteWording({})).toBe("card");
  });

  it("is read from any source by one rule: only a literal true clears, and then no method rides along", () => {
    expect(readModificationNoteWording({ clearsUnpaidInvoice: true, refundMethod: "card" })).toEqual({
      clearsUnpaidInvoice: true,
    });
    // A stored string is not the flag; an unknown method is not a method.
    expect(readModificationNoteWording({ clearsUnpaidInvoice: "true", refundMethod: "bank" })).toEqual({});
    expect(readModificationNoteWording({ refundMethod: "account-credit" })).toEqual({
      refundMethod: "account-credit",
    });
    expect(readModificationNoteWording(null)).toEqual({});
    // The default is applied in one place, for what a built note records.
    expect(settledModificationNoteWording({})).toEqual({ refundMethod: "card" });
    expect(settledModificationNoteWording({ clearsUnpaidInvoice: true })).toEqual({
      clearsUnpaidInvoice: true,
    });
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

  it("calls 'money back' a bank transfer when Stripe refunded nothing, and a card refund when it did", () => {
    expect(refundMethodForSettlementMethod("card", false)).toBe("internet-banking");
    expect(refundMethodForSettlementMethod(null, false)).toBe("internet-banking");
    expect(refundMethodForSettlementMethod("card", true)).toBe("card");
    expect(refundMethodForSettlementMethod("credit", false)).toBe("account-credit");
    // Unknown is what every pre-#3529 row was: a card refund.
    expect(refundMethodForSettlementMethod("card", undefined)).toBe("card");
    expect(refundMethodForSettlementMethod("card", null)).toBe("card");
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
  it("finds each wording in exactly one module under src/lib", () => {
    const root = join(process.cwd(), "src", "lib");
    const files = walk(root);
    // The three refund methods, and the unpaid-invoice clearing note's (#3535).
    for (const wording of [
      ...Object.values(REFUND_METHOD_WORDING),
      UNPAID_INVOICE_CLEARING_WORDING,
    ]) {
      // Any quoting counts: no lint rule pins double quotes, so a copy in
      // single quotes or a template literal is still a copy.
      const spelled = new RegExp(`['"\`]${wording}['"\`]`);
      const homes = files
        .filter((file) => spelled.test(readFileSync(file, "utf8")))
        .map((file) => relative(root, file));
      expect(homes, `"${wording}" is spelled outside its home`).toEqual([
        "xero-refund-method.ts",
      ]);
    }
  });
});
