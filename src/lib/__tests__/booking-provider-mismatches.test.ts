import { describe, expect, it, vi } from "vitest";
import type { BookingInvoiceSyncFault } from "@/lib/booking-invoice-sync-status";
import type { BookingProviderMismatchDependencies } from "@/lib/booking-provider-mismatches";
import {
  getBookingFinancialReviewWarnings,
  getBookingProviderMismatches,
} from "@/lib/booking-provider-mismatches";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

// #3033: the financial-review warning is a separate export with its own read.
// Mocked here so this suite stays about the provider mismatches it was written
// for, and driven directly in the block at the end of the file.
const hasOpenFinancialReview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/booking-financial-review-visibility", () => ({
  bookingHasOpenFinancialReview: hasOpenFinancialReview,
}));

const baseModules = {
  xeroIntegration: true,
  waitlist: true,
} as Awaited<ReturnType<BookingProviderMismatchDependencies["loadEffectiveModuleFlags"]>>;

function bookingRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    status: "PAID",
    deletedAt: null,
    waitlistOfferedAt: null,
    // #2258: switch off by default in fixtures.
    noEmails: false,
    member: { email: "member@example.org" },
    payment: {
      id: "payment-1",
      source: "STRIPE",
      refundedAmountCents: 0,
      xeroInvoiceId: null,
      xeroRefundCreditNoteId: null,
    },
    ...overrides,
  };
}

function makeDeps(overrides: {
  booking?: Record<string, unknown> | null;
  succeededInvoiceOps?: number;
  modules?: Record<string, unknown>;
  needsOperatorAction?: boolean;
  /**
   * #3001: the booking's current Xero invoice-create fault, injected rather than
   * queried. Defaults to "nothing wrong", so every test written before #3001
   * keeps asserting exactly what it always did.
   */
  invoiceSyncFault?: BookingInvoiceSyncFault | null;
}) {
  const booking =
    overrides.booking === null ? null : bookingRecord(overrides.booking ?? {});
  const deliveries = new Map<
    string,
    { needsOperatorAction: boolean }
  >();
  if (booking) {
    deliveries.set(booking.id as string, {
      needsOperatorAction: overrides.needsOperatorAction ?? false,
    });
  }

  return {
    db: {
      booking: { findUnique: vi.fn().mockResolvedValue(booking) },
      xeroSyncOperation: {
        count: vi.fn().mockResolvedValue(overrides.succeededInvoiceOps ?? 1),
      },
    },
    loadEffectiveModuleFlags: vi
      .fn()
      .mockResolvedValue({ ...baseModules, ...overrides.modules }),
    getWaitlistOfferEmailDeliveries: vi.fn().mockResolvedValue(deliveries),
    getBookingInvoiceSyncFault: vi
      .fn()
      .mockResolvedValue(overrides.invoiceSyncFault ?? null),
  } as unknown as BookingProviderMismatchDependencies;
}

describe("getBookingProviderMismatches", () => {
  it("flags a paid booking with no succeeded Xero invoice operation", async () => {
    const deps = makeDeps({ succeededInvoiceOps: 0 });

    const mismatches = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatches.map((mismatch) => mismatch.id)).toEqual([
      "xero-invoice-pending",
    ]);
    expect(mismatches[0].href).toBe("/admin/xero/records/Payment/payment-1");
  });

  it("stays quiet for a paid booking with completed invoice evidence", async () => {
    const deps = makeDeps({ succeededInvoiceOps: 1 });

    const mismatches = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatches).toEqual([]);
  });

  it("flags a recorded Stripe refund with no Xero credit note", async () => {
    const deps = makeDeps({
      booking: {
        status: "CANCELLED",
        payment: {
          id: "payment-1",
          source: "STRIPE",
          refundedAmountCents: 4500,
          xeroInvoiceId: "inv-1",
          xeroRefundCreditNoteId: null,
        },
      },
    });

    const mismatches = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatches.map((mismatch) => mismatch.id)).toEqual([
      "xero-credit-note-pending",
    ]);
  });

  it("does not flag a refund whose credit note exists", async () => {
    const deps = makeDeps({
      booking: {
        status: "CANCELLED",
        payment: {
          id: "payment-1",
          source: "STRIPE",
          refundedAmountCents: 4500,
          xeroInvoiceId: "inv-1",
          xeroRefundCreditNoteId: "cn-1",
        },
      },
    });

    const mismatches = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatches).toEqual([]);
  });

  it("flags an undelivered waitlist offer email needing operator action", async () => {
    const deps = makeDeps({
      booking: {
        status: "WAITLIST_OFFERED",
        waitlistOfferedAt: new Date("2026-07-01T00:00:00.000Z"),
        payment: null,
      },
      needsOperatorAction: true,
    });

    const mismatches = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatches.map((mismatch) => mismatch.id)).toEqual([
      "waitlist-offer-email-failed",
    ]);
    expect(mismatches[0].href).toBe("/admin/waitlist");
  });

  it("stays quiet for a waitlist offer whose email was delivered", async () => {
    const deps = makeDeps({
      booking: {
        status: "WAITLIST_OFFERED",
        waitlistOfferedAt: new Date("2026-07-01T00:00:00.000Z"),
        payment: null,
      },
      needsOperatorAction: false,
    });

    const mismatches = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatches).toEqual([]);
  });

  it("suppresses Xero mismatches when the module is disabled", async () => {
    const deps = makeDeps({
      succeededInvoiceOps: 0,
      modules: { xeroIntegration: false },
    });

    const mismatches = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatches).toEqual([]);
  });

  it("returns nothing for deleted or missing bookings", async () => {
    const deletedDeps = makeDeps({
      booking: { deletedAt: new Date("2026-07-01T00:00:00.000Z") },
      succeededInvoiceOps: 0,
    });
    const missingDeps = makeDeps({ booking: null });

    expect(
      await getBookingProviderMismatches("booking-1", { deps: deletedDeps }),
    ).toEqual([]);
    expect(
      await getBookingProviderMismatches("booking-1", { deps: missingDeps }),
    ).toEqual([]);
  });
});

