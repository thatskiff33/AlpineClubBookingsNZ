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
          OR: [
            { status: { in: ["PENDING", "RUNNING", "SUCCEEDED", "PARTIAL"] } },
            { status: "FAILED", manuallyResolvedAt: { not: null } },
          ],
        }),
      }),
    );
    // No queue-type filter: a retry row written before the builder stamped the
    // column carries none, and a running retry must still count.
    expect(queued.operationFindFirst.mock.calls[0]![0].where).not.toHaveProperty("queueType");
    const none = db(null, null);
    await expect(
      hasInvoiceClearingNote(none.client, { bookingId: "b1", xeroRefundCreditNoteId: null }),
    ).resolves.toBe(false);
  });

  it("counts a failed note an officer raised by hand and resolved, and not an unresolved failure (#3635)", async () => {
    // A tiny evaluator of the query's OR, so the test reads what the where
    // clause would match rather than what a stub was told to return.
    type Row = { status: string; manuallyResolvedAt: Date | null };
    const matches = (row: Row, clause: Record<string, unknown>) => {
      const status = clause.status as string | { in: string[] };
      const statusOk =
        typeof status === "string" ? row.status === status : status.in.includes(row.status);
      const resolvedOk =
        !("manuallyResolvedAt" in clause) || row.manuallyResolvedAt !== null;
      return statusOk && resolvedOk;
    };
    const answer = async (row: Row) => {
      const operationFindFirst = vi.fn(async (args: { where: { OR: Record<string, unknown>[] } }) =>
        args.where.OR.some((clause) => matches(row, clause)) ? { id: "op_1" } : null,
      );
      const client = {
        xeroObjectLink: { findFirst: vi.fn().mockResolvedValue(null) },
        xeroSyncOperation: { findFirst: operationFindFirst },
      } as unknown as Prisma.TransactionClient;
      return hasInvoiceClearingNote(client, { bookingId: "b1", xeroRefundCreditNoteId: null });
    };

    await expect(
      answer({ status: "FAILED", manuallyResolvedAt: new Date("2026-06-20T00:00:00.000Z") }),
    ).resolves.toBe(true);
    await expect(answer({ status: "FAILED", manuallyResolvedAt: null })).resolves.toBe(false);
  });
});
