import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3642 (`INV-PAY-105`): the combined group invoice's CREATE attempts. A retry
 * of one attempt keeps its key (Xero deduplicates a create that timed out after
 * it was accepted); a new attempt — after the settlement abandoned its invoice —
 * gets its own key, so the outbox never folds it onto the old attempt's running
 * row and Xero never answers it with the old invoice.
 */

const mocks = vi.hoisted(() => ({
  startOperation: vi.fn(),
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: string[]) => parts.join(":"),
  startXeroSyncOperation: mocks.startOperation,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  currentGroupSettlementInvoiceAttempt,
  enqueueXeroGroupSettlementInvoiceOperation,
  groupSettlementInvoiceCreateKey,
  groupSettlementInvoiceLink,
  groupSettlementInvoiceVoidKey,
  parseGroupSettlementInvoiceAttempt,
} from "@/lib/xero-group-settlement-invoice-outbox";

function store(opts: {
  xeroInvoiceId?: string | null;
  createKeys?: string[];
  active?: { id: string } | null;
}) {
  return {
    groupBookingSettlement: {
      findUnique: vi.fn().mockResolvedValue({
        id: "settle_1",
        xeroInvoiceId: opts.xeroInvoiceId ?? null,
      }),
    },
    xeroSyncOperation: {
      findMany: vi
        .fn()
        .mockResolvedValue((opts.createKeys ?? []).map((correlationKey) => ({ correlationKey }))),
      findFirst: vi.fn().mockResolvedValue(opts.active ?? null),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startOperation.mockResolvedValue({ id: "op_new" });
});

describe("group settlement invoice keys (#3642)", () => {
  it("keeps the pre-#3642 key for attempt 0 and numbers every later attempt", () => {
    expect(groupSettlementInvoiceCreateKey("settle_1", 0)).toBe(
      "group-settlement:settle_1:invoice:v1"
    );
    expect(groupSettlementInvoiceCreateKey("settle_1", 2)).toBe(
      "group-settlement:settle_1:invoice:attempt-2:v1"
    );
  });

  it("reads an attempt back only from a key it wrote, for that settlement", () => {
    expect(parseGroupSettlementInvoiceAttempt("settle_1", "group-settlement:settle_1:invoice:v1")).toBe(0);
    expect(
      parseGroupSettlementInvoiceAttempt("settle_1", "group-settlement:settle_1:invoice:attempt-3:v1")
    ).toBe(3);
    expect(
      parseGroupSettlementInvoiceAttempt("settle_1", "group-settlement:settle_2:invoice:attempt-3:v1")
    ).toBeNull();
    expect(
      parseGroupSettlementInvoiceAttempt("settle_1", "group-settlement:settle_1:invoice:attempt-0:v1")
    ).toBeNull();
    expect(parseGroupSettlementInvoiceAttempt("settle_1", null)).toBeNull();
  });

  it("builds one VOID key per invoice and reason, and one link shape", () => {
    expect(groupSettlementInvoiceVoidKey("settle_1", "inv_1", "abandon")).toBe(
      "group-settlement:settle_1:invoice-void-after-abandon:inv_1:v1"
    );
    expect(groupSettlementInvoiceVoidKey("settle_1", "inv_1", "cancel")).toBe(
      "group-settlement:settle_1:invoice-void-after-cancel:inv_1:v1"
    );
    expect(groupSettlementInvoiceLink("settle_1", { id: "inv_1" }, { active: false })).toMatchObject({
      localModel: "GroupBookingSettlement",
      localId: "settle_1",
      xeroObjectType: "INVOICE",
      xeroObjectId: "inv_1",
      role: "GROUP_SETTLEMENT_INVOICE",
      active: false,
    });
  });

  it("takes the highest attempt any CREATE row names", async () => {
    const db = store({
      createKeys: [
        "group-settlement:settle_1:invoice:v1",
        "group-settlement:settle_1:invoice:attempt-2:v1",
        "group-settlement:settle_1:invoice:attempt-1:v1",
      ],
    });
    await expect(currentGroupSettlementInvoiceAttempt(db as never, "settle_1")).resolves.toBe(2);
    await expect(currentGroupSettlementInvoiceAttempt(store({}) as never, "settle_1")).resolves.toBeNull();
  });
});

describe("enqueueXeroGroupSettlementInvoiceOperation (#3642)", () => {
  it("queues a settlement's first invoice as attempt 0", async () => {
    const db = store({});

    await expect(
      enqueueXeroGroupSettlementInvoiceOperation("settle_1", { newAttempt: true, store: db as never })
    ).resolves.toEqual({
      queueOperationId: "op_new",
      message: "Xero settlement invoice queued for background processing.",
    });
    expect(mocks.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: "CREATE",
        localModel: "GroupBookingSettlement",
        localId: "settle_1",
        correlationKey: "group-settlement:settle_1:invoice:v1",
        idempotencyKey: "group-settlement:settle_1:invoice:v1",
        requestPayload: { queueType: "GROUP_SETTLEMENT_INVOICE", settlementId: "settle_1" },
      })
    );
  });

  it("queues a NEW attempt under its own key, even while the old attempt's row is running", async () => {
    const db = store({
      createKeys: ["group-settlement:settle_1:invoice:v1"],
      active: { id: "op_old_running" },
    });

    await enqueueXeroGroupSettlementInvoiceOperation("settle_1", { newAttempt: true, store: db as never });

    expect(db.xeroSyncOperation.findFirst).not.toHaveBeenCalled();
    expect(mocks.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({ correlationKey: "group-settlement:settle_1:invoice:attempt-1:v1" })
    );
  });

  it("returns the current attempt's active row when the settlement asks for the same invoice again", async () => {
    const db = store({
      createKeys: ["group-settlement:settle_1:invoice:attempt-1:v1"],
      active: { id: "op_running" },
    });

    await expect(
      enqueueXeroGroupSettlementInvoiceOperation("settle_1", { newAttempt: false, store: db as never })
    ).resolves.toMatchObject({ queueOperationId: "op_running" });
    expect(db.xeroSyncOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          correlationKey: "group-settlement:settle_1:invoice:attempt-1:v1",
          status: { in: ["PENDING", "RUNNING"] },
        }),
      })
    );
    expect(mocks.startOperation).not.toHaveBeenCalled();
  });

  it("re-drives a failed attempt under the SAME key, so Xero replays an invoice it already raised", async () => {
    const db = store({ createKeys: ["group-settlement:settle_1:invoice:attempt-1:v1"] });

    await enqueueXeroGroupSettlementInvoiceOperation("settle_1", { newAttempt: false, store: db as never });

    expect(mocks.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({ correlationKey: "group-settlement:settle_1:invoice:attempt-1:v1" })
    );
  });

  it("queues nothing when the settlement's pointer says its invoice is already raised", async () => {
    const db = store({ xeroInvoiceId: "inv_1" });

    await expect(
      enqueueXeroGroupSettlementInvoiceOperation("settle_1", { newAttempt: false, store: db as never })
    ).resolves.toEqual({
      queueOperationId: null,
      message: "Xero settlement invoice already linked for this group.",
    });
    expect(mocks.startOperation).not.toHaveBeenCalled();
  });
});
