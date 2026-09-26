/**
 * #3535: "an invoice-clearing note was already issued" must read both note
 * shapes — the old payment-anchored refund note's field and the booking-anchored
 * clearing note every hold released since #3535 carries.
 */
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { hasInvoiceClearingNote } from "@/lib/invoice-clearing-note-evidence";

function db(link: unknown, operation: unknown) {
  const linkFindFirst = vi.fn().mockResolvedValue(link);
  const operationFindFirst = vi.fn().mockResolvedValue(operation);
  return {
    client: {
      xeroObjectLink: { findFirst: linkFindFirst },
      xeroSyncOperation: { findFirst: operationFindFirst },
    } as unknown as Prisma.TransactionClient,
    linkFindFirst,
    operationFindFirst,
  };
}

describe("hasInvoiceClearingNote (#3535)", () => {
  it("answers yes from the old refund note's field without a query", async () => {
    const fake = db(null, null);
    await expect(
      hasInvoiceClearingNote(fake.client, { bookingId: "b1", xeroRefundCreditNoteId: "cn_old" }),
    ).resolves.toBe(true);
    expect(fake.linkFindFirst).not.toHaveBeenCalled();
  });

  it("answers yes from the booking's active clearing-note link", async () => {
    const fake = db({ id: "link_1" }, null);
    await expect(
      hasInvoiceClearingNote(fake.client, { bookingId: "b1", xeroRefundCreditNoteId: null }),
    ).resolves.toBe(true);
    expect(fake.linkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localModel: "Booking",
          localId: "b1",
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
        }),
      }),
    );
  });

  it("answers yes from a clearing operation in flight or finished, and no when there is none", async () => {
    const queued = db(null, { id: "op_1" });
    await expect(
      hasInvoiceClearingNote(queued.client, { bookingId: "b1", xeroRefundCreditNoteId: null }),
    ).resolves.toBe(true);
    expect(queued.operationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localModel: "Booking",
          localId: "b1",
          queueType: "MODIFICATION_CREDIT_NOTE",
          status: { in: ["PENDING", "RUNNING", "SUCCEEDED", "PARTIAL"] },
        }),
      }),
    );
    const none = db(null, null);
    await expect(
      hasInvoiceClearingNote(none.client, { bookingId: "b1", xeroRefundCreditNoteId: null }),
    ).resolves.toBe(false);
  });
});
