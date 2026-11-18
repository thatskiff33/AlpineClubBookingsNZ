/**
 * #4447: a live credit note's inbound sync turns off allocation links for
 * invoices Xero no longer lists, and leaves the ones it still lists active.
 * The refunded-total recount sums active links, so a removed allocation that
 * stays active is still counted. #4449: a modification note's allocation write
 * decides its bank-transfer payment's refunded total under the Payment row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE } from "@/lib/xero-clearing-allocations";

const mocks = vi.hoisted(() => ({
  createMany: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  lock: vi.fn(),
  transaction: vi.fn(),
  upsert: vi.fn(),
  paymentFindMany: vi.fn(),
  decideLinked: vi.fn(),
  floor: vi.fn(),
  sendFloorAlert: vi.fn(),
  refundedTotalStatus: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroObjectLink: { findMany: mocks.findMany },
    payment: { findMany: mocks.paymentFindMany },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/xero-sync", () => ({
  upsertXeroObjectLink: mocks.upsert,
}));

// #4449: the whole-total decision and its floor are pinned in their own suites.
vi.mock("@/lib/xero-inbound/linked-refunded-total", () => ({ decideLinkedRefundedTotalCents: mocks.decideLinked }));
vi.mock("@/lib/xero-inbound/credit-note-bank-transfer-floor", () => ({
  bankTransferFloorCents: mocks.floor,
  sendBankTransferFloorAlert: mocks.sendFloorAlert,
}));
// The one status rule (`refundedTotalStatus`) is pinned in xero-refunded-columns.test.ts and the recount's suite.
vi.mock("@/lib/xero-inbound/modification-note-refunds", () => ({ refundedTotalStatus: mocks.refundedTotalStatus }));
vi.mock("@/lib/club-format-settings", () => ({ getClubFormat: vi.fn(async () => ({ timeZone: "Pacific/Auckland" })) }));

import {
  retireUnlistedCreditNoteAllocations,
  writeCurrentCreditNoteAllocation,
  writeCurrentCreditNoteAllocations,
  withHeldFloorAlerts,
} from "@/lib/xero-inbound/retire-unlisted-credit-note-allocations";
import { xeroCreditNoteSnapshotMetadata } from "@/lib/xero-refund-note-status";
import { getNextRefundedPaymentStatus } from "@/lib/xero-inbound/amounts";

const NOTE = "cn-removed-allocation";
const EARLY = "2026-06-30T11:00:00.000Z";
const LATE = "2026-06-30T12:00:00.000Z";

function snapshot(status: string, at: string) {
  return xeroCreditNoteSnapshotMetadata({ status, updatedDateUTC: new Date(at), total: 100 });
}

function allocation(invoiceId: string, amountCents: number, role: string, localModel = "Payment") {
  return {
    localModel,
    localId: localModel === "Payment" ? "pay-1" : "mod-1",
    xeroObjectType: "ALLOCATION",
    xeroObjectId: `alloc-${role}-${invoiceId}-${amountCents}`,
    xeroObjectNumber: null,
    xeroObjectUrl: `https://example.test/invoices/${invoiceId}`,
    role,
    metadata: { creditNoteId: NOTE, invoiceId, amountCents },
  };
}

describe("retireUnlistedCreditNoteAllocations (#4447)", () => {
  const kept = allocation("inv-1", 6_000, NOTE_ALLOCATION_ROLE);
  const removed = allocation("inv-2", 4_000, NOTE_ALLOCATION_ROLE);
  const removedRoleless = allocation("inv-2", 4_000, ROLELESS_ALLOCATION_ROLE, "BookingModification");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<boolean>) =>
      fn({
        $executeRaw: mocks.lock,
        xeroObjectLink: { findUnique: mocks.findUnique },
      }),
    );
    mocks.findUnique.mockImplementation(async ({ where }: { where: { localModel_localId_xeroObjectType_xeroObjectId_role: { xeroObjectId: string } } }) => {
      const id = where.localModel_localId_xeroObjectType_xeroObjectId_role.xeroObjectId;
      const link = [kept, removed, removedRoleless].find((candidate) => candidate.xeroObjectId === id);
      return link ? { active: true, metadata: link.metadata } : null;
    });
    mocks.upsert.mockResolvedValue({});
  });

  function liveReading(at = LATE) {
    return { status: "AUTHORISED", readingMetadata: snapshot("AUTHORISED", at) };
  }

  async function retire(options: {
    status?: string;
    readingMetadata?: unknown;
    priorSnapshots?: unknown[];
    currentSnapshots?: unknown[];
    links?: unknown[];
    listed?: string[];
  }) {
    mocks.findMany.mockImplementation(async ({ where }: { where: { xeroObjectType?: string } }) => {
      if (where.xeroObjectType === "CREDIT_NOTE") return (options.currentSnapshots ?? []).map((metadata) => ({ metadata }));
      return options.links ?? [kept, removed, removedRoleless];
    });
    return retireUnlistedCreditNoteAllocations({
      creditNoteId: NOTE,
      isModificationNote: false,
      status: options.status ?? "AUTHORISED",
      readingMetadata: options.readingMetadata ?? snapshot("AUTHORISED", LATE),
      priorSnapshots: options.priorSnapshots ?? [],
      listedInvoiceIds: new Set(options.listed ?? ["inv-1"]),
    });
  }

  it("turns off the removed invoice's links and leaves the one Xero still lists", async () => {
    const otherNote = { ...removed, xeroObjectId: "alloc-other-note", metadata: { creditNoteId: "cn-other", invoiceId: "inv-2", amountCents: 4_000 } };
    await expect(retire({ links: [kept, removed, removedRoleless, otherNote] })).resolves.toBe(2);

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          xeroObjectType: "ALLOCATION",
          active: true,
          role: { in: [NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE] },
          metadata: { path: ["creditNoteId"], equals: NOTE },
        },
      }),
    );
    const retiredIds = mocks.upsert.mock.calls.map((call) => call[0].xeroObjectId);
    expect(retiredIds).toEqual([removed.xeroObjectId, removedRoleless.xeroObjectId]);
    for (const [link, options] of mocks.upsert.mock.calls) {
      expect(link).toMatchObject({ active: false, mergeMetadata: true, xeroObjectType: "ALLOCATION" });
      expect(link.metadata).toEqual({ providerUpdatedAt: LATE });
      expect(options).toEqual({ store: expect.anything() });
    }
    expect(mocks.lock).toHaveBeenCalledTimes(2);
  });

  it("keeps an older amount on an invoice the reading still lists", async () => {
    const olderAmount = allocation("inv-1", 1_000, NOTE_ALLOCATION_ROLE);
    await expect(retire({ links: [kept, olderAmount, removed], listed: ["inv-1"] })).resolves.toBe(1);
    expect(mocks.upsert.mock.calls.map((call) => call[0].xeroObjectId)).toEqual([removed.xeroObjectId]);
  });

  it.each(["VOIDED", "DELETED"])("a %s note turns nothing off", async (status) => {
    await expect(retire({ status, links: [removed] })).resolves.toBe(0);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("a live reading a stored void already beat turns nothing off", async () => {
    await expect(retire({ priorSnapshots: [snapshot("VOIDED", LATE)], readingMetadata: snapshot("AUTHORISED", EARLY) })).resolves.toBe(0);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.findMany.mock.calls.some((call) => call[0].where.xeroObjectType === "ALLOCATION")).toBe(false);
  });

  it("a live reading older than the stored snapshot turns nothing off", async () => {
    await expect(
      retire({ priorSnapshots: [snapshot("PAID", LATE)], readingMetadata: snapshot("AUTHORISED", EARLY), links: [removed] }),
    ).resolves.toBe(0);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("a link a newer reading already stamped is left active", async () => {
    mocks.findUnique.mockResolvedValue({ active: true, metadata: { ...removed.metadata, providerUpdatedAt: LATE } });
    await expect(retire({ ...liveReading(EARLY), links: [removed], listed: [] })).resolves.toBe(0);
    expect(mocks.lock).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("an older stamp on the removed invoice is turned off", async () => {
    mocks.findUnique.mockResolvedValue({ active: true, metadata: { ...removed.metadata, providerUpdatedAt: EARLY } });
    await expect(retire({ ...liveReading(LATE), links: [removed], listed: [] })).resolves.toBe(1);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ xeroObjectId: removed.xeroObjectId, active: false, mergeMetadata: true }),
      expect.objectContaining({ store: expect.anything() }),
    );
  });

  it("an equal stamp still turns the removed invoice off", async () => {
    mocks.findUnique.mockResolvedValue({ active: true, metadata: { ...removed.metadata, providerUpdatedAt: LATE } });
    await expect(retire({ ...liveReading(LATE), links: [removed], listed: [] })).resolves.toBe(1);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("writeCurrentCreditNoteAllocation (#4447)", () => {
  const removed = allocation("inv-2", 4_000, NOTE_ALLOCATION_ROLE);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMany.mockResolvedValue({ count: 0 });
    mocks.upsert.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<boolean>) =>
      fn({
        $executeRaw: mocks.lock,
        xeroObjectLink: { findUnique: mocks.findUnique, createMany: mocks.createMany },
      }),
    );
  });

  it("does not turn a removed allocation back on when this reading is older", async () => {
    mocks.findUnique.mockResolvedValue({
      active: false,
      metadata: { ...removed.metadata, providerUpdatedAt: LATE },
    });
    await expect(
      writeCurrentCreditNoteAllocation({
        ...removed,
        metadata: { ...removed.metadata, providerUpdatedAt: EARLY },
      }),
    ).resolves.toEqual({ written: false, floorAlert: null });
    expect(mocks.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.lock).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("records the allocation again when this reading is the newer one", async () => {
    mocks.findUnique.mockResolvedValue({
      active: false,
      metadata: { ...removed.metadata, providerUpdatedAt: EARLY },
    });
    const link = { ...removed, metadata: { ...removed.metadata, providerUpdatedAt: LATE } };
    await expect(writeCurrentCreditNoteAllocation(link)).resolves.toEqual({ written: true, floorAlert: null });
    expect(mocks.upsert).toHaveBeenCalledWith(link, { store: expect.anything() });
  });
});

describe("the allocation write decides its bank-transfer payment's refunded total under the Payment row (#4449)", () => {
  const link = allocation("inv-1", 10_000, NOTE_ALLOCATION_ROLE, "BookingModification");
  const steps: string[] = [];
  // The guarded claim (`updateMany` on the row as re-read under its lock).
  const paymentUpdate = vi.fn();
  const paymentFindUnique = vi.fn();
  const paymentCount = vi.fn();
  const STORED_AT = new Date("2026-06-30T00:00:00.000Z");
  const payment = {
    id: "pay-1",
    bookingId: "booking-1",
    amountCents: 30_000,
    refundedAmountCents: 5_000,
    status: "PARTIALLY_REFUNDED",
    source: "INTERNET_BANKING",
    xeroInvoiceId: "inv-1",
    updatedAt: STORED_AT,
    booking: { organiserSettled: false },
  };
  const target = { payment: { id: "pay-1", invoiceId: "inv-1", creditNoteId: NOTE } };
  const asRead = { id: "pay-1", status: "PARTIALLY_REFUNDED", refundedAmountCents: 5_000, updatedAt: STORED_AT };
  const movedOn = () => (paymentUpdate.mock.calls[0]?.[0] as { data: { updatedAt: Date } }).data.updatedAt;

  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    mocks.lock.mockImplementation(async (sql: TemplateStringsArray) => {
      steps.push(sql.join("?").includes('FROM "Payment"') ? "lock Payment" : "lock allocation");
      return 1;
    });
    mocks.createMany.mockImplementation(async () => {
      steps.push("reserve allocation");
      return { count: 0 };
    });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockImplementation(async () => {
      steps.push("write allocation");
      return {};
    });
    paymentFindUnique.mockResolvedValue(payment);
    paymentCount.mockResolvedValue(1);
    paymentUpdate.mockResolvedValue({ count: 1 });
    mocks.decideLinked.mockImplementation(async () => {
      steps.push("decide");
      return new Map([["pay-1", 15_000]]);
    });
    mocks.floor.mockImplementation(async (_tx: unknown, input: { xeroDerivedCents: number }) => ({ cents: input.xeroDerivedCents, alert: null }));
    mocks.refundedTotalStatus.mockImplementation(async (row: { status: string; amountCents: number }, cents: number) =>
      getNextRefundedPaymentStatus(row.status, row.amountCents, cents),
    );
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: mocks.lock,
        xeroObjectLink: { findUnique: mocks.findUnique, createMany: mocks.createMany },
        payment: { findUnique: paymentFindUnique, count: paymentCount, updateMany: paymentUpdate },
      }),
    );
  });

  it("MUTATION (INV-LOCK-002): locks the Payment row before the allocation row, and decides the total after the write", async () => {
    await expect(writeCurrentCreditNoteAllocation(link, target)).resolves.toEqual({ written: true, floorAlert: null });
    expect(steps).toEqual(["lock Payment", "reserve allocation", "lock allocation", "write allocation", "decide"]);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ maxWait: expect.any(Number) }));
  });

  it("MUTATION: sets the whole total its links decide, never an increment on the stored one", async () => {
    await writeCurrentCreditNoteAllocation(link, target);
    expect(mocks.decideLinked).toHaveBeenCalledWith(expect.anything(), [payment]);
    expect(paymentUpdate).toHaveBeenCalledWith({ where: asRead, data: { refundedAmountCents: 15_000, updatedAt: expect.any(Date) } });
  });

  it("MUTATION (#4449 item 5): a written link with the total unchanged still moves updatedAt, so a recount that read the links before it loses its claim", async () => {
    mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 5_000]]));
    await writeCurrentCreditNoteAllocation(link, target);
    expect(paymentUpdate).toHaveBeenCalledWith({ where: asRead, data: { updatedAt: expect.any(Date) } });
    // Forward, even on the frozen test clock that stamped the row.
    expect(movedOn().getTime()).toBeGreaterThan(STORED_AT.getTime());
  });

  it("writes nothing to the payment when the link was not written and the total and status stand", async () => {
    mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 5_000]]));
    // A newer stamp already on the row: this reading writes no link.
    mocks.findUnique.mockResolvedValue({ active: true, metadata: snapshot("AUTHORISED", "2099-01-01T00:00:00.000Z") });
    await expect(writeCurrentCreditNoteAllocation({ ...link, metadata: { ...link.metadata, ...snapshot("AUTHORISED", EARLY) } }, target)).resolves.toEqual({ written: false, floorAlert: null });
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it("returns the floor's alert for the caller to send after the commit (INV-ADDPAY-021)", async () => {
    const alert = { paymentId: "pay-1", bookingId: "booking-1", creditNoteId: NOTE, creditNoteNumber: null, xeroDerivedCents: 15_000, floorCents: 20_000 };
    mocks.floor.mockResolvedValue({ cents: 20_000, alert });
    await expect(writeCurrentCreditNoteAllocation(link, target)).resolves.toEqual({ written: true, floorAlert: alert });
    expect(mocks.floor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ creditNoteId: NOTE, xeroDerivedCents: 15_000 }));
    expect(mocks.sendFloorAlert).not.toHaveBeenCalled();
  });

  it("MUTATION (#4449 verify, low 2): a write held at the floor returns its alert whether or not it moves the total", async () => {
    // $50 recorded on the payment, its note still in the outbox: the stored total and the detail are $50, Xero shows $0.
    const alert = { paymentId: "pay-1", bookingId: "booking-1", creditNoteId: NOTE, creditNoteNumber: null, xeroDerivedCents: 0, floorCents: 5_000 };
    mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 0]]));
    mocks.floor.mockResolvedValue({ cents: 5_000, alert });
    await expect(writeCurrentCreditNoteAllocation(link, target)).resolves.toEqual({ written: true, floorAlert: alert });
  });

  it("the sync's writes hold their alerts for after its recount, which sends only those for payments it did not decide", async () => {
    const alert = { paymentId: "pay-1", bookingId: "booking-1", creditNoteId: NOTE, creditNoteNumber: null, xeroDerivedCents: 0, floorCents: 5_000 };
    mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 0]]));
    mocks.floor.mockResolvedValue({ cents: 5_000, alert });
    mocks.paymentFindMany.mockResolvedValue([{ id: "pay-1", xeroInvoiceId: "inv-1", source: "INTERNET_BANKING" }]);
    // The recount decided pay-1 and alerted it: nothing more.
    await withHeldFloorAlerts(async (held) => {
      await writeCurrentCreditNoteAllocations([link], { isModificationNote: true, heldFloorAlerts: held.alerts });
      expect(held.alerts).toEqual([alert]);
      held.recountedPaymentIds = new Set(["pay-1"]);
    });
    expect(mocks.sendFloorAlert).not.toHaveBeenCalled();
    // A payment the recount did not decide: the write's alert, once.
    await withHeldFloorAlerts(async (held) => {
      await writeCurrentCreditNoteAllocations([link], { isModificationNote: true, heldFloorAlerts: held.alerts });
      held.recountedPaymentIds = new Set(["pay-other"]);
    });
    expect(mocks.sendFloorAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendFloorAlert).toHaveBeenCalledWith(alert, expect.anything());
  });

  it("MUTATION (#4449 verify 3): a sync that throws still sends its held alerts, and the send never masks the error", async () => {
    const alert = { paymentId: "pay-1", bookingId: "booking-1", creditNoteId: NOTE, creditNoteNumber: null, xeroDerivedCents: 0, floorCents: 5_000 };
    mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 0]]));
    mocks.floor.mockResolvedValue({ cents: 5_000, alert });
    mocks.paymentFindMany.mockResolvedValue([{ id: "pay-1", xeroInvoiceId: "inv-1", source: "INTERNET_BANKING" }]);
    const failure = new Error("the recount failed");
    await expect(
      withHeldFloorAlerts(async (held) => {
        await writeCurrentCreditNoteAllocations([link], { isModificationNote: true, heldFloorAlerts: held.alerts });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(mocks.sendFloorAlert).toHaveBeenCalledTimes(1);
    // A send that itself fails is logged, and the sync's own error still propagates.
    mocks.sendFloorAlert.mockRejectedValueOnce(new Error("mail down"));
    await expect(
      withHeldFloorAlerts(async (held) => {
        await writeCurrentCreditNoteAllocations([link], { isModificationNote: true, heldFloorAlerts: held.alerts });
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("with no holder, a write held at the floor sends its alert itself, once", async () => {
    const alert = { paymentId: "pay-1", bookingId: "booking-1", creditNoteId: NOTE, creditNoteNumber: null, xeroDerivedCents: 0, floorCents: 2_000 };
    mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 0]]));
    mocks.floor.mockResolvedValue({ cents: 2_000, alert });
    mocks.paymentFindMany.mockResolvedValue([{ id: "pay-1", xeroInvoiceId: "inv-1", source: "INTERNET_BANKING" }]);
    await writeCurrentCreditNoteAllocations([link], { isModificationNote: true });
    expect(mocks.sendFloorAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendFloorAlert).toHaveBeenCalledWith(alert, expect.anything());
  });

  it("a total falling to nothing on a payment never captured returns it to its uncaptured state", async () => {
    mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 0]]));
    mocks.refundedTotalStatus.mockResolvedValue("PENDING");
    await writeCurrentCreditNoteAllocation(link, target);
    expect(mocks.refundedTotalStatus).toHaveBeenCalledWith(payment, 0, expect.anything());
    expect(paymentUpdate).toHaveBeenCalledWith({ where: asRead, data: { refundedAmountCents: 0, status: "PENDING", updatedAt: expect.any(Date) } });
  });

  it("MUTATION (guarded claim): a claim lost under the Payment row lock throws, rolling the allocation write back with it", async () => {
    paymentUpdate.mockResolvedValue({ count: 0 });
    await expect(writeCurrentCreditNoteAllocation(link, target)).rejects.toThrow(/claim lost/);
  });

  it("decides nothing for a payment that is not a bank transfer", async () => {
    paymentFindUnique.mockResolvedValue({ ...payment, source: "STRIPE" });
    await writeCurrentCreditNoteAllocation(link, target);
    expect(mocks.decideLinked).not.toHaveBeenCalled();
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it("MUTATION (#4449 item 6): decides nothing once a second payment holds the invoice, or the payment's invoice moved, by the time the lock is held", async () => {
    paymentCount.mockResolvedValue(2);
    await writeCurrentCreditNoteAllocation(link, target);
    expect(paymentCount).toHaveBeenCalledWith({ where: { xeroInvoiceId: "inv-1" } });
    paymentCount.mockResolvedValue(1);
    paymentFindUnique.mockResolvedValue({ ...payment, xeroInvoiceId: "inv-other" });
    await writeCurrentCreditNoteAllocation(link, target);
    expect(mocks.decideLinked).not.toHaveBeenCalled();
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it("with no payment named, locks no Payment row and decides nothing", async () => {
    await writeCurrentCreditNoteAllocation(link);
    expect(steps).toEqual(["reserve allocation", "lock allocation", "write allocation"]);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), undefined);
  });

  describe("writeCurrentCreditNoteAllocations", () => {
    it("MUTATION: names the one bank-transfer payment of a modification note's invoice, and sends the floor alerts after the writes", async () => {
      const alert = { paymentId: "pay-1", bookingId: "booking-1", creditNoteId: NOTE, creditNoteNumber: null, xeroDerivedCents: 15_000, floorCents: 20_000 };
      mocks.floor.mockResolvedValue({ cents: 20_000, alert });
      mocks.paymentFindMany.mockResolvedValue([{ id: "pay-1", xeroInvoiceId: "inv-1", source: "INTERNET_BANKING" }]);
      await writeCurrentCreditNoteAllocations([link], { isModificationNote: true });
      expect(mocks.paymentFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { xeroInvoiceId: { in: ["inv-1"] } } }));
      expect(steps[0]).toBe("lock Payment");
      expect(mocks.sendFloorAlert).toHaveBeenCalledWith(alert, expect.anything());
    });

    it("names none on an invoice matched to several payments, as the repair skips it", async () => {
      mocks.paymentFindMany.mockResolvedValue([
        { id: "pay-1", xeroInvoiceId: "inv-1", source: "INTERNET_BANKING" },
        { id: "pay-2", xeroInvoiceId: "inv-1", source: "STRIPE" },
      ]);
      await writeCurrentCreditNoteAllocations([link], { isModificationNote: true });
      expect(steps).not.toContain("lock Payment");
    });

    it("names none for a card payment, nor for a note that is not a modification note", async () => {
      mocks.paymentFindMany.mockResolvedValue([{ id: "pay-1", xeroInvoiceId: "inv-1", source: "STRIPE" }]);
      await writeCurrentCreditNoteAllocations([link], { isModificationNote: true });
      await writeCurrentCreditNoteAllocations([link], { isModificationNote: false });
      expect(mocks.paymentFindMany).toHaveBeenCalledTimes(1);
      expect(steps).not.toContain("lock Payment");
      expect(mocks.sendFloorAlert).not.toHaveBeenCalled();
    });
  });

  describe("retireUnlistedCreditNoteAllocations (#4449 item 4)", () => {
    const removedLink = allocation("inv-1", 10_000, NOTE_ALLOCATION_ROLE, "BookingModification");
    function retireRemoved(isModificationNote: boolean) {
      mocks.findMany.mockImplementation(async ({ where }: { where: { xeroObjectType?: string } }) =>
        where.xeroObjectType === "CREDIT_NOTE" ? [] : [removedLink],
      );
      mocks.findUnique.mockResolvedValue({ active: true, metadata: removedLink.metadata });
      mocks.paymentFindMany.mockResolvedValue([{ id: "pay-1", xeroInvoiceId: "inv-1", source: "INTERNET_BANKING" }]);
      return retireUnlistedCreditNoteAllocations({
        creditNoteId: NOTE,
        isModificationNote,
        status: "AUTHORISED",
        readingMetadata: snapshot("AUTHORISED", LATE),
        priorSnapshots: [],
        listedInvoiceIds: new Set(),
      });
    }

    it("MUTATION: a modification note's removal takes the Payment row first and decides the total, as its write does", async () => {
      mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 0]]));
      await expect(retireRemoved(true)).resolves.toBe(1);
      expect(steps).toEqual(["lock Payment", "lock allocation", "write allocation"]);
      expect(paymentUpdate).toHaveBeenCalledWith({ where: asRead, data: { refundedAmountCents: 0, status: "SUCCEEDED", updatedAt: expect.any(Date) } });
    });

    it("#4449 verify, nit 3: a removal's floor alert names its note, read from the link before the removal rewrites it", async () => {
      mocks.decideLinked.mockResolvedValue(new Map([["pay-1", 0]]));
      mocks.floor.mockImplementation(async (_tx: unknown, input: { creditNoteId: string | null; xeroDerivedCents: number }) => ({
        cents: 2_000,
        alert: { paymentId: "pay-1", bookingId: "booking-1", creditNoteId: input.creditNoteId, creditNoteNumber: null, xeroDerivedCents: input.xeroDerivedCents, floorCents: 2_000 },
      }));
      await expect(retireRemoved(true)).resolves.toBe(1);
      expect(mocks.floor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ creditNoteId: NOTE }));
      expect(mocks.sendFloorAlert).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: NOTE }), expect.anything());
    });

    it("any other note's removal takes the allocation row only", async () => {
      await expect(retireRemoved(false)).resolves.toBe(1);
      expect(steps).toEqual(["lock allocation", "write allocation"]);
      expect(paymentUpdate).not.toHaveBeenCalled();
    });
  });
});
