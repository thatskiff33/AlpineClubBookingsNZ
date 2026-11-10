/**
 * #4447: a live credit note's inbound sync turns off allocation links for
 * invoices Xero no longer lists, and leaves the ones it still lists active.
 * The refunded-total recount sums active links, so a removed allocation that
 * stays active is still counted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE } from "@/lib/xero-clearing-allocations";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  lock: vi.fn(),
  transaction: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroObjectLink: { findMany: mocks.findMany },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/xero-sync", () => ({
  upsertXeroObjectLink: mocks.upsert,
}));

import { retireUnlistedCreditNoteAllocations } from "@/lib/xero-inbound/retire-unlisted-credit-note-allocations";
import { xeroCreditNoteSnapshotMetadata } from "@/lib/xero-refund-note-status";

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
});
