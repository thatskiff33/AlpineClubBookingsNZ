import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  classifyCreditNoteCreates,
  classifyPrimaryInvoiceUpdates,
  primaryInvoiceUpdateNotice,
  readPrimaryInvoiceUpdateState,
  type PrimaryInvoiceUpdateRow,
} from "@/lib/booking-primary-invoice-update-state";
import { isSkippedPrimaryInvoiceUpdate } from "@/lib/xero-primary-invoice-update-skip";

/**
 * #5066 (owner decision on PR #5201, 17 Nov 2026; review N3, F1, F2): where the
 * app knows a change has not reached the booking's Xero documents — an invoice
 * update skipped, failed or queued, or a credit note for it not yet created —
 * the booking page says so in plain words.
 */
const at = (minute: number) => new Date(Date.UTC(2026, 6, 1, 0, minute));
const row = (overrides: Partial<PrimaryInvoiceUpdateRow> = {}): PrimaryInvoiceUpdateRow => ({
  status: "SUCCEEDED",
  createdAt: at(0),
  manuallyResolvedAt: null,
  requestPayload: { queueType: "BOOKING_INVOICE_UPDATE", xeroInvoiceId: "inv-1" },
  responsePayload: null,
  ...overrides,
});
const skipped = (minute: number) =>
  row({
    createdAt: at(minute),
    requestPayload: { queueType: "BOOKING_INVOICE_UPDATE", xeroInvoiceId: "inv-1", skippedByPolicy: true, reason: "locked" },
  });

describe("isSkippedPrimaryInvoiceUpdate", () => {
  it("covers both writers: the edit's policy and the worker reading the live invoice", () => {
    expect(isSkippedPrimaryInvoiceUpdate({ requestPayload: { skippedByPolicy: true }, responsePayload: null })).toBe(true);
    expect(isSkippedPrimaryInvoiceUpdate({ requestPayload: {}, responsePayload: { skipped: true, reason: "credit applied" } })).toBe(true);
    expect(isSkippedPrimaryInvoiceUpdate({ requestPayload: {}, responsePayload: { invoice: {} } })).toBe(false);
  });
});

