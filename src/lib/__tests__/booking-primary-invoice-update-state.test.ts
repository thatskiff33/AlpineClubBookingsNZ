import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  classifyPrimaryInvoiceUpdates,
  primaryInvoiceUpdateNotice,
  readPrimaryInvoiceUpdateState,
  type PrimaryInvoiceUpdateRow,
} from "@/lib/booking-primary-invoice-update-state";

/**
 * #5066 (owner decision on PR #5201, 17 Nov 2026; review N3): where the app
 * knows an edit could not update the booking's invoice in Xero — skipped,
 * failed, or still queued — the booking page says so in plain words.
 */
const at = (minute: number) => new Date(Date.UTC(2026, 6, 1, 0, minute));
const row = (overrides: Partial<PrimaryInvoiceUpdateRow> = {}): PrimaryInvoiceUpdateRow => ({
  status: "SUCCEEDED",
  createdAt: at(0),
  manuallyResolvedAt: null,
  requestPayload: { queueType: "BOOKING_INVOICE_UPDATE", xeroInvoiceId: "inv-1" },
  ...overrides,
});
const skipped = (minute: number) =>
  row({
    createdAt: at(minute),
    requestPayload: { queueType: "BOOKING_INVOICE_UPDATE", xeroInvoiceId: "inv-1", skippedByPolicy: true, reason: "locked" },
  });

describe("classifyPrimaryInvoiceUpdates", () => {
  it("is current with no update rows, or when the latest update succeeded", () => {
    expect(classifyPrimaryInvoiceUpdates([], "inv-1")).toBe("CURRENT");
    expect(classifyPrimaryInvoiceUpdates([skipped(1), row({ createdAt: at(2) })], "inv-1")).toBe("CURRENT");
  });

  it("is not updated when an edit's update was skipped (recordSkippedXeroBookingInvoiceUpdateOperation)", () => {
    expect(classifyPrimaryInvoiceUpdates([row({ createdAt: at(1) }), skipped(2)], "inv-1")).toBe("NOT_UPDATED");
  });

  it("is not updated when the latest update failed, unless an officer marked it resolved in Xero", () => {
    expect(classifyPrimaryInvoiceUpdates([row({ status: "FAILED", createdAt: at(1) })], "inv-1")).toBe("NOT_UPDATED");
    expect(classifyPrimaryInvoiceUpdates([row({ status: "PARTIAL", createdAt: at(1) })], "inv-1")).toBe("NOT_UPDATED");
    expect(classifyPrimaryInvoiceUpdates([row({ status: "FAILED", manuallyResolvedAt: at(5) })], "inv-1")).toBe("CURRENT");
  });

  it("is updating while any update is queued or running (N3), whatever ended before it", () => {
    expect(classifyPrimaryInvoiceUpdates([row({ status: "PENDING" })], "inv-1")).toBe("UPDATING");
    expect(classifyPrimaryInvoiceUpdates([skipped(1), row({ status: "RUNNING", createdAt: at(2) })], "inv-1")).toBe("UPDATING");
  });

  it("ignores rows that name a different invoice", () => {
    const other = { queueType: "BOOKING_INVOICE_UPDATE", xeroInvoiceId: "inv-old", skippedByPolicy: true };
    expect(classifyPrimaryInvoiceUpdates([row({ requestPayload: other })], "inv-1")).toBe("CURRENT");
  });
});

describe("primaryInvoiceUpdateNotice", () => {
  it("says nothing when the invoice is current", () => {
    expect(primaryInvoiceUpdateNotice("CURRENT")).toBeNull();
  });

  it("says in plain words that the invoice may not show a change still being made", () => {
    expect(primaryInvoiceUpdateNotice("UPDATING")).toBe(
      "A recent change to this booking is still being made to the invoice in the club's accounts, so the invoice may not show it yet.",
    );
  });

  it("says in plain words that the invoice does not show a change that could not be made", () => {
    expect(primaryInvoiceUpdateNotice("NOT_UPDATED")).toBe(
      "A change to this booking could not be made to the invoice in the club's accounts, so the invoice does not show it. The summary here is from the booking itself.",
    );
    expect(primaryInvoiceUpdateNotice("NOT_UPDATED")).not.toMatch(/Xero/);
  });
});

describe("readPrimaryInvoiceUpdateState", () => {
  it("reads the primary invoice's outbound updates anchored to the payment and to the booking's modifications", async () => {
    const findMany = vi.fn(async () => [skipped(3)]);
    const state = await readPrimaryInvoiceUpdateState(
      { paymentId: "pay-1", xeroInvoiceId: "inv-1", modificationIds: ["mod-1", "mod-2"] },
      { xeroSyncOperation: { findMany } } as never,
    );
    expect(state).toBe("NOT_UPDATED");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "UPDATE",
          OR: [
            { localModel: "Payment", localId: "pay-1" },
            { localModel: "BookingModification", localId: { in: ["mod-1", "mod-2"] } },
          ],
        },
      }),
    );
  });

  it("reads only the payment's rows when the booking has no modifications", async () => {
    const findMany = vi.fn(async () => []);
    await readPrimaryInvoiceUpdateState({ paymentId: "pay-1", xeroInvoiceId: "inv-1", modificationIds: [] }, { xeroSyncOperation: { findMany } } as never);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ OR: [{ localModel: "Payment", localId: "pay-1" }] }) }),
    );
  });
});
