import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settlementFindUnique: vi.fn(),
  operationFindFirst: vi.fn(),
  startOperation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBookingSettlement: { findUnique: mocks.settlementFindUnique },
    xeroSyncOperation: { findFirst: mocks.operationFindFirst },
  },
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn((...parts: string[]) => parts.join(":")),
  startXeroSyncOperation: mocks.startOperation,
}));

import {
  abandonGroupSettlementInvoiceInTx,
  enqueueXeroGroupSettlementInvoiceAbandonVoidOperation,
  enqueueXeroGroupSettlementInvoiceVoidOperation,
} from "@/lib/xero-group-settlement-void-outbox";

describe("enqueueXeroGroupSettlementInvoiceVoidOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settlementFindUnique.mockResolvedValue({
      id: "settle-1",
      xeroInvoiceId: "inv-1",
      groupBooking: { status: "CANCELLED" },
    });
    mocks.operationFindFirst.mockResolvedValue(null);
    mocks.startOperation.mockResolvedValue({ id: "void-op-1" });
  });

  it("creates a replayable UPDATE operation with a stable invoice-specific key", async () => {
    await expect(
      enqueueXeroGroupSettlementInvoiceVoidOperation("settle-1")
    ).resolves.toEqual({
      queueOperationId: "void-op-1",
      message: "Xero group invoice VOID queued for background processing.",
    });

    expect(mocks.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "INVOICE",
        operationType: "UPDATE",
        localModel: "GroupBookingSettlement",
        localId: "settle-1",
        status: "PENDING",
        correlationKey:
          "group-settlement:settle-1:invoice-void-after-cancel:inv-1:v1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE_VOID",
          settlementId: "settle-1",
        },
      })
    );
  });

  it("returns the active winner instead of minting duplicate retry debt", async () => {
    mocks.operationFindFirst.mockResolvedValue({ id: "void-op-existing" });

    await expect(
      enqueueXeroGroupSettlementInvoiceVoidOperation("settle-1")
    ).resolves.toEqual({
      queueOperationId: "void-op-existing",
      message: "Xero group invoice VOID is already queued.",
    });
    expect(mocks.startOperation).not.toHaveBeenCalled();
  });

  it("queues nothing without both durable CANCELLED and a persisted invoice", async () => {
    mocks.settlementFindUnique
      .mockResolvedValueOnce({
        id: "settle-1",
        xeroInvoiceId: "inv-1",
        groupBooking: { status: "OPEN" },
      })
      .mockResolvedValueOnce({
        id: "settle-1",
        xeroInvoiceId: null,
        groupBooking: { status: "CANCELLED" },
      });

    await expect(
      enqueueXeroGroupSettlementInvoiceVoidOperation("settle-1")
    ).resolves.toMatchObject({ queueOperationId: null });
    await expect(
      enqueueXeroGroupSettlementInvoiceVoidOperation("settle-1")
    ).resolves.toMatchObject({ queueOperationId: null });
    expect(mocks.startOperation).not.toHaveBeenCalled();
  });
});

// #3642 (INV-PAY-106): the VOID of an invoice a LIVE group's settlement
// abandoned. The group is not cancelled, so the invoice is named by the
// operation rather than read back off the settlement.
describe("abandoned group settlement invoices (#3642)", () => {
  function fakeTx() {
    return {
      xeroSyncOperation: { findFirst: vi.fn().mockResolvedValue(null) },
      groupBookingSettlement: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      xeroObjectLink: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startOperation.mockResolvedValue({ id: "void-op-2" });
  });

  it("queues an invoice-specific VOID that carries the invoice id, inside the caller's transaction", async () => {
    const tx = fakeTx();

    await expect(
      enqueueXeroGroupSettlementInvoiceAbandonVoidOperation("settle-1", "inv-1", {
        store: tx as never,
      })
    ).resolves.toEqual({
      queueOperationId: "void-op-2",
      message: "Xero group invoice VOID queued for background processing.",
    });
    expect(mocks.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: "UPDATE",
        localModel: "GroupBookingSettlement",
        localId: "settle-1",
        correlationKey: "group-settlement:settle-1:invoice-void-after-abandon:inv-1:v1",
        requestPayload: {
          queueType: "GROUP_SETTLEMENT_INVOICE_VOID",
          settlementId: "settle-1",
          xeroInvoiceId: "inv-1",
        },
        store: tx,
      })
    );
  });

  it("converges repeat observers of one abandoned invoice on the active VOID row", async () => {
    const tx = fakeTx();
    tx.xeroSyncOperation.findFirst.mockResolvedValue({ id: "void-op-existing" });

    await expect(
      enqueueXeroGroupSettlementInvoiceAbandonVoidOperation("settle-1", "inv-1", {
        store: tx as never,
      })
    ).resolves.toMatchObject({ queueOperationId: "void-op-existing" });
    expect(mocks.startOperation).not.toHaveBeenCalled();
  });

  it("retires the invoice in one step: VOID queued, pointer cleared only if unchanged, link deactivated but kept", async () => {
    const tx = fakeTx();

    await abandonGroupSettlementInvoiceInTx(tx as never, {
      settlementId: "settle-1",
      xeroInvoiceId: "inv-1",
    });

    expect(mocks.startOperation).toHaveBeenCalledTimes(1);
    expect(tx.groupBookingSettlement.updateMany).toHaveBeenCalledWith({
      where: { id: "settle-1", xeroInvoiceId: "inv-1" },
      data: { xeroInvoiceId: null, xeroInvoiceNumber: null },
    });
    expect(tx.xeroObjectLink.updateMany).toHaveBeenCalledWith({
      where: {
        localModel: "GroupBookingSettlement",
        localId: "settle-1",
        xeroObjectType: "INVOICE",
        xeroObjectId: "inv-1",
        role: "GROUP_SETTLEMENT_INVOICE",
        active: true,
      },
      data: { active: false },
    });
  });

  it("keeps the settlement's clock when asked to", async () => {
    const tx = fakeTx();
    const updatedAt = new Date("2026-08-01T00:00:00.000Z");

    await abandonGroupSettlementInvoiceInTx(tx as never, {
      settlementId: "settle-1",
      xeroInvoiceId: "inv-1",
      preserveUpdatedAt: updatedAt,
    });

    expect(tx.groupBookingSettlement.updateMany).toHaveBeenCalledWith({
      where: { id: "settle-1", xeroInvoiceId: "inv-1" },
      data: { xeroInvoiceId: null, xeroInvoiceNumber: null, updatedAt },
    });
  });
});
