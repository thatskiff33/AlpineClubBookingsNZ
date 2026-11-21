import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Overpayment, Prepayment } from "xero-node";
import type { XeroCashCreditKind } from "@prisma/client";

// #5204: the cash-credit refresh and queue with the provider and the database
// stubbed. The real-database write and race cases are
// `xero-cash-credits-sync.realdb.test.ts`; the stubbed-database cases below keep
// the write and queue functions inside unit coverage.
const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  call: vi.fn(),
  client: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: { xeroCashCredit: { findMany: h.findMany } } }));
vi.mock("@/lib/xero-api-client", () => ({ callXeroApi: h.call, getAuthenticatedXeroClient: h.client }));

import {
  applyXeroCashCreditSnapshot,
  listXeroCashCreditQueue,
  readXeroCashCreditDocuments,
  refreshXeroCashCredits,
  XERO_CASH_CREDIT_MAX_PAGES,
  XERO_CASH_CREDIT_PAGE_SIZE,
  XeroCashCreditReadError,
  xeroCashCreditDocumentFrom,
  type XeroCashCreditReader,
} from "@/lib/xero-cash-credits";

type Raw = Overpayment | Prepayment;

function overpayment(id: string, extra: Record<string, unknown> = {}): Raw {
  return {
    overpaymentID: id, type: "RECEIVE-OVERPAYMENT", status: "AUTHORISED", contact: { contactID: "contact-1" },
    currencyCode: "NZD", date: "2026-06-20", total: 200, remainingCredit: 123.45, ...extra,
  } as unknown as Raw;
}

function prepayment(id: string, extra: Record<string, unknown> = {}): Raw {
  return {
    prepaymentID: id, type: "RECEIVE-PREPAYMENT", status: "AUTHORISED", contact: { contactID: "contact-2" },
    currencyCode: "NZD", total: 50, remainingCredit: 50, ...extra,
  } as unknown as Raw;
}

/** A reader over fixed pages per kind, and fixed by-id answers. */
function readerOf(
  pages: Partial<Record<XeroCashCreditKind, Raw[][]>>,
  byId: Record<string, Raw | null> = {},
): XeroCashCreditReader & { readPage: ReturnType<typeof vi.fn>; readOne: ReturnType<typeof vi.fn> } {
  return {
    readPage: vi.fn(async (kind: XeroCashCreditKind, page: number) => pages[kind]?.[page - 1] ?? []),
    readOne: vi.fn(async (_kind: XeroCashCreditKind, id: string) => byId[id] ?? null),
  };
}

const fullPage = (make: (id: string) => Raw, prefix: string) =>
  Array.from({ length: XERO_CASH_CREDIT_PAGE_SIZE }, (_, i) => make(`${prefix}-${i}`));

const db = { xeroCashCredit: { findMany: h.findMany } } as never;

describe("xeroCashCreditDocumentFrom (#5204)", () => {
  it("reads an open receive overpayment in integer cents with its calendar date", () => {
    expect(xeroCashCreditDocumentFrom("OVERPAYMENT", overpayment(" op-1 "))).toEqual({
      kind: "OVERPAYMENT", xeroDocumentId: "op-1", xeroContactId: "contact-1", currencyCode: "NZD",
      documentDate: new Date("2026-06-20T00:00:00.000Z"), totalCents: 20_000, remainingCents: 12_345,
    });
  });

  it("reads a prepayment by its own id field, with no date as null", () => {
    expect(xeroCashCreditDocumentFrom("PREPAYMENT", prepayment("pp-1"))).toMatchObject({
      kind: "PREPAYMENT", xeroDocumentId: "pp-1", documentDate: null, totalCents: 5_000, remainingCents: 5_000,
    });
  });

  it.each([
    ["a spend overpayment", overpayment("op", { type: "SPEND-OVERPAYMENT" })],
    ["a voided overpayment", overpayment("op", { status: "VOIDED" })],
    ["a prepayment read as an overpayment", prepayment("pp")],
  ])("skips %s: it is not money held for a contact", (_label, raw) => {
    expect(xeroCashCreditDocumentFrom("OVERPAYMENT", raw)).toBeNull();
  });

  it.each([
    ["no id", { overpaymentID: "  " }],
    ["no contact", { contact: undefined }],
    ["no currency", { currencyCode: undefined }],
    ["no total", { total: undefined }],
    ["a non-numeric balance", { remainingCredit: "12" }],
    ["a negative total", { total: -1 }],
    ["a negative balance", { remainingCredit: -0.01 }],
  ])("refuses an open receive document with %s, so nothing is refreshed", (_label, extra) => {
    expect(() => xeroCashCreditDocumentFrom("OVERPAYMENT", overpayment("op-bad", extra))).toThrow(XeroCashCreditReadError);
  });
});

