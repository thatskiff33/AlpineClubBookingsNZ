import { describe, expect, it, vi } from "vitest";
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
