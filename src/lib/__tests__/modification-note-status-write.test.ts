/**
 * #5251 (`INV-PAY-126`, `INV-LOCK-002`): the inbound sync writes a
 * modification note's own status under the Payment rows the note is counted
 * on, ids sorted, and decides each total again under them. The race itself is
 * proved on PostgreSQL in `kept-settle-queued-cancel.realdb.test.ts`; this
 * pins the order of the steps and which writes take the rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  transaction: vi.fn(),
  lock: vi.fn(),
  upsert: vi.fn(),
  paymentsOfNote: vi.fn(),
  decide: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { xeroObjectLink: { findMany: mocks.findMany }, $transaction: mocks.transaction } }));
vi.mock("@/lib/payment-transactions", () => ({
  lockPaymentForRefundedTotal: mocks.lock,
  PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS: { maxWait: 10_000, timeout: 30_000 },
}));
vi.mock("@/lib/xero-sync", () => ({ upsertXeroObjectLink: mocks.upsert }));
vi.mock("@/lib/xero-inbound/bank-transfer-payment-of-invoice", () => ({ bankTransferPaymentsOfNoteAllocations: mocks.paymentsOfNote }));
vi.mock("@/lib/xero-inbound/retire-unlisted-credit-note-allocations", () => ({ decideBankTransferRefundedTotal: mocks.decide }));

import { writeCreditNoteLinks } from "@/lib/xero-inbound/modification-note-status-write";

const NOTE = "cn-voided";
const TX = { tx: true };
const noteLink = (status: string, localId = "mod-1") => ({
  localModel: "BookingModification", localId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, role: "MODIFICATION_CREDIT_NOTE", metadata: { status }, mergeMetadata: true,
});
const refundLink = { localModel: "Payment", localId: "pay-9", xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, role: "REFUND_CREDIT_NOTE", metadata: { status: "VOIDED" } };
const stored = (status: string | undefined, active = true, localId = "mod-1") => ({ localModel: "BookingModification", localId, active, metadata: status ? { status } : null });
const allocation = (invoiceId: string, paymentId: string | null) => ({ link: {}, invoiceId, paymentId });
const floorAlert = (paymentId: string) => ({ paymentId, bookingId: "booking-1", creditNoteId: NOTE, creditNoteNumber: null, xeroDerivedCents: 0, floorCents: 5_000 });

describe("writeCreditNoteLinks (#5251)", () => {
  let steps: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    steps = [];
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>, options: unknown) => {
      steps.push(`begin ${JSON.stringify(options ?? null)}`);
      try {
        const result = await run(TX);
        steps.push("commit");
        return result;
      } catch (err) {
        steps.push("rollback");
        throw err;
      }
    });
    mocks.lock.mockImplementation(async (_tx: unknown, paymentId: string) => void steps.push(`lock ${paymentId}`));
    mocks.upsert.mockImplementation(async (link: { localId: string }, options?: { store?: unknown }) => void steps.push(`write ${link.localId}${options?.store === TX ? " in tx" : ""}`));
    mocks.decide.mockImplementation(async (_tx: unknown, payment: { id: string }) => {
      steps.push(`decide ${payment.id}`);
      return null;
    });
    mocks.findMany.mockResolvedValue([stored("AUTHORISED")]);
    mocks.paymentsOfNote.mockResolvedValue([allocation("inv-b", "pay-b"), allocation("inv-a", "pay-a"), allocation("inv-none", null)]);
  });

  it("MUTATION (Payment rows first, sorted): a void takes each named payment's row, then writes the status, then decides each total, in one transaction with the Payment-row wait budget", async () => {
    const held: ReturnType<typeof floorAlert>[] = [];
    mocks.decide.mockImplementation(async (_tx: unknown, payment: { id: string }) => {
      steps.push(`decide ${payment.id}`);
      return payment.id === "pay-a" ? floorAlert("pay-a") : null;
    });
    await writeCreditNoteLinks(NOTE, [noteLink("VOIDED")], held);
    expect(steps).toEqual([
      'begin {"maxWait":10000,"timeout":30000}', "lock pay-a", "lock pay-b", "write mod-1 in tx", "decide pay-b", "decide pay-a", "commit",
    ]);
    // Decided as a write of the link: the row's `updatedAt` moves, so a lock-free recount that read the old status decides again.
    expect(mocks.decide).toHaveBeenCalledWith(TX, { id: "pay-b", invoiceId: "inv-b", creditNoteId: NOTE }, true);
    expect(held).toEqual([floorAlert("pay-a")]);
  });

  it("a live reading over a live link changes nothing the total reads: the funnel's own write, no Payment row", async () => {
    await writeCreditNoteLinks(NOTE, [noteLink("PAID")], []);
    expect(steps).toEqual(["write mod-1"]);
    expect(mocks.paymentsOfNote).not.toHaveBeenCalled();
  });

  it.each([
    ["a link stored cancelled", [stored("VOIDED")]],
    ["a link stored off", [stored("AUTHORISED", false)]],
    ["a missing link", []],
  ])("MUTATION (either direction): a live reading over %s takes the rows too", async (_name, rows) => {
    mocks.findMany.mockResolvedValue(rows);
    await writeCreditNoteLinks(NOTE, [noteLink("AUTHORISED")], []);
    expect(steps.slice(1, 4)).toEqual(["lock pay-a", "lock pay-b", "write mod-1 in tx"]);
  });

  it("a write that names no status keeps the stored one, so it changes nothing", async () => {
    mocks.findMany.mockResolvedValue([stored("VOIDED")]);
    await writeCreditNoteLinks(NOTE, [{ ...noteLink("x"), metadata: { total: 1 } }], []);
    expect(steps).toEqual(["write mod-1"]);
  });

  it("the note's other links keep the funnel's own write, and several note links are written in one fixed order", async () => {
    mocks.findMany.mockResolvedValue([stored("AUTHORISED"), stored("AUTHORISED", true, "mod-0")]);
    await writeCreditNoteLinks(NOTE, [noteLink("VOIDED"), refundLink, noteLink("VOIDED", "mod-0")], []);
    expect(steps).toEqual([
      "write pay-9", 'begin {"maxWait":10000,"timeout":30000}', "lock pay-a", "lock pay-b", "write mod-0 in tx", "write mod-1 in tx", "decide pay-b", "decide pay-a", "commit",
    ]);
  });

  it("a note no bank-transfer payment counts still writes its status in one transaction, with no row and no decision", async () => {
    mocks.paymentsOfNote.mockResolvedValue([allocation("inv-none", null)]);
    await writeCreditNoteLinks(NOTE, [noteLink("VOIDED")], []);
    expect(steps).toEqual(["begin null", "write mod-1 in tx", "commit"]);
  });

  it("MUTATION (re-read under the rows): an allocation committed after the first read names a payment not held: the write rolls back and runs again with that row", async () => {
    mocks.paymentsOfNote
      .mockResolvedValueOnce([allocation("inv-a", "pay-a")])
      .mockResolvedValueOnce([allocation("inv-a", "pay-a"), allocation("inv-c", "pay-c")])
      .mockResolvedValue([allocation("inv-a", "pay-a"), allocation("inv-c", "pay-c")]);
    await writeCreditNoteLinks(NOTE, [noteLink("VOIDED")], []);
    expect(steps).toEqual([
      'begin {"maxWait":10000,"timeout":30000}', "lock pay-a", "write mod-1 in tx", "rollback",
      'begin {"maxWait":10000,"timeout":30000}', "lock pay-a", "lock pay-c", "write mod-1 in tx", "decide pay-a", "decide pay-c", "commit",
    ]);
    // The second read is on the transaction, so it sees what committed before the rows were taken.
    expect(mocks.paymentsOfNote.mock.calls.map(([, db]) => db === TX)).toEqual([false, true, false, true]);
  });

  it("allocations that keep changing fail the event for its retry, with nothing written", async () => {
    let reads = 0;
    mocks.paymentsOfNote.mockImplementation(async (_id: string, db?: unknown) => (db === TX ? [allocation(`inv-${(reads += 1)}`, `pay-${reads}`)] : []));
    await expect(writeCreditNoteLinks(NOTE, [noteLink("VOIDED")], [])).rejects.toThrow(/allocations kept changing/);
    expect(steps.filter((step) => step === "rollback")).toHaveLength(3);
    expect(steps).not.toContain("commit");
  });
});