/**
 * #3033 (epic #2797) — the admin booking-tools warning for money held for review.
 *
 * It reuses the provider-mismatch ROW SHAPE and is deliberately NOT in the
 * provider-mismatch list: that list renders under a heading saying "Provider
 * state out of step", and a financial review is the opposite situation — local
 * state is exactly right and it is the club that owes a decision.
 *
 * MUTATION PROOF. Push the row into `getBookingProviderMismatches` and "is not a
 * provider mismatch" fails. Return the row unconditionally and "says nothing
 * about a booking with no open review" fails. Put an amount in the description
 * and "states no amount, because the amount is the question" fails.
 */
describe("the money-waiting-for-review warning (#3033)", () => {
  it("says nothing about a booking with no open review", async () => {
    hasOpenFinancialReview.mockResolvedValue(false);

    await expect(getBookingFinancialReviewWarnings("booking-1")).resolves.toEqual(
      [],
    );
  });

  it("offers one row with an actionable path to the queue", async () => {
    hasOpenFinancialReview.mockResolvedValue(true);

    const rows = await getBookingFinancialReviewWarnings("booking-1");

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("financial-review-open");
    expect(rows[0].href).toBe("/admin/payments");
    expect(rows[0].linkLabel).toBeTruthy();
  });

  it("states no amount, because the amount is the question", async () => {
    hasOpenFinancialReview.mockResolvedValue(true);

    const [row] = await getBookingFinancialReviewWarnings("booking-1");

    expect(`${row.label} ${row.description}`).not.toContain("$");
    expect(row.description).toMatch(/no amount has been assumed/i);
  });

  it("is not a provider mismatch, and never appears in that list", async () => {
    // The heading over that list would misdescribe it to the one person able to
    // resolve it.
    hasOpenFinancialReview.mockResolvedValue(true);

    const mismatches = await getBookingProviderMismatches("booking-1", {
      deps: makeDeps({ succeededInvoiceOps: 1 }),
    });

    expect(mismatches.map((row) => row.id)).not.toContain(
      "financial-review-open",
    );
  });
});

/**
 * #3001: the failed booking-invoice operation, said on the booking that depends
 * on it.
 *
 * The projection itself is tested in `booking-invoice-sync-status.test.ts`.
 * What these assert is the part an officer actually meets: that a real failure
 * reaches the card, that it does not arrive beside a vaguer row contradicting
 * it, and that a failure the recovery engine refuses is never dressed as a
 * Retry.
 */
function syncFault(
  overrides: Partial<BookingInvoiceSyncFault> = {},
): BookingInvoiceSyncFault {
  return {
    kind: "INVOICE_NOT_RAISED",
    operationId: "op-1",
    invoiceReachedXero: false,
    invoiceNumber: null,
    reason: null,
    retrySupported: true,
    retryBlockedReason: null,
    ...overrides,
  };
}

