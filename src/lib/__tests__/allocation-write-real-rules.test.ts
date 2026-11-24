import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4449 verify, nit 4: the credit-note allocation write and its removal run
 * through the REAL columns step - the real bank-transfer floor
 * (`bankTransferFloorCents`, `INV-ADDPAY-021`) and the real refunded-total
 * status rule (`refundedTotalStatus`, #3979) - on a faked transaction. Only
 * the links' figure (`decideLinkedRefundedTotalCents`, pinned in its own
 * suites) and the link funnel are stubbed. The real-database removal races
 * are in `kept-settle-queued-cancel.realdb.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  paymentFindMany: vi.fn(),
  linkFindMany: vi.fn(),
  upsert: vi.fn(),
  decideLinked: vi.fn(),
  sendFloorAlert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction, payment: { findMany: mocks.paymentFindMany }, xeroObjectLink: { findMany: mocks.linkFindMany } },
}));
vi.mock("@/lib/xero-sync", () => ({ upsertXeroObjectLink: mocks.upsert }));
vi.mock("@/lib/xero-inbound/linked-refunded-total", () => ({ decideLinkedRefundedTotalCents: mocks.decideLinked }));
vi.mock("@/lib/xero-inbound/credit-note-bank-transfer-floor", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-inbound/credit-note-bank-transfer-floor")),
  sendBankTransferFloorAlert: mocks.sendFloorAlert,
}));
vi.mock("@/lib/club-format-settings", () => ({ getClubFormat: vi.fn(async () => ({ timeZone: "Pacific/Auckland" })) }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { retireUnlistedCreditNoteAllocations, writeCurrentCreditNoteAllocations } from "@/lib/xero-inbound/retire-unlisted-credit-note-allocations";
import { NOTE_ALLOCATION_ROLE } from "@/lib/xero-clearing-allocations";
import { xeroCreditNoteSnapshotMetadata } from "@/lib/xero-refund-note-status";

const NOTE = "cn-correction";
const STORED_AT = new Date("2026-06-30T00:00:00.000Z");
const allocation = {
  localModel: "BookingModification",
  localId: "mod-1",
  xeroObjectType: "ALLOCATION",
  xeroObjectId: "alloc-1",
  role: NOTE_ALLOCATION_ROLE,
  metadata: { creditNoteId: NOTE, invoiceId: "inv-1", amountCents: 3_000 },
};

/** A bank transfer invoiced at $300 and never paid (its PRIMARY row PENDING), $30 counted refunded by an older fold. */
function arrange(input: { refundedAmountCents: number; status: string; detailCents: number }) {
  const payment = {
    id: "pay-1",
    bookingId: "booking-1",
    amountCents: 30_000,
    refundedAmountCents: input.refundedAmountCents,
    status: input.status,
    source: "INTERNET_BANKING",
    xeroInvoiceId: "inv-1",
    updatedAt: STORED_AT,
    booking: { organiserSettled: false },
  };
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    xeroObjectLink: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue({ active: true, metadata: allocation.metadata }),
      // The floor's voided-note check: no refund note on the payment.
      findMany: vi.fn().mockResolvedValue([]),
    },
    payment: { findUnique: vi.fn().mockResolvedValue(payment), count: vi.fn().mockResolvedValue(1), updateMany },
    paymentTransaction: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { refundedAmountCents: input.detailCents } }),
      findMany: vi.fn().mockResolvedValue([{ kind: "PRIMARY", status: "PENDING", createdAt: new Date("2026-06-01T00:00:00.000Z"), insertionSeq: 1 }]),
    },
  };
  mocks.transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));
  mocks.paymentFindMany.mockResolvedValue([{ id: "pay-1", xeroInvoiceId: "inv-1", source: "INTERNET_BANKING" }]);
  mocks.linkFindMany.mockImplementation(async ({ where }: { where: { xeroObjectType?: string } }) =>
    where.xeroObjectType === "CREDIT_NOTE" ? [] : [allocation],
  );
  return { updateMany };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsert.mockResolvedValue({});
});

describe("the allocation write and its removal through the real floor and status rule (#4449)", () => {
  it("MUTATION (#3979): removing the correction's allocation returns a never-captured payment to its uncaptured status, total 0", async () => {
    const { updateMany } = arrange({ refundedAmountCents: 3_000, status: "PARTIALLY_REFUNDED", detailCents: 0 });
    mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 0]]));

    await expect(
      retireUnlistedCreditNoteAllocations({
        creditNoteId: NOTE,
        isModificationNote: true,
        status: "AUTHORISED",
        readingMetadata: xeroCreditNoteSnapshotMetadata({ status: "AUTHORISED", updatedDateUTC: new Date("2026-06-30T12:00:00.000Z"), total: 30 }),
        priorSnapshots: [],
        listedInvoiceIds: new Set(),
      }),
    ).resolves.toBe(1);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", status: "PARTIALLY_REFUNDED", refundedAmountCents: 3_000, updatedAt: STORED_AT },
      data: { refundedAmountCents: 0, status: "PENDING", updatedAt: expect.any(Date) },
    });
    expect(mocks.sendFloorAlert).not.toHaveBeenCalled();
  });

  it("writing the allocation sets the total the links decide, and the status the rule gives it", async () => {
    const { updateMany } = arrange({ refundedAmountCents: 0, status: "PENDING", detailCents: 0 });
    mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 3_000]]));

    await writeCurrentCreditNoteAllocations([allocation], { isModificationNote: true });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { refundedAmountCents: 3_000, status: "PARTIALLY_REFUNDED", updatedAt: expect.any(Date) } }),
    );
  });

  it("#4449 verify, low 2: held at the floor with the total unmoved, the real floor's alert is held for the sync, not sent by the write", async () => {
    // $50 recorded and in the detail, its note still in the outbox: Xero shows $0. The recount alerts this once.
    const { updateMany } = arrange({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED", detailCents: 5_000 });
    mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 0]]));

    const held: unknown[] = [];
    await writeCurrentCreditNoteAllocations([allocation], { isModificationNote: true, heldFloorAlerts: held as never });

    // The link was written, so only updatedAt moves; the total stays at the floor.
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { updatedAt: expect.any(Date) } }));
    expect(held).toEqual([expect.objectContaining({ paymentId: "pay-1", creditNoteId: NOTE, xeroDerivedCents: 0, floorCents: 5_000 })]);
    expect(mocks.sendFloorAlert).not.toHaveBeenCalled();
  });
});

// #4444 (plan deviation, step 3): the count-once rule sits in the shared figure,
// so it reaches the bank allocation write too. Here that figure runs for real,
// on the write's own transaction.
describe("the allocation write with a note the payment also links as its refund note (#4444)", () => {
  /** Every read the real figure makes that this case does not set answers nothing. */
  const emptyModel = (overrides: Record<string, unknown> = {}) =>
    new Proxy(overrides, {
      get: (target, method: string) =>
        method in target ? target[method] : vi.fn(async () => (method === "findMany" ? [] : method === "aggregate" ? { _sum: {} } : null)),
    });

  it("MUTATION: a bank note linked as the payment's refund note and allocated to its invoice is written once, $30 not $60", async () => {
    const { decideLinkedRefundedTotalCents } = (await vi.importActual("@/lib/xero-inbound/linked-refunded-total")) as typeof import("@/lib/xero-inbound/linked-refunded-total");
    mocks.decideLinked.mockImplementation(decideLinkedRefundedTotalCents);
    arrange({ refundedAmountCents: 0, status: "SUCCEEDED", detailCents: 0 });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const payment = {
      id: "pay-1", bookingId: "booking-1", amountCents: 30_000, refundedAmountCents: 0, status: "SUCCEEDED",
      source: "INTERNET_BANKING", xeroInvoiceId: "inv-1", updatedAt: STORED_AT, booking: { organiserSettled: false },
    };
    const refundNoteLink = { localId: "pay-1", xeroObjectId: NOTE, metadata: { amountCents: 3_000, status: "AUTHORISED", total: 30 } };
    const linkReads = vi.fn(async ({ where }: { where: { xeroObjectType?: string; role?: unknown; localModel?: string } }) => {
      if (where.xeroObjectType === "ALLOCATION") {
        // The payment's own allocation links: none. By its invoice: the note's allocation, on the edit.
        return where.localModel === "Payment" ? [] : [{ ...allocation, updatedAt: STORED_AT }];
      }
      if (where.role === "MODIFICATION_CREDIT_NOTE") return [{ xeroObjectId: NOTE, metadata: { status: "AUTHORISED" } }];
      const roles = (where.role as { in?: string[] } | undefined)?.in;
      if (where.localModel === "Payment" && roles?.includes("REFUND_CREDIT_NOTE")) return [refundNoteLink];
      return [];
    });
    const tx = new Proxy(
      {
        $executeRaw: vi.fn().mockResolvedValue(1),
        xeroObjectLink: emptyModel({
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn().mockResolvedValue({ active: true, metadata: allocation.metadata }),
          findMany: linkReads,
        }),
        payment: emptyModel({ findUnique: vi.fn().mockResolvedValue(payment), count: vi.fn().mockResolvedValue(1), updateMany }),
        paymentTransaction: emptyModel({
          aggregate: vi.fn().mockResolvedValue({ _sum: { refundedAmountCents: 0 } }),
          findMany: vi.fn().mockResolvedValue([{ kind: "PRIMARY", status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z"), insertionSeq: 1 }]),
        }),
        // A cash note: neither a give-back nor an invoice correction.
        xeroSyncOperation: emptyModel({ findMany: vi.fn().mockResolvedValue([{ xeroObjectId: NOTE, requestPayload: { refundMethod: "internet-banking" } }]) }),
      } as Record<string, unknown>,
      { get: (target, model: string) => (model in target ? target[model] : emptyModel()) },
    );
    mocks.transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));

    await writeCurrentCreditNoteAllocations([allocation], { isModificationNote: true });

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ refundedAmountCents: 3_000 }) }));
  });
});