describe("readXeroCashCreditDocuments (#5204)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findMany.mockResolvedValue([]);
  });

  it("reads one short page of each kind and never consults the snapshot", async () => {
    const reader = readerOf({ OVERPAYMENT: [[overpayment("op-1"), overpayment("op-spend", { type: "SPEND-OVERPAYMENT" })]], PREPAYMENT: [[prepayment("pp-1")]] });
    const documents = await readXeroCashCreditDocuments(reader, db);
    expect(documents.map((d) => d.xeroDocumentId)).toEqual(["op-1", "pp-1"]);
    expect(reader.readPage.mock.calls).toEqual([["OVERPAYMENT", 1], ["PREPAYMENT", 1]]);
    expect(h.findMany).not.toHaveBeenCalled();
    expect(reader.readOne).not.toHaveBeenCalled();
  });

  it("after a multi-page list, re-reads stored open documents the list skipped, keeping only open ones", async () => {
    const reader = readerOf(
      { OVERPAYMENT: [fullPage(overpayment, "op"), [overpayment("op-last")]] },
      { "op-moved": overpayment("op-moved"), "op-spent": overpayment("op-spent", { status: "PAID" }), "op-gone": null },
    );
    h.findMany.mockResolvedValue([{ xeroDocumentId: "op-gone" }, { xeroDocumentId: "op-moved" }, { xeroDocumentId: "op-spent" }]);
    const documents = await readXeroCashCreditDocuments(reader, db);
    const ids = documents.map((d) => d.xeroDocumentId);
    expect(ids).toHaveLength(XERO_CASH_CREDIT_PAGE_SIZE + 2);
    expect(ids).toContain("op-moved");
    expect(ids).not.toContain("op-spent");
    expect(h.findMany).toHaveBeenCalledTimes(1);
    expect(h.findMany.mock.calls[0][0].where).toMatchObject({ kind: "OVERPAYMENT", remainingCents: { gt: 0 } });
    expect(h.findMany.mock.calls[0][0].where.xeroDocumentId.notIn).toContain("op-last");
    expect(reader.readOne.mock.calls.map((c) => c[1])).toEqual(["op-gone", "op-moved", "op-spent"]);
  });

  it("refuses a list longer than the page cap rather than truncating it", async () => {
    const reader: XeroCashCreditReader = {
      readPage: vi.fn(async (_kind, page) => fullPage(overpayment, `op-p${page}`)),
      readOne: vi.fn(),
    };
    await expect(readXeroCashCreditDocuments(reader, db)).rejects.toThrow(XeroCashCreditReadError);
    expect(reader.readPage).toHaveBeenCalledTimes(XERO_CASH_CREDIT_MAX_PAGES);
  });

  it("passes a failed page straight out: nothing is returned from a partial read", async () => {
    const reader = readerOf({});
    reader.readPage.mockResolvedValueOnce([overpayment("op-1")]).mockRejectedValueOnce(new Error("Xero page failed"));
    await expect(readXeroCashCreditDocuments(reader, db)).rejects.toThrow("Xero page failed");
  });
});