describe("a failed Xero invoice operation, on the booking (#3001)", () => {
  it("warns on the booking, and links to that booking's own Xero activity", async () => {
    const deps = makeDeps({
      invoiceSyncFault: syncFault({
        reason: "Xero rejected the invoice: account code missing",
      }),
    });

    const [mismatch] = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatch.id).toBe("xero-invoice-sync-failed");
    expect(mismatch.label).toBe("No Xero invoice for this booking");
    // What the booking's own state is, what the club can see in Xero, and what
    // happens next — in that order, and in a treasurer's words.
    expect(mismatch.description).toContain("the club's accounts hold no invoice");
    expect(mismatch.description).toContain("it has not been cancelled");
    expect(mismatch.description).toContain("account code missing");
    expect(mismatch.description).toContain("You can retry it");
    expect(mismatch.href).toBe("/admin/xero/records/Booking/booking-1");
    expect(mismatch.linkLabel).toBe("Retry from Xero activity");
  });

  it("replaces the vaguer 'invoice pending' row rather than sitting beside it", async () => {
    // Both would otherwise fire on a PAID booking with no succeeded operation,
    // and the older row says the outbox "normally catches up on its own" — true
    // of a booking still waiting, false of one already failed.
    const deps = makeDeps({
      succeededInvoiceOps: 0,
      invoiceSyncFault: syncFault(),
    });

    const mismatches = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatches.map((mismatch) => mismatch.id)).toEqual([
      "xero-invoice-sync-failed",
    ]);
  });

  it("offers Resolve, not Retry, when the recovery engine refuses the operation", async () => {
    const deps = makeDeps({
      invoiceSyncFault: syncFault({
        kind: "MEMBER_NOT_SENT_INVOICE",
        invoiceReachedXero: true,
        invoiceNumber: "INV-0043",
        retrySupported: false,
        retryBlockedReason:
          "This invoice is partial because it was not emailed, not because its payment failed.",
      }),
    });

    const [mismatch] = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatch.linkLabel).toBe("Resolve from Xero activity");
    // The standing guidance for this class, said plainly on the surface that
    // would otherwise invite a duplicate.
    expect(mismatch.description).toContain("Invoice INV-0043 was raised in Xero");
    expect(mismatch.description).toContain("Do not raise a second invoice");
    expect(mismatch.description).toContain("not because its payment failed");
    expect(mismatch.description).not.toContain("You can retry");
  });

  it("says nothing when the club does not use the Xero integration", async () => {
    const deps = makeDeps({
      modules: { xeroIntegration: false },
      invoiceSyncFault: syncFault(),
    });

    await expect(
      getBookingProviderMismatches("booking-1", { deps }),
    ).resolves.toEqual([]);
    expect(deps.getBookingInvoiceSyncFault).not.toHaveBeenCalled();
  });

  it("says nothing about a deleted booking", async () => {
    const deps = makeDeps({
      booking: { deletedAt: new Date("2026-06-01T00:00:00.000Z") },
      invoiceSyncFault: syncFault(),
    });

    await expect(
      getBookingProviderMismatches("booking-1", { deps }),
    ).resolves.toEqual([]);
  });
});

describe("what a provider failure is allowed to say out loud (#3001)", () => {
  it("never puts a stored payload error value in front of a person", async () => {
    /*
      `INV-INT-005`. The completion payload's `paymentError` and
      `invoiceEmailError` have been through `sanitizeForJson` — a serialisation
      guard, NOT the operator-text redactor. The only redacted field on the row
      is `lastErrorMessage`, which `failXeroSyncOperation` puts through
      `redactSensitiveText` on the way in, and it is the only text the projection
      hands over. This asserts the consequence at the surface: whatever a
      provider stuffed into the payload, it is not what an officer reads.
    */
    const deps = makeDeps({
      invoiceSyncFault: syncFault({
        kind: "PAYMENT_NOT_RECORDED",
        invoiceReachedXero: true,
        invoiceNumber: "INV-0044",
        // The projection sets this to null for a partial row, and the row's own
        // payload — secrets and all — is never read for its values at all.
        reason: null,
        retrySupported: true,
      }),
    });

    const [mismatch] = await getBookingProviderMismatches("booking-1", { deps });
    const rendered = `${mismatch.label} ${mismatch.description} ${mismatch.linkLabel}`;

    for (const secret of [
      "Bearer",
      "access_token",
      "client_secret",
      "tenantId",
      "member@example.org",
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it("shows the redacted operator message, which is the one text that may be shown", async () => {
    const deps = makeDeps({
      invoiceSyncFault: syncFault({
        reason: "Xero rejected the invoice: account code missing",
      }),
    });

    const [mismatch] = await getBookingProviderMismatches("booking-1", { deps });

    expect(mismatch.description).toContain("account code missing");
  });
});
