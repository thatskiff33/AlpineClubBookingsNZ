import { describe, expect, it } from "vitest";
import { getBookingErrorPaymentTargets } from "@/lib/booking-error-payment-targets";

describe("getBookingErrorPaymentTargets", () => {
  it("returns the booking owner's payment target for owner subscription errors", () => {
    expect(
      getBookingErrorPaymentTargets({
        code: "SUBSCRIPTION_REQUIRED",
        invoiceUrl: "https://pay.xero.com/jordan",
        invoiceNumber: "INV-JOR-1",
      })
    ).toEqual([
      {
        name: "Your subscription",
        invoiceUrl: "https://pay.xero.com/jordan",
        invoiceNumber: "INV-JOR-1",
      },
    ]);
  });

  it("returns guest-specific payment targets for guest subscription errors", () => {
    expect(
      getBookingErrorPaymentTargets({
        code: "GUEST_SUBSCRIPTION_REQUIRED",
        unpaidMemberInvoices: [
          {
            name: "Rebecca Hartley-Smith",
            invoiceUrl: "https://pay.xero.com/rebecca",
            invoiceNumber: "INV-REB-1",
          },
        ],
      })
    ).toEqual([
      {
        name: "Rebecca Hartley-Smith",
        invoiceUrl: "https://pay.xero.com/rebecca",
        invoiceNumber: "INV-REB-1",
      },
    ]);
  });

  it("ignores guest entries that do not include any payment information", () => {
    expect(
      getBookingErrorPaymentTargets({
        code: "GUEST_SUBSCRIPTION_REQUIRED",
        unpaidMemberInvoices: [
          {
            name: "Rebecca Hartley-Smith",
            invoiceUrl: null,
            invoiceNumber: null,
          },
        ],
      })
    ).toEqual([]);
  });
});
