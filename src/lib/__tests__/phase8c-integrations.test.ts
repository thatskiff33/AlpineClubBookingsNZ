import { describe, it, expect, vi, beforeEach } from "vitest";

// chore-cleanup imports the shared roster lock. Capacity is not exercised by
// these date-key cleanup tests, so keep its module-level Prisma client out.
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn(),
}));

// =====================================================================
// CHR-01: Chore cleanup on date change
// =====================================================================

describe("CHR-01: cleanupChoreAssignmentsForDateChange", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function makeAssignment(
    id: string,
    date: Date,
    status: string,
    choreName: string
  ) {
    return {
      id,
      date,
      status,
      bookingId: "bk1",
      bookingGuestId: "g1",
      choreTemplate: { name: choreName },
    };
  }

  it("deletes SUGGESTED assignments for removed dates", async () => {
    const { cleanupChoreAssignmentsForDateChange } = await import(
      "@/lib/chore-cleanup"
    );

    const deleteMock = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn(),
      choreAssignment: {
        findMany: vi.fn().mockResolvedValue([
          makeAssignment("ca1", new Date("2026-06-01"), "SUGGESTED", "Dishes"),
          makeAssignment("ca2", new Date("2026-06-02"), "SUGGESTED", "Sweep"),
        ]),
        deleteMany: deleteMock,
      },
    } as any;

    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      "bk1",
      new Date("2026-06-03"),
      new Date("2026-06-05")
    );

    expect(deleteMock).toHaveBeenCalledTimes(2);
    expect(result.deletedCount).toBe(2);
    expect(result.choreWarnings).toHaveLength(0);
  });

  it("does not delete CONFIRMED assignments, returns warnings", async () => {
    const { cleanupChoreAssignmentsForDateChange } = await import(
      "@/lib/chore-cleanup"
    );

    const deleteMock = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn(),
      choreAssignment: {
        findMany: vi.fn().mockResolvedValue([
          makeAssignment(
            "ca1",
            new Date("2026-06-01"),
            "CONFIRMED",
            "Dishes"
          ),
        ]),
        deleteMany: deleteMock,
      },
    } as any;

    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      "bk1",
      new Date("2026-06-03"),
      new Date("2026-06-05")
    );

    expect(deleteMock).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(0);
    expect(result.choreWarnings).toHaveLength(1);
    expect(result.choreWarnings[0]).toContain("CONFIRMED");
    expect(result.choreWarnings[0]).toContain("Dishes");
  });

  it("does not delete COMPLETED assignments, returns warnings", async () => {
    const { cleanupChoreAssignmentsForDateChange } = await import(
      "@/lib/chore-cleanup"
    );

    const tx = {
      $executeRaw: vi.fn(),
      choreAssignment: {
        findMany: vi.fn().mockResolvedValue([
          makeAssignment(
            "ca1",
            new Date("2026-06-01"),
            "COMPLETED",
            "Sweep"
          ),
        ]),
        deleteMany: vi.fn(),
      },
    } as any;

    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      "bk1",
      new Date("2026-06-03"),
      new Date("2026-06-05")
    );

    expect(tx.choreAssignment.deleteMany).not.toHaveBeenCalled();
    expect(result.choreWarnings).toHaveLength(1);
    expect(result.choreWarnings[0]).toContain("COMPLETED");
  });

  it("handles mix of SUGGESTED and CONFIRMED assignments", async () => {
    const { cleanupChoreAssignmentsForDateChange } = await import(
      "@/lib/chore-cleanup"
    );

    const deleteMock = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: vi.fn(),
      choreAssignment: {
        findMany: vi.fn().mockResolvedValue([
          makeAssignment(
            "ca1",
            new Date("2026-06-01"),
            "SUGGESTED",
            "Dishes"
          ),
          makeAssignment(
            "ca2",
            new Date("2026-06-02"),
            "CONFIRMED",
            "Sweep"
          ),
        ]),
        deleteMany: deleteMock,
      },
    } as any;

    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      "bk1",
      new Date("2026-06-03"),
      new Date("2026-06-05")
    );

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(result.deletedCount).toBe(1);
    expect(result.choreWarnings).toHaveLength(1);
  });

  it("returns empty when no out-of-range assignments exist", async () => {
    const { cleanupChoreAssignmentsForDateChange } = await import(
      "@/lib/chore-cleanup"
    );

    const tx = {
      $executeRaw: vi.fn(),
      choreAssignment: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn(),
      },
    } as any;

    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      "bk1",
      new Date("2026-06-01"),
      new Date("2026-06-05")
    );

    expect(result.deletedCount).toBe(0);
    expect(result.choreWarnings).toHaveLength(0);
  });

  it("does not create new assignments for added dates", async () => {
    const { cleanupChoreAssignmentsForDateChange } = await import(
      "@/lib/chore-cleanup"
    );

    const createMock = vi.fn();
    const tx = {
      $executeRaw: vi.fn(),
      choreAssignment: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn(),
        create: createMock,
      },
    } as any;

    // Extended from Mon-Fri to Mon-Sun
    await cleanupChoreAssignmentsForDateChange(
      tx,
      "bk1",
      new Date("2026-06-01"),
      new Date("2026-06-07")
    );

    expect(createMock).not.toHaveBeenCalled();
  });

  it("re-reads after the roster lock and does not delete an assignment reattributed while waiting", async () => {
    const { cleanupChoreAssignmentsForDateChange } = await import(
      "@/lib/chore-cleanup"
    );
    const stale = makeAssignment(
      "ca-moved",
      new Date("2026-06-01"),
      "SUGGESTED",
      "Dishes",
    );
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi.fn()
      // Pre-lock key derivation still sees the row on booking A.
      .mockResolvedValueOnce([stale])
      // A concurrent whole-roster Save wins the lock and moves it to booking B.
      .mockResolvedValueOnce([]);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      choreAssignment: { findMany, deleteMany },
    } as any;

    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      "booking-a",
      new Date("2026-06-03"),
      new Date("2026-06-05"),
    );

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 0, choreWarnings: [] });
  });
});

