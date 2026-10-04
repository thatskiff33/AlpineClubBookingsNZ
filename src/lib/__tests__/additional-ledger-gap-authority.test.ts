import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

// Deliberately diverge the two captured-status authorities in this test. The
// production enum members currently agree, so ordinary examples cannot prove
// which status home the ADDITIONAL transaction reader uses (#3632).
vi.mock("@/lib/payment-transaction-status", async (importOriginal) => ({
  // The module reads the list at import time for Net Collected's capture
  // evidence select (#3372); only the predicate is diverged.
  ...(await importOriginal<typeof import("@/lib/payment-transaction-status")>()),
  isCapturedTransactionStatus: (status: PaymentStatus) =>
    status === PaymentStatus.REFUNDED,
}));

import { summarizeAdditionalLedgerGap } from "@/lib/additional-ledger-gap";

describe("additional ledger gap transaction-status authority", () => {
  it("uses transaction capture evidence when aggregate and transaction rules diverge", () => {
    const booking = (status: PaymentStatus) => ({
      id: `booking-${status}`,
      payment: {
        additionalPaymentStatus: "SUCCEEDED",
        additionalAmountCents: 2_100,
        transactions: [{
          kind: PaymentTransactionKind.ADDITIONAL,
          status,
          amountCents: 2_100,
        }],
      },
    });

    const summary = summarizeAdditionalLedgerGap([
      booking(PaymentStatus.SUCCEEDED),
      booking(PaymentStatus.REFUNDED),
    ]);

    expect(summary.additionalLedgerGapCents).toBe(2_100);
    expect(summary.bookingIds).toEqual(["booking-SUCCEEDED"]);
  });
});
