import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * WHICH PAID BOOKINGS HAVE NO INVOICE IN XERO (#3467).
 *
 * The Xero health screen's "Missing invoices" list used to decide that from
 * "is there a SUCCEEDED invoice operation against the booking's payment", so a
 * booking whose operation failed AFTER Xero accepted the invoice was listed as
 * missing although the accounts hold it. It now asks the same evidence rule the
 * booking page (#3001) and the enqueue fence ask — the payment's stored invoice
 * id, or an active `PRIMARY_INVOICE` link — and reads no operation row at all.
 *
 * The prisma mock deliberately has NO `xeroSyncOperation` table: a query that
 * went back to reading the operation ledger would throw here rather than pass.
 */

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  linkFindMany: vi.fn(),
  memberCount: vi.fn(),
  syncOperationCount: vi.fn(),
  cursorFindFirst: vi.fn(),
  cronFindFirst: vi.fn(),
  paymentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: mocks.bookingFindMany },
    xeroObjectLink: { findMany: mocks.linkFindMany },
    member: { count: mocks.memberCount },
    xeroSyncOperation: { count: mocks.syncOperationCount },
    xeroSyncCursor: { findFirst: mocks.cursorFindFirst },
    cronJobRun: { findFirst: mocks.cronFindFirst },
    payment: { findMany: mocks.paymentFindMany },
  },
}));

// The health snapshot's other panels are not under test; each is stubbed to
// its quiet value so the snapshot can be built at all.
vi.mock("@/lib/xero-admin-failures", () => ({
  getFailedXeroOperationOverview: vi
    .fn()
    .mockResolvedValue({ activeFailedCount: 0, legacyFailedCount: 0 }),
}));
vi.mock("@/lib/xero-stale-operations", () => ({
  STALE_PROCESSING_XERO_INBOUND_EVENT_MINUTES: 30,
  STALE_RUNNING_XERO_OPERATION_MINUTES: 30,
  countStaleProcessingXeroInboundEvents: vi.fn().mockResolvedValue(0),
  countStaleRunningXeroOperations: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/xero-member-grouping-resync", () => ({
  getXeroMemberGroupingSnapshot: vi.fn().mockResolvedValue({
    mismatchCount: 0,
    informationalCount: 0,
    cacheReady: true,
  }),
}));
vi.mock("@/lib/xero-contact-link-mismatches", () => ({
  getXeroContactLinkMismatchSnapshot: vi
    .fn()
    .mockResolvedValue({ count: 0, cacheReady: true }),
}));
vi.mock("@/lib/xero-api-usage", () => ({
  getTodaysXeroUsageSummary: vi.fn().mockRejectedValue(new Error("offline")),
}));
vi.mock("@/lib/xero-sync", () => ({
  sumCoveredRefundCreditNoteCents: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({
  resolveStripeCashRefundEvidence: vi.fn(),
}));

import {
  getMissingXeroInvoiceBookings,
  getXeroAdminHealthSnapshot,
} from "@/lib/xero-admin-health";

function paidBooking(id: string, payment: { id: string; xeroInvoiceId: string | null }) {
  return {
    id,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    checkIn: new Date("2026-06-10T00:00:00.000Z"),
    checkOut: new Date("2026-06-12T00:00:00.000Z"),
    status: "PAID" as const,
    member: {
      id: `member-${id}`,
      firstName: "Alex",
      lastName: "Admin",
      email: `${id}@example.com`,
    },
    organisation: null,
    payment,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.linkFindMany.mockResolvedValue([]);
  mocks.memberCount.mockResolvedValue(0);
  mocks.syncOperationCount.mockResolvedValue(0);
  mocks.cursorFindFirst.mockResolvedValue(null);
  mocks.cronFindFirst.mockResolvedValue(null);
  mocks.paymentFindMany.mockResolvedValue([]);
});

describe("getMissingXeroInvoiceBookings reads the #3001 evidence rule (#3467)", () => {
  it("does NOT list a booking whose operation failed after Xero accepted the invoice", async () => {
    // The payment stamp landed before the failure: the accounts hold the invoice.
    mocks.bookingFindMany.mockResolvedValue([
      paidBooking("booking-stamped", { id: "pay-stamped", xeroInvoiceId: "inv-1" }),
    ]);

    const result = await getMissingXeroInvoiceBookings();

    expect(result).toEqual({ count: 0, bookings: [] });
    // The payment field settled it; the link table was not even asked.
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
  });

  it("does NOT list a booking whose only record is the active primary-invoice link", async () => {
    // The completion transaction wrote the link; a later retry then failed and
    // the payment field is empty. Still an invoice in Xero.
    mocks.bookingFindMany.mockResolvedValue([
      paidBooking("booking-linked", { id: "pay-linked", xeroInvoiceId: null }),
    ]);
    mocks.linkFindMany.mockResolvedValue([
      { localId: "pay-linked", xeroObjectNumber: "INV-0009" },
    ]);

    const result = await getMissingXeroInvoiceBookings();

    expect(result).toEqual({ count: 0, bookings: [] });
    expect(mocks.linkFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.linkFindMany.mock.calls[0][0].where).toMatchObject({
      localModel: "Payment",
      localId: { in: ["pay-linked"] },
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    });
  });

  it("STILL lists a booking that genuinely has no invoice, and only that one", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      paidBooking("booking-stamped", { id: "pay-stamped", xeroInvoiceId: "inv-1" }),
      paidBooking("booking-missing", { id: "pay-missing", xeroInvoiceId: null }),
      paidBooking("booking-linked", { id: "pay-linked", xeroInvoiceId: null }),
    ]);
    mocks.linkFindMany.mockResolvedValue([
      { localId: "pay-linked", xeroObjectNumber: null },
    ]);

    const result = await getMissingXeroInvoiceBookings();

    expect(result.count).toBe(1);
    expect(result.bookings).toEqual([
      expect.objectContaining({
        bookingId: "booking-missing",
        paymentId: "pay-missing",
        memberId: "member-booking-missing",
        memberName: "Alex Admin",
        memberEmail: "booking-missing@example.com",
        status: "PAID",
      }),
    ]);
    // Only the payments the field left open are looked up.
    expect(mocks.linkFindMany.mock.calls[0][0].where.localId).toEqual({
      in: ["pay-missing", "pay-linked"],
    });
  });

  it("keeps the B5 candidate filter: PAID, with a payment, not manually settled", async () => {
    mocks.bookingFindMany.mockResolvedValue([]);

    await getMissingXeroInvoiceBookings();

    expect(mocks.bookingFindMany.mock.calls[0][0].where).toEqual({
      status: "PAID",
      payment: { isNot: null },
      NOT: { payment: { manuallyMarkedPaidAt: { not: null } } },
    });
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
  });

  it("the limit trims the list but never the count", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      paidBooking("b1", { id: "p1", xeroInvoiceId: null }),
      paidBooking("b2", { id: "p2", xeroInvoiceId: null }),
    ]);

    const result = await getMissingXeroInvoiceBookings({ limit: 1 });

    expect(result.count).toBe(2);
    expect(result.bookings.map((booking) => booking.bookingId)).toEqual(["b1"]);
  });
});

