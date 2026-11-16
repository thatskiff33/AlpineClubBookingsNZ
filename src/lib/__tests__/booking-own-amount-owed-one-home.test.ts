import fs from "node:fs";
import path from "node:path";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { productionSourceFiles } from "@/lib/__tests__/support/prisma-delegate-read-scan";
import { isBookingOwnAmountOwed, PAYMENT_OWED_BOOKING_STATUSES } from "@/lib/booking-status";

/**
 * Whether a booking's own price is still owed has one home,
 * `isBookingOwnAmountOwed` (`INV-PAY-119`, `INV-SSOT`). The dashboard's
 * Payment Owed card and the booking page's pay, credit, change-fee and
 * internet-banking cards each used to restate "payment-owed status AND payment
 * not succeeded" by hand, so a change to either half could reach one surface
 * and miss another, and the two would quote different amounts owed.
 *
 * WHAT THE CENSUS CANNOT SEE: the same question asked another way — a status
 * list of its own, or the payment check held in a variable first.
 */

const REPO = path.resolve(__dirname, "..", "..", "..");
const HOME = "src/lib/booking-status.ts";

// The payment-owed status test and a SUCCEEDED check in one expression, in
// either order. The window stops at a statement end so two separate
// statements in one function are not read as one condition.
const INLINE_OWN_AMOUNT_OWED = [
  /isPaymentOwedBookingStatus\s*\([^;{}]*?SUCCEEDED/g,
  /SUCCEEDED[^;{}]*?isPaymentOwedBookingStatus\s*\(/g,
];

describe("isBookingOwnAmountOwed", () => {
  it("owes the price only in a payment-owed status with no succeeded payment", () => {
    const owedStatuses = new Set<string>(PAYMENT_OWED_BOOKING_STATUSES);
    for (const status of Object.values(BookingStatus)) {
      expect(isBookingOwnAmountOwed({ status, payment: null }), `${status}, no payment`).toBe(
        owedStatuses.has(status),
      );
      for (const paymentStatus of Object.values(PaymentStatus)) {
        expect(
          isBookingOwnAmountOwed({ status, payment: { status: paymentStatus } }),
          `${status}, payment ${paymentStatus}`,
        ).toBe(owedStatuses.has(status) && paymentStatus !== PaymentStatus.SUCCEEDED);
      }
    }
  });
});

describe("the own-amount-owed condition is not restated by hand", () => {
  it("no production file outside its home pairs the payment-owed status with a SUCCEEDED check", () => {
    const offenders = productionSourceFiles(REPO)
      .filter((file) => file !== HOME)
      .flatMap((file) => {
        const text = stripComments(fs.readFileSync(path.join(REPO, file), "utf8"));
        return INLINE_OWN_AMOUNT_OWED.flatMap((pattern) =>
          [...text.matchAll(pattern)].map((match) => `${file}: ${match[0].replace(/\s+/g, " ")}`),
        );
      });
    expect(offenders, "call isBookingOwnAmountOwed from @/lib/booking-status instead").toEqual([]);
  });

  it("the census recognises the inline form it forbids", () => {
    const inline = `const owed =\n  isPaymentOwedBookingStatus(booking.status) &&\n  booking.payment?.status !== "SUCCEEDED";`;
    const reversed = `if (payment.status !== PaymentStatus.SUCCEEDED && isPaymentOwedBookingStatus(status)) {`;
    const separate = `const a = isPaymentOwedBookingStatus(status);\nconst b = payment.status === "SUCCEEDED";`;
    const hits = (text: string) =>
      INLINE_OWN_AMOUNT_OWED.some((pattern) => [...text.matchAll(pattern)].length > 0);
    expect(hits(inline)).toBe(true);
    expect(hits(reversed)).toBe(true);
    expect(hits(separate)).toBe(false);
  });
});