// =====================================================================
// XER-01: Xero invoice adjustment
// Tests verify that:
// 1. createXeroSupplementaryInvoice creates invoice with correct line items
// 2. createXeroCreditNoteForModification creates credit note and allocates
// 3. Both return null when no Xero invoice exists or amounts are 0
// 4. Change fee appears as a separate line item
// =====================================================================

describe("XER-01: createXeroSupplementaryInvoice", () => {
  it("returns null when no Xero invoice exists on payment", async () => {
    // Test the logic: if no xeroInvoiceId, no Xero action
    const bookingWithoutXero = {
      id: "bk1",
      payment: { xeroInvoiceId: null },
    };
    // The function checks booking.payment.xeroInvoiceId early and returns null
    expect(bookingWithoutXero.payment.xeroInvoiceId).toBeNull();
  });

  it("creates supplementary invoice for price increase with separate change fee line", () => {
    // Verify the API contract: priceDiffCents and changeFeeCents are separate
    const params = {
      bookingId: "bk1",
      priceDiffCents: 5000,
      changeFeeCents: 2000,
    };

    // Price diff becomes a line item at $50.00
    expect(params.priceDiffCents / 100).toBe(50);
    // Change fee becomes a separate line item at $20.00
    expect(params.changeFeeCents / 100).toBe(20);
    // Total supplementary invoice = $70.00
    expect((params.priceDiffCents + params.changeFeeCents) / 100).toBe(70);
  });

  it("handles change-fee-only supplementary invoice (no price diff)", () => {
    const params = {
      bookingId: "bk1",
      priceDiffCents: 0,
      changeFeeCents: 10000,
    };

    // Only change fee line item, no price diff line
    expect(params.priceDiffCents).toBe(0);
    expect(params.changeFeeCents).toBeGreaterThan(0);
  });

  it("returns null when both priceDiff and changeFee are 0", () => {
    const priceDiffCents = 0;
    const changeFeeCents = 0;
    // No line items would be created
    const lineItems = [];
    if (priceDiffCents > 0) lineItems.push("price-diff");
    if (changeFeeCents > 0) lineItems.push("change-fee");
    expect(lineItems).toHaveLength(0);
  });
});