describe("the live Xero reader (#5204)", () => {
  const accountingApi = {
    getOverpayments: vi.fn(), getPrepayments: vi.fn(), getOverpayment: vi.fn(), getPrepayment: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.findMany.mockResolvedValue([]);
    h.client.mockResolvedValue({ xero: { accountingApi }, tenantId: "tenant" });
    h.call.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  it("lists open documents of both kinds with the breaker left alone", async () => {
    accountingApi.getOverpayments.mockResolvedValue({ body: { overpayments: [overpayment("op-1")] } });
    accountingApi.getPrepayments.mockResolvedValue({ body: { prepayments: [prepayment("pp-1")] } });
    const documents = await readXeroCashCreditDocuments();
    expect(documents.map((d) => d.xeroDocumentId)).toEqual(["op-1", "pp-1"]);
    expect(accountingApi.getOverpayments).toHaveBeenCalledWith("tenant", undefined, 'Status=="AUTHORISED"', undefined, 1, undefined, XERO_CASH_CREDIT_PAGE_SIZE);
    expect(h.call.mock.calls.map((c) => c[1])).toEqual([
      expect.objectContaining({ operation: "getOverpayments", armTransientBreaker: false }),
      expect.objectContaining({ operation: "getPrepayments", armTransientBreaker: false }),
    ]);
  });

  it("treats a reply with no list as unreadable, never as empty", async () => {
    accountingApi.getOverpayments.mockResolvedValue({ body: {} });
    await expect(readXeroCashCreditDocuments()).rejects.toThrow(XeroCashCreditReadError);
  });

  it("reads a skipped document by id, a 404 as spent, and passes any other failure out", async () => {
    accountingApi.getOverpayments.mockResolvedValue({ body: { overpayments: [] } });
    accountingApi.getPrepayments
      .mockResolvedValueOnce({ body: { prepayments: fullPage(prepayment, "pp") } })
      .mockResolvedValueOnce({ body: { prepayments: [] } });
    h.findMany.mockResolvedValue([{ xeroDocumentId: "pp-gone" }, { xeroDocumentId: "pp-moved" }]);
    accountingApi.getPrepayment.mockImplementation(async (_tenant: string, id: string) => {
      if (id === "pp-gone") throw { response: { statusCode: 404 } };
      return { body: { prepayments: [prepayment(id)] } };
    });
    const ids = (await readXeroCashCreditDocuments()).map((d) => d.xeroDocumentId);
    expect(ids).toContain("pp-moved");
    expect(ids).not.toContain("pp-gone");

    accountingApi.getPrepayments
      .mockResolvedValueOnce({ body: { prepayments: fullPage(prepayment, "pp") } })
      .mockResolvedValueOnce({ body: { prepayments: [] } });
    accountingApi.getPrepayment.mockRejectedValue({ response: { statusCode: 500 } });
    await expect(readXeroCashCreditDocuments()).rejects.toEqual({ response: { statusCode: 500 } });
  });

  it("re-reads a skipped overpayment by its own id endpoint", async () => {
    accountingApi.getOverpayments
      .mockResolvedValueOnce({ body: { overpayments: fullPage(overpayment, "op") } })
      .mockResolvedValueOnce({ body: { overpayments: [] } });
    accountingApi.getPrepayments.mockResolvedValue({ body: { prepayments: [] } });
    h.findMany.mockResolvedValue([{ xeroDocumentId: "op-moved" }]);
    accountingApi.getOverpayment.mockResolvedValue({ body: { overpayments: [overpayment("op-moved")] } });
    const ids = (await readXeroCashCreditDocuments()).map((d) => d.xeroDocumentId);
    expect(ids).toContain("op-moved");
    expect(accountingApi.getOverpayment).toHaveBeenCalledWith("tenant", "op-moved");
  });
});

/** A stubbed transaction client: the cursor claim's count decides whether rows are written. */
function snapshotDb(claimedCount: number) {
  const tx = {
    xeroSyncCursor: { createMany: vi.fn(async () => ({ count: 0 })), updateMany: vi.fn(async () => ({ count: claimedCount })) },
    xeroCashCredit: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async (args: { where: { remainingCents?: unknown } }) => ({ count: args.where.remainingCents ? 2 : 1 })),
    },
  };
  const $transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  return { tx, $transaction, db: { ...tx, $transaction } as never };
}

const READ_AT = new Date("2026-07-01T00:00:00.000Z");

describe("applyXeroCashCreditSnapshot with a stubbed database (#5204)", () => {
  const documents = [
    xeroCashCreditDocumentFrom("OVERPAYMENT", overpayment("op-1"))!,
    xeroCashCreditDocumentFrom("PREPAYMENT", prepayment("pp-1"))!,
  ];

  it("claims the cursor first, then upserts each document and zeroes the unlisted, all guarded by syncedAt", async () => {
    const { tx, $transaction, db: stub } = snapshotDb(1);
    const result = await applyXeroCashCreditSnapshot(documents, READ_AT, stub);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(tx.xeroSyncCursor.createMany).toHaveBeenCalledWith({
      data: [{ resourceType: "XERO_CASH_CREDITS", scope: expect.any(String) }], skipDuplicates: true,
    });
    expect(tx.xeroSyncCursor.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ resourceType: "XERO_CASH_CREDITS", OR: [{ cursorDateTime: null }, { cursorDateTime: { lt: READ_AT } }] }),
      data: { cursorDateTime: READ_AT, lastSuccessfulSyncAt: READ_AT },
    });
    expect(tx.xeroCashCredit.createMany).toHaveBeenCalledWith({
      data: documents.map((document) => ({ ...document, syncedAt: READ_AT })), skipDuplicates: true,
    });
    expect(tx.xeroCashCredit.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { xeroDocumentId: "op-1", syncedAt: { lt: READ_AT } } }));
    expect(tx.xeroCashCredit.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { xeroDocumentId: "pp-1", syncedAt: { lt: READ_AT } } }));
    expect(tx.xeroCashCredit.updateMany).toHaveBeenNthCalledWith(3, {
      where: { xeroDocumentId: { notIn: ["op-1", "pp-1"] }, remainingCents: { gt: 0 }, syncedAt: { lt: READ_AT } },
      data: { remainingCents: 0, syncedAt: READ_AT },
    });
    expect(result).toEqual({ open: 2, written: 3, zeroed: 2, current: true });
  });

  it("writes no snapshot row when a later read already claimed the cursor", async () => {
    const { tx, db: stub } = snapshotDb(0);
    const result = await applyXeroCashCreditSnapshot(documents, READ_AT, stub);
    expect(result).toEqual({ open: 2, written: 0, zeroed: 0, current: false });
    expect(tx.xeroCashCredit.createMany).not.toHaveBeenCalled();
    expect(tx.xeroCashCredit.updateMany).not.toHaveBeenCalled();
  });
});