describe("the club-wide count moves with the same rule", () => {
  it("getXeroAdminHealthSnapshot().missingInvoices.count is the evidence-filtered count", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      paidBooking("booking-stamped", { id: "pay-stamped", xeroInvoiceId: "inv-1" }),
      paidBooking("booking-missing", { id: "pay-missing", xeroInvoiceId: null }),
      paidBooking("booking-also-missing", { id: "pay-also", xeroInvoiceId: null }),
    ]);

    const snapshot = await getXeroAdminHealthSnapshot();

    // Two of three candidates are missing; the stamped one is not counted.
    expect(snapshot.missingInvoices).toEqual({ count: 2 });
  });

  it("the stuck-state dashboard and the finance health count both read that field", () => {
    // Neither surface may re-derive the rule. They take the snapshot's count,
    // which is why the two tests above are enough to speak for them.
    for (const relativePath of [
      "src/lib/stuck-state-dashboard.ts",
      "src/lib/finance-sync-health.ts",
    ]) {
      const source = stripComments(
        readFileSync(path.join(process.cwd(), relativePath), "utf8"),
      );
      expect(
        source,
        `${relativePath} must take the count from the health snapshot (INV-SSOT-001, #3467)`,
      ).toMatch(/\.missingInvoices\.count/);
      expect(
        source,
        `${relativePath} must not re-derive the missing-invoice rule (INV-SSOT-001, #3467)`,
      ).not.toMatch(/xeroSyncOperation|PRIMARY_INVOICE/);
    }
  });
});