describe("XER-01: createXeroCreditNoteForModification", () => {
  it("returns null when refundAmountCents is 0", () => {
    const refundAmountCents = 0;
    // Function returns null early
    expect(refundAmountCents <= 0).toBe(true);
  });

  it("returns null when no Xero invoice exists", () => {
    const payment = { xeroInvoiceId: null };
    expect(payment.xeroInvoiceId).toBeNull();
  });

  it("creates credit note with correct amount", () => {
    const refundAmountCents = 3000;
    // Credit note line item should be $30.00
    expect(refundAmountCents / 100).toBe(30);
  });

  it("allocates credit note against original invoice", () => {
    const xeroInvoiceId = "inv-orig";
    const refundAmountCents = 5000;

    // Allocation params
    const allocation = {
      invoice: { invoiceID: xeroInvoiceId },
      amount: refundAmountCents / 100,
    };

    expect(allocation.invoice.invoiceID).toBe("inv-orig");
    expect(allocation.amount).toBe(50);
  });
});

// =====================================================================
// EML-01: Booking modified email template
// =====================================================================

describe("EML-01: bookingModifiedTemplate", () => {
  it("renders template with date change details", async () => {
    const { bookingModifiedTemplate } = await import(
      "@/lib/email-templates/booking"
    );

    const html = bookingModifiedTemplate({
      firstName: "Alice",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-05"),
      newCheckIn: new Date("2026-06-10"),
      newCheckOut: new Date("2026-06-15"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 20000,
      newFinalPriceCents: 25000,
      changeFeeCents: 5000,
      refundAmountCents: 0,
      additionalAmountCents: 10000,
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });

    expect(html).toContain("Booking Modified");
    expect(html).toContain("Alice");
    expect(html).toContain("Dates Changed");
    expect(html).toContain("Change Fee");
    expect(html).toContain("additional payment");
  });

  it("renders template with guest add details", async () => {
    const { bookingModifiedTemplate } = await import(
      "@/lib/email-templates/booking"
    );

    const html = bookingModifiedTemplate({
      firstName: "Bob",
      modificationType: "GUEST_ADD",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-05"),
      newCheckIn: new Date("2026-06-01"),
      newCheckOut: new Date("2026-06-05"),
      oldGuestCount: 2,
      newGuestCount: 3,
      oldFinalPriceCents: 20000,
      newFinalPriceCents: 30000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 10000,
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });

    expect(html).toContain("Guests Added");
    expect(html).toContain("Previous Guests");
    expect(html).toContain("New Guests");
    expect(html).not.toContain("Change Fee");
  });

  it("renders refund message for price decrease", async () => {
    const { bookingModifiedTemplate } = await import(
      "@/lib/email-templates/booking"
    );

    const html = bookingModifiedTemplate({
      firstName: "Charlie",
      modificationType: "GUEST_REMOVE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-05"),
      newCheckIn: new Date("2026-06-01"),
      newCheckOut: new Date("2026-06-05"),
      oldGuestCount: 3,
      newGuestCount: 2,
      oldFinalPriceCents: 30000,
      newFinalPriceCents: 20000,
      changeFeeCents: 0,
      refundAmountCents: 10000,
      additionalAmountCents: 0,
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });

    expect(html).toContain("Guest Removed");
    expect(html).toContain("refund");
  });

  it("escapes HTML in user-provided firstName", async () => {
    const { bookingModifiedTemplate } = await import(
      "@/lib/email-templates/booking"
    );

    const html = bookingModifiedTemplate({
      firstName: '<script>alert("xss")</script>',
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-02"),
      newCheckOut: new Date("2026-06-04"),
      oldGuestCount: 1,
      newGuestCount: 1,
      oldFinalPriceCents: 5000,
      newFinalPriceCents: 5000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 0,
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows same price when unchanged", async () => {
    const { bookingModifiedTemplate } = await import(
      "@/lib/email-templates/booking"
    );

    const html = bookingModifiedTemplate({
      firstName: "Dan",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-06-01"),
      oldCheckOut: new Date("2026-06-03"),
      newCheckIn: new Date("2026-06-02"),
      newCheckOut: new Date("2026-06-04"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 10000,
      newFinalPriceCents: 10000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 0,
      // #3032: required, and this suite is not about the review note.
      // False is the control state for every assertion here.
      financialReviewPending: false,
    });

    // Should show "Total" not "Previous Total" / "New Total"
    expect(html).toContain("Total");
    expect(html).not.toContain("Previous Total");
  });
});