describe("refreshXeroCashCredits with a stubbed database (#5204)", () => {
  it("stamps every write with the time the read began", async () => {
    const { tx, db: stub } = snapshotDb(1);
    const reader = readerOf({ OVERPAYMENT: [[overpayment("op-1")]] });
    const result = await refreshXeroCashCredits({ db: stub, reader, now: () => READ_AT });
    expect(result).toMatchObject({ open: 1, current: true });
    expect(tx.xeroSyncCursor.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { cursorDateTime: READ_AT, lastSuccessfulSyncAt: READ_AT } }));
  });

  it("writes nothing when the read fails", async () => {
    const { $transaction, db: stub } = snapshotDb(1);
    const reader = readerOf({});
    reader.readPage.mockRejectedValueOnce(new Error("Xero page failed"));
    await expect(refreshXeroCashCredits({ db: stub, reader, now: () => READ_AT })).rejects.toThrow("Xero page failed");
    expect($transaction).not.toHaveBeenCalled();
  });
});

describe("listXeroCashCreditQueue with a stubbed database (#5204)", () => {
  const row = (id: string, contact: string, documentDate: Date | null) => ({
    id: `row-${id}`, kind: "OVERPAYMENT", xeroDocumentId: id, xeroContactId: contact, currencyCode: "NZD",
    documentDate, totalCents: 20_000, remainingCents: 12_345, syncedAt: READ_AT,
  });

  function queueDb(rows: unknown[], cursor: unknown, members: unknown[]) {
    return {
      xeroCashCredit: { findMany: vi.fn(async () => rows) },
      xeroSyncCursor: { findUnique: vi.fn(async () => cursor) },
      member: { findMany: vi.fn(async () => members) },
    };
  }

  it("lists open documents oldest first, matching each to the member by contact", async () => {
    const stub = queueDb(
      [row("op-1", "contact-1", new Date("2026-06-20T00:00:00.000Z")), row("op-2", "contact-1", null), row("op-3", "contact-9", null)],
      { lastSuccessfulSyncAt: READ_AT },
      [{ id: "m1", firstName: "Aroha", lastName: "Ngata", email: "a@example.test", xeroContactId: "contact-1" }],
    );
    const queue = await listXeroCashCreditQueue(stub as never);
    expect(stub.xeroCashCredit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { remainingCents: { gt: 0 } },
        orderBy: [{ documentDate: { sort: "asc", nulls: "last" } }, { xeroDocumentId: "asc" }],
      }),
    );
    expect(stub.member.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { xeroContactId: { in: ["contact-1", "contact-9"] } } }));
    expect(queue.refreshedAt).toBe(READ_AT);
    expect(queue.rows.map((r) => [r.xeroDocumentId, r.documentDate, r.member])).toEqual([
      ["op-1", "2026-06-20", { id: "m1", name: "Aroha Ngata" }],
      ["op-2", null, { id: "m1", name: "Aroha Ngata" }],
      ["op-3", null, null],
    ]);
    expect(queue.rows[0]).toMatchObject({ id: "row-op-1", kind: "OVERPAYMENT", currencyCode: "NZD", totalCents: 20_000, remainingCents: 12_345 });
  });

  it("before any refresh shows an empty queue without looking up members", async () => {
    const stub = queueDb([], null, []);
    expect(await listXeroCashCreditQueue(stub as never)).toEqual({ rows: [], refreshedAt: null });
    expect(stub.member.findMany).not.toHaveBeenCalled();
  });
});
