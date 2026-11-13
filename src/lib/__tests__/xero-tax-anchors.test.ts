import { beforeEach, describe, expect, it, vi } from "vitest";
import { LineAmountTypes } from "xero-node";
import { CLUB_TAX_SETTINGS_DEFAULTS } from "@/lib/club-tax-settings";
import { requireInstant } from "@/lib/club-time";
import { BASELINE_XERO_TAX_RENDERING } from "@/lib/xero-tax-rendering";

/**
 * Each Xero document's treatment is fixed by its anchor (#4632, owner decision
 * A): the club date of the moment its charge was made, never the send date.
 * The club registers out of GST from 2027-04-01 (NZ), so an anchor on either
 * side of that midnight renders differently.
 */
const mocks = vi.hoisted(() => ({
  booking: vi.fn(),
  charge: vi.fn(),
  subscription: vi.fn(),
  operation: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.booking },
    membershipSubscriptionCharge: { findUnique: mocks.charge },
    memberSubscription: { findUnique: mocks.subscription },
    xeroSyncOperation: { findUnique: mocks.operation },
    clubTaxSettings: {
      findMany: vi.fn(async () => [
        { id: "default", ...CLUB_TAX_SETTINGS_DEFAULTS, effectiveFrom: new Date("2010-10-01T00:00:00.000Z") },
        { id: "deregistered", gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: new Date("2027-04-01T00:00:00.000Z") },
      ]),
    },
  },
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland") }));

import { resolveXeroTaxRendering } from "@/lib/xero-tax-anchors";

/** 23:30 NZ on 31 March 2027, and 00:30 NZ on 1 April 2027 (NZDT ends 4 April). */
const BEFORE = new Date("2027-03-31T10:30:00.000Z");
const AFTER = new Date("2027-03-31T11:30:00.000Z");
const NO_TAX = { lineAmountTypes: LineAmountTypes.NoTax };

describe("resolveXeroTaxRendering (#4632)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("an instant anchor renders the treatment of its club date", async () => {
    await expect(resolveXeroTaxRendering({ kind: "instant", at: requireInstant(BEFORE) })).resolves.toEqual(BASELINE_XERO_TAX_RENDERING);
    await expect(resolveXeroTaxRendering({ kind: "instant", at: requireInstant(AFTER) })).resolves.toEqual(NO_TAX);
  });

  it("a booking keeps the treatment of the day it was made", async () => {
    mocks.booking.mockResolvedValue({ createdAt: BEFORE });
    await expect(resolveXeroTaxRendering({ kind: "booking", bookingId: "b" })).resolves.toEqual(BASELINE_XERO_TAX_RENDERING);
    expect(mocks.booking).toHaveBeenCalledWith({ where: { id: "b" }, select: { createdAt: true } });
  });

  it("a place billed to its organiser takes the organiser's booking, else its own", async () => {
    mocks.booking.mockResolvedValueOnce({ createdAt: AFTER, parentBooking: { createdAt: BEFORE } });
    await expect(resolveXeroTaxRendering({ kind: "organiser-billed-place", bookingId: "place" })).resolves.toEqual(BASELINE_XERO_TAX_RENDERING);
    mocks.booking.mockResolvedValueOnce({ createdAt: AFTER, parentBooking: null });
    await expect(resolveXeroTaxRendering({ kind: "organiser-billed-place", bookingId: "place" })).resolves.toEqual(NO_TAX);
  });

  it("a subscription charge, and an invoice through its charge or else its subscription", async () => {
    mocks.charge.mockResolvedValueOnce({ createdAt: AFTER });
    await expect(resolveXeroTaxRendering({ kind: "subscription-charge", chargeId: "c" })).resolves.toEqual(NO_TAX);
    mocks.charge.mockResolvedValueOnce({ createdAt: BEFORE });
    await expect(resolveXeroTaxRendering({ kind: "subscription-invoice", invoiceId: "inv", subscriptionId: "s" })).resolves.toEqual(BASELINE_XERO_TAX_RENDERING);
    expect(mocks.charge).toHaveBeenLastCalledWith({ where: { xeroInvoiceId: "inv" }, select: { createdAt: true } });
    mocks.charge.mockResolvedValueOnce(null);
    mocks.subscription.mockResolvedValueOnce({ createdAt: AFTER });
    await expect(resolveXeroTaxRendering({ kind: "subscription-invoice", invoiceId: "old", subscriptionId: "s" })).resolves.toEqual(NO_TAX);
  });

  it("a document with no charge row takes its outbox operation's creation", async () => {
    mocks.operation.mockResolvedValue({ createdAt: BEFORE });
    await expect(resolveXeroTaxRendering({ kind: "xero-operation", operationId: "op" })).resolves.toEqual(BASELINE_XERO_TAX_RENDERING);
  });

  it("refuses a missing anchor row rather than guess a treatment", async () => {
    mocks.booking.mockResolvedValue(null);
    mocks.charge.mockResolvedValue(null);
    mocks.subscription.mockResolvedValue(null);
    mocks.operation.mockResolvedValue(null);
    await expect(resolveXeroTaxRendering({ kind: "booking", bookingId: "gone" })).rejects.toThrow(/no tax anchor/);
    await expect(resolveXeroTaxRendering({ kind: "organiser-billed-place", bookingId: "gone" })).rejects.toThrow(/no tax anchor/);
    await expect(resolveXeroTaxRendering({ kind: "subscription-charge", chargeId: "gone" })).rejects.toThrow(/no tax anchor/);
    await expect(resolveXeroTaxRendering({ kind: "subscription-invoice", invoiceId: "gone", subscriptionId: "gone" })).rejects.toThrow(/no tax anchor/);
    await expect(resolveXeroTaxRendering({ kind: "xero-operation", operationId: "gone" })).rejects.toThrow(/no tax anchor/);
  });
});