describe("classifyPrimaryInvoiceUpdates", () => {
  it("is current with no update rows, or when the latest update succeeded", () => {
    expect(classifyPrimaryInvoiceUpdates([], "inv-1")).toBe("CURRENT");
    expect(classifyPrimaryInvoiceUpdates([skipped(1), row({ createdAt: at(2) })], "inv-1")).toBe("CURRENT");
  });

  it("keeps the invoice as issued when an edit's update was skipped (recordSkippedXeroBookingInvoiceUpdateOperation)", () => {
    expect(classifyPrimaryInvoiceUpdates([row({ createdAt: at(1) }), skipped(2)], "inv-1")).toBe("INVOICE_AS_ISSUED");
  });

  it("F1: keeps the invoice as issued when the worker completed the update SUCCEEDED but skipped it on the live invoice", () => {
    const workerSkip = row({
      createdAt: at(2),
      responsePayload: { skipped: true, reason: "Skipped primary Xero invoice update because the invoice has credit applied." },
    });
    expect(classifyPrimaryInvoiceUpdates([row({ createdAt: at(1) }), workerSkip], "inv-1")).toBe("INVOICE_AS_ISSUED");
  });

  it("is not updated when the latest update failed, unless an officer marked it resolved in Xero", () => {
    expect(classifyPrimaryInvoiceUpdates([row({ status: "FAILED", createdAt: at(1) })], "inv-1")).toBe("NOT_UPDATED");
    expect(classifyPrimaryInvoiceUpdates([row({ status: "PARTIAL", createdAt: at(1) })], "inv-1")).toBe("NOT_UPDATED");
    expect(classifyPrimaryInvoiceUpdates([row({ status: "FAILED", manuallyResolvedAt: at(5) })], "inv-1")).toBe("CURRENT");
  });

  it("lets the latest ended row decide between a skip and a failure", () => {
    expect(classifyPrimaryInvoiceUpdates([row({ status: "FAILED", createdAt: at(1) }), skipped(2)], "inv-1")).toBe("INVOICE_AS_ISSUED");
    expect(classifyPrimaryInvoiceUpdates([skipped(1), row({ status: "FAILED", createdAt: at(2) })], "inv-1")).toBe("NOT_UPDATED");
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

describe("classifyCreditNoteCreates (F2)", () => {
  const create = (status: string, manuallyResolvedAt: Date | null = null) => ({ status, manuallyResolvedAt });

  it("is current with none, or when every note was created", () => {
    expect(classifyCreditNoteCreates([])).toBe("CURRENT");
    expect(classifyCreditNoteCreates([create("SUCCEEDED"), create("CANCELLED")])).toBe("CURRENT");
  });

  it("is updating while a note is queued or running", () => {
    expect(classifyCreditNoteCreates([create("SUCCEEDED"), create("PENDING")])).toBe("UPDATING");
    expect(classifyCreditNoteCreates([create("RUNNING")])).toBe("UPDATING");
  });

  it("is not updated while a note failed, or was created but not allocated, and no officer resolved it", () => {
    expect(classifyCreditNoteCreates([create("FAILED"), create("PENDING")])).toBe("NOT_UPDATED");
    expect(classifyCreditNoteCreates([create("PARTIAL")])).toBe("NOT_UPDATED");
    expect(classifyCreditNoteCreates([create("FAILED", at(9))])).toBe("CURRENT");
  });
});

describe("primaryInvoiceUpdateNotice", () => {
  it("says nothing when the club's accounts show the latest change", () => {
    expect(primaryInvoiceUpdateNotice("CURRENT")).toBeNull();
  });

  it("says in plain words that the invoice and its credit notes may not show a change still on its way", () => {
    expect(primaryInvoiceUpdateNotice("UPDATING")).toBe(
      "A recent change to this booking is still on its way to the club's accounts, so the invoice and its credit notes may not show it yet.",
    );
  });

  it("says in plain words that the invoice, or a credit for the change, does not show it", () => {
    expect(primaryInvoiceUpdateNotice("NOT_UPDATED")).toBe(
      "A change to this booking has not fully reached the club's accounts: the invoice, or a credit for the change, does not show it yet. The summary here is from the booking itself.",
    );
    expect(primaryInvoiceUpdateNotice("NOT_UPDATED")).not.toMatch(/Xero/);
  });

  it("does not promise a later update or credit when a skipped update left the invoice as issued", () => {
    const notice = primaryInvoiceUpdateNotice("INVOICE_AS_ISSUED");
    expect(notice).toBe(
      "A later change to this booking is not shown on the invoice, which stays as it was issued. The summary here is from the booking itself.",
    );
    expect(notice).not.toMatch(/yet|credit|Xero/);
  });
});

describe("readPrimaryInvoiceUpdateState", () => {
  type Where = { where: { entityType: string } & Record<string, unknown> };
  function store(updates: unknown[], creditNotes: unknown[]) {
    const findMany = vi.fn(async (args: Where) => (args.where.entityType === "INVOICE" ? updates : creditNotes));
    return { db: { xeroSyncOperation: { findMany } } as never, findMany };
  }
  const booking = { bookingId: "bk-1", paymentId: "pay-1", xeroInvoiceId: "inv-1", modificationIds: ["mod-1", "mod-2"] };

  it("reads the primary invoice's updates on the payment and the booking's modifications", async () => {
    const { db, findMany } = store([skipped(3)], []);
    expect(await readPrimaryInvoiceUpdateState(booking, db)).toBe("INVOICE_AS_ISSUED");
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

  it("F2: reads the credit-note creates on the booking, its payment and its modifications, of the listed note kinds", async () => {
    const { db, findMany } = store([], [{ status: "FAILED", manuallyResolvedAt: null }]);
    expect(await readPrimaryInvoiceUpdateState(booking, db)).toBe("NOT_UPDATED");
    const creditCall = findMany.mock.calls.map(([args]) => args).find((args) => args.where.entityType === "CREDIT_NOTE");
    expect(creditCall?.where).toMatchObject({
      direction: "OUTBOUND",
      operationType: "CREATE",
      queueType: { in: ["MODIFICATION_CREDIT_NOTE", "MODIFICATION_ACCOUNT_CREDIT_NOTE", "REFUND_CREDIT_NOTE", "ACCOUNT_CREDIT_NOTE"] },
      OR: [
        { localModel: "Booking", localId: "bk-1" },
        { localModel: "Payment", localId: "pay-1" },
        { localModel: "BookingModification", localId: { in: ["mod-1", "mod-2"] } },
      ],
    });
  });

  it("shows the worse of the invoice and its credit notes", async () => {
    const failedNote = [{ status: "FAILED", manuallyResolvedAt: null }];
    expect(await readPrimaryInvoiceUpdateState(booking, store([row({ status: "PENDING" })], failedNote).db)).toBe("NOT_UPDATED");
    expect(await readPrimaryInvoiceUpdateState(booking, store([row()], [{ status: "RUNNING", manuallyResolvedAt: null }]).db)).toBe("UPDATING");
    expect(await readPrimaryInvoiceUpdateState(booking, store([row()], [{ status: "SUCCEEDED", manuallyResolvedAt: null }]).db)).toBe("CURRENT");
  });

  it("ranks an invoice kept as issued below a credit note that failed or is still on its way", async () => {
    const note = (status: string) => [{ status, manuallyResolvedAt: null }];
    expect(await readPrimaryInvoiceUpdateState(booking, store([skipped(3)], note("FAILED")).db)).toBe("NOT_UPDATED");
    expect(await readPrimaryInvoiceUpdateState(booking, store([skipped(3)], note("RUNNING")).db)).toBe("UPDATING");
    expect(await readPrimaryInvoiceUpdateState(booking, store([skipped(3)], note("SUCCEEDED")).db)).toBe("INVOICE_AS_ISSUED");
  });

  it("reads only the payment's rows when the booking has no modifications", async () => {
    const { db, findMany } = store([], []);
    await readPrimaryInvoiceUpdateState({ ...booking, modificationIds: [] }, db);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ entityType: "INVOICE", OR: [{ localModel: "Payment", localId: "pay-1" }] }) }),
    );
  });
});
