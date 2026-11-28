/**
 * `INV-PAY-047`'s typed census loader (#5288), read against a stand-in client:
 * which bookings it lists, which invoices it asks Xero about, and how each
 * row's Xero billing evidence decides its verdict. The PostgreSQL proof of the
 * same loader is `ib-unlinked-fee-ask.realdb.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { loadBookingLedgerCensus } from "@/lib/booking-ledger-census";

const FEE_CENTS = 5000;

function booking(id: string, payment: Record<string, unknown>, modificationIds: string[] = []) {
  return {
    id,
    status: "PAID",
    finalPriceCents: 20000,
    payment: {
      id: `pay-${id}`,
      source: "INTERNET_BANKING",
      xeroInvoiceId: null,
      changeFeeCents: 0,
      amountCents: 0,
      refundedAmountCents: 0,
      creditAppliedCents: 20000,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      ...payment,
    },
    modifications: modificationIds.map((modificationId) => ({ id: modificationId })),
  };
}

function client(input: {
  bookings: unknown[];
  links?: { localModel: string; localId: string }[];
  queued?: { localModel: string; localId: string }[];
}) {
  return {
    booking: { findMany: vi.fn(async () => input.bookings) },
    xeroObjectLink: { findMany: vi.fn(async () => input.links ?? []) },
    xeroSyncOperation: { findMany: vi.fn(async () => input.queued ?? []) },
  };
}

describe("loadBookingLedgerCensus (INV-PAY-047)", () => {
  it("lists only unbalanced bookings, largest owed first, with each one's Xero billing verdict", async () => {
    const db = client({
      bookings: [
        booking("balanced", {}),
        { ...booking("no-payment", {}), payment: null },
        booking("unasked", { changeFeeCents: FEE_CENTS }),
        booking("queued", { changeFeeCents: FEE_CENTS }),
        booking("supplementary", { changeFeeCents: FEE_CENTS * 2 }, ["mod-1"]),
        booking("card", { changeFeeCents: FEE_CENTS * 3, source: "STRIPE" }),
        booking("primary-id", { changeFeeCents: FEE_CENTS, xeroInvoiceId: "inv-1" }),
        booking("retained", { refundedAmountCents: 0, creditAppliedCents: 21000 }),
      ],
      links: [{ localModel: "BookingModification", localId: "mod-1" }],
      queued: [{ localModel: "Payment", localId: "pay-queued" }],
    });

    const rows = await loadBookingLedgerCensus(db as never);

    expect(rows.map((row) => [row.bookingId, row.residualCents, row.verdict])).toEqual([
      ["card", FEE_CENTS * 3, "unasked"],
      ["supplementary", FEE_CENTS * 2, "billedInXero"],
      ["primary-id", FEE_CENTS, "billedInXero"],
      ["queued", FEE_CENTS, "billedInXero"],
      ["unasked", FEE_CENTS, "unasked"],
      ["retained", -1000, "retained"],
    ]);
    expect(rows.find((row) => row.bookingId === "queued")).toMatchObject({
      paymentSource: "INTERNET_BANKING",
      activeInvoiceLink: false,
      queuedInvoiceCreate: true,
    });
    expect(rows.find((row) => row.bookingId === "supplementary")).toMatchObject({
      activeInvoiceLink: true,
      queuedInvoiceCreate: false,
    });
  });

  it("asks Xero only about the unbalanced bookings' payment and edit invoices", async () => {
    const db = client({
      bookings: [booking("balanced", {}, ["mod-balanced"]), booking("owed", { changeFeeCents: FEE_CENTS }, ["mod-owed"])],
    });

    await loadBookingLedgerCensus(db as never);

    expect(db.xeroObjectLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          active: true,
          xeroObjectType: "INVOICE",
          OR: [
            { localModel: "Payment", role: "PRIMARY_INVOICE", localId: { in: ["pay-owed"] } },
            { localModel: "BookingModification", role: "SUPPLEMENTARY_INVOICE", localId: { in: ["mod-owed"] } },
          ],
        },
      }),
    );
    expect(db.xeroSyncOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          status: { in: ["PENDING", "RUNNING"] },
          OR: [
            { localModel: "Payment", localId: { in: ["pay-owed"] } },
            { localModel: "BookingModification", localId: { in: ["mod-owed"] } },
          ],
        }),
      }),
    );
  });
});
