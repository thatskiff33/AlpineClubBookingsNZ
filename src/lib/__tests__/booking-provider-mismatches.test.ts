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
    action: { type: "RETRY" },
    ...overrides,
  } as BookingInvoiceSyncFault;
}

/** The single mismatch row the card renders for a booking's invoice fault. */
async function renderFault(fault: BookingInvoiceSyncFault) {
  const [mismatch] = await getBookingProviderMismatches("booking-1", {
    deps: makeDeps({ invoiceSyncFault: fault }),
  });

  return mismatch;
}

describe("a failed Xero invoice operation, on the booking (#3001)", () => {
  it("warns on the booking, and links to that booking's own Xero activity", async () => {
    const mismatch = await renderFault(
      syncFault({ reason: "Xero rejected the invoice: account code missing" }),
    );

    expect(mismatch.id).toBe("xero-invoice-sync-failed");
    expect(mismatch.label).toBe("No Xero invoice for this booking");
    // What the booking's own state is, what the club can see in Xero, and what
    // happens next — in that order, and in a treasurer's words.
    expect(mismatch.description).toContain("no invoice recorded against it");
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

describe("the screen never contradicts the guidance printed beside it (#3001)", () => {
  /*
    THE REVIEW BLOCKER THIS PINS. The partly-completed wording says *do not
    repeat the action*, and the retry sentence and the link label used to be
    appended independently of the kind — so an officer read "do not repeat the
    action … you can retry it" under a button labelled Retry, while the guide
    this change calls authoritative says do not repeat. The sentence and the
    label now come from ONE field, decided once in the projection.
  */
  it("offers no Retry for a part-finished invoice, and says what to do instead", async () => {
    const mismatch = await renderFault(
      syncFault({
        kind: "PARTLY_COMPLETED",
        invoiceReachedXero: true,
        invoiceNumber: "INV-0050",
        reason: "Could not settle the applied credit allocation",
        action: { type: "RESOLVE", engineReason: null },
      }),
    );

    expect(mismatch.label).toBe("The Xero invoice completed only in part");
    expect(mismatch.description).toContain("Invoice INV-0050 reached Xero");
    expect(mismatch.description).toContain("Do not repeat the action");
    expect(mismatch.description).toContain("Resolve it from this booking");
    expect(mismatch.description).not.toContain("retry");
    expect(mismatch.linkLabel).toBe("Resolve from Xero activity");
  });

  it("tells an officer to check Xero first when nobody can tell what happened", async () => {
    // A worker killed mid-invoice. Raising another invoice on a guess is the one
    // thing that cannot be undone from here.
    const mismatch = await renderFault(
      syncFault({
        kind: "INVOICE_STATE_UNKNOWN",
        action: { type: "RESOLVE", engineReason: null },
      }),
    );

    expect(mismatch.label).toBe(
      "Check Xero: this booking's invoice was left mid-flight",
    );
    expect(mismatch.description).toContain("cannot tell from here");
    expect(mismatch.description).toContain("BEFORE doing anything else");
    expect(mismatch.description).not.toContain("retry");
    expect(mismatch.linkLabel).toBe("Resolve from Xero activity");
  });

  it("keeps the one retry that legitimately coexists with 'do not raise another'", async () => {
    // The payment leg: the retry records the club's payment against the invoice
    // that already exists, and raises nothing.
    const mismatch = await renderFault(
      syncFault({
        kind: "PAYMENT_NOT_RECORDED",
        invoiceReachedXero: true,
        invoiceNumber: "INV-0043",
        action: { type: "RETRY" },
      }),
    );

    expect(mismatch.description).toContain("Do not raise a second invoice");
    expect(mismatch.description).toContain("You can retry it");
    expect(mismatch.linkLabel).toBe("Retry from Xero activity");
  });

  it("prints the recovery engine's own refusal when the engine is what refuses", async () => {
    const mismatch = await renderFault(
      syncFault({
        kind: "MEMBER_NOT_SENT_INVOICE",
        emailFailureCause: "PROVIDER",
        invoiceReachedXero: true,
        invoiceNumber: "INV-0043",
        action: {
          type: "RESOLVE",
          engineReason:
            "This invoice is partial because it was not emailed, not because its payment failed.",
        },
      }),
    );

    expect(mismatch.linkLabel).toBe("Resolve from Xero activity");
    expect(mismatch.description).toContain("Invoice INV-0043 was raised in Xero");
    expect(mismatch.description).toContain("Do not raise a second invoice");
    expect(mismatch.description).toContain("not because its payment failed");
    expect(mismatch.description).not.toContain("You can retry");
  });
});

describe("an unsent invoice has three causes and three remedies (#3001)", () => {
  /*
    One kind, three unrelated events. The middle one INVERTS the remedy: when the
    booking's "No emails" switch could not be READ, "send it from Xero yourself"
    can email a booking the club deliberately silenced — the conflation this
    codebase calls money-adjacent. The reason text is null on every partial row,
    so without the cause this is the one kind that always withheld its
    distinguishing detail.
  */
  it("says to read the switch first when the switch could not be read", async () => {
    const mismatch = await renderFault(
      syncFault({
        kind: "MEMBER_NOT_SENT_INVOICE",
        emailFailureCause: "NO_EMAILS_UNREADABLE",
        invoiceReachedXero: true,
        invoiceNumber: "INV-0045",
        action: { type: "RESOLVE", engineReason: null },
      }),
    );

    expect(mismatch.description).toContain(
      '"No emails" switch could not be read',
    );
    expect(mismatch.description).toContain("CHECK THAT SWITCH FIRST");
    // The remedy that fits the OTHER two causes, and would be wrong here.
    expect(mismatch.description).not.toContain("Send it from Xero by hand");
  });

  it("names the environment role when that is what stopped the send", async () => {
    const mismatch = await renderFault(
      syncFault({
        kind: "MEMBER_NOT_SENT_INVOICE",
        emailFailureCause: "ROLE_UNCONFIRMED",
        invoiceReachedXero: true,
        action: { type: "RESOLVE", engineReason: null },
      }),
    );

    expect(mismatch.description).toContain("role is not confirmed");
    expect(mismatch.description).toContain("Confirm the role");
  });

  it("says Xero could not send it when the provider call is what failed", async () => {
    const mismatch = await renderFault(
      syncFault({
        kind: "MEMBER_NOT_SENT_INVOICE",
        emailFailureCause: "PROVIDER",
        invoiceReachedXero: true,
        action: { type: "RESOLVE", engineReason: null },
      }),
    );

    expect(mismatch.description).toContain("Xero could not email it");
    expect(mismatch.description).toContain("Send it from Xero by hand");
  });

  it("does not invent a remedy for a row that never recorded a cause", async () => {
    // Every row written before #3001 is this shape.
    const mismatch = await renderFault(
      syncFault({
        kind: "MEMBER_NOT_SENT_INVOICE",
        emailFailureCause: null,
        invoiceReachedXero: true,
        action: { type: "RESOLVE", engineReason: null },
      }),
    );

    expect(mismatch.description).toContain("did not happen");
    expect(mismatch.description).not.toContain("Send it from Xero by hand");
    expect(mismatch.description).not.toContain("CHECK THAT SWITCH FIRST");
  });
});
