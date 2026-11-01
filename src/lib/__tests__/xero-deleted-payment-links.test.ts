/**
 * #4531 (`INV-INT-031`): a payment link is retired only once Xero confirms its
 * payment DELETED; absence from a trusted payload only nominates it, and only
 * for a role the document's own reconcile writes. A candidate Xero could not
 * judge is marked and re-checked by the scheduled run. Synthetic fixtures and a
 * doubled Xero client only.
 *
 * The link table is an in-memory double that HONOURS the query (role, status,
 * metadata path, id lists, OR, the metadata guard), so a filter missing from a
 * query fails here rather than hiding behind a double that returns every row
 * (the role-filter defect #4596's review found did exactly that). One test
 * bypasses the query on purpose, to prove the in-code re-check on its own.
 */
import { isDeepStrictEqual } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditNote, Invoice } from "xero-node";

type LinkRow = {
  id: string;
  localModel: string;
  localId: string;
  role: string;
  xeroObjectType: string;
  active: boolean;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  metadata: unknown;
  updatedAt: Date;
};

type OperationRow = {
  id: string;
  localModel: string | null;
  localId: string | null;
  status: string;
  manuallyResolvedAt: Date | null;
  replayable: boolean;
  queueType: string | null;
  requestPayload: unknown;
  entityType: string;
  operationType: string;
  createdAt: Date;
};
type CursorRow = { resourceType: string; scope: string; lastSuccessfulSyncAt: Date | null };

const h = vi.hoisted(() => ({
  store: [] as LinkRow[],
  operations: [] as OperationRow[],
  cursors: [] as CursorRow[],
  modifications: [] as Array<{ id: string; bookingId: string }>,
  captures: [] as Array<{ id: string; bookingId: string }>,
  opFindFirst: vi.fn(),
  cursorCreate: vi.fn(),
  cursorUpdateMany: vi.fn(),
  tick: 0,
  linkFindMany: vi.fn(),
  linkUpdateMany: vi.fn(),
  linkFindUnique: vi.fn(),
  budgetAllows: vi.fn(),
  writeAudit: vi.fn(),
  getPayment: vi.fn(),
  callOptions: [] as unknown[],
  getClient: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroObjectLink: { findMany: h.linkFindMany, updateMany: h.linkUpdateMany, findUnique: h.linkFindUnique },
    xeroSyncOperation: { findFirst: h.opFindFirst },
    xeroSyncCursor: { create: h.cursorCreate, updateMany: h.cursorUpdateMany },
    bookingModification: {
      findUnique: async (args: { where: { id: string } }) => h.modifications.find((row) => row.id === args.where.id) ?? null,
    },
    paymentTransaction: {
      findMany: async (args: { where: { payment: { bookingId: string } } }) =>
        h.captures.filter((row) => row.bookingId === args.where.payment.bookingId).map((row) => ({ id: row.id })),
      findUnique: async (args: { where: { id: string } }) => {
        const row = h.captures.find((capture) => capture.id === args.where.id);
        return row ? { payment: { bookingId: row.bookingId } } : null;
      },
    },
  },
}));
vi.mock("@/lib/xero-api-usage", () => ({ xeroDailyBudgetAllowsDeferrableCall: h.budgetAllows }));
vi.mock("@/lib/xero-inbound/audit", () => ({ writeXeroInboundAuditLogs: h.writeAudit }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  return {
    ...actual,
    getAuthenticatedXeroClient: h.getClient,
    callXeroApi: (fn: () => Promise<unknown>, options: unknown) => {
      h.callOptions.push(options);
      return fn();
    },
  };
});

import { Prisma } from "@prisma/client";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import {
  confirmXeroPaymentDeleted,
  creditNotePaymentsForAbsence,
  DELETED_PAYMENT_RECHECK_MIN_INTERVAL_MS,
  deletedPaymentCandidateRoles,
  documentNamedByLink,
  invoicePaymentsForAbsence,
  MAX_DELETION_CHECK_ATTEMPTS,
  MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE,
  recheckPendingDeletedPaymentLinks,
  retireDeletedPaymentLinksAbsentFromPayload,
  retireDeletedXeroPaymentLink,
} from "@/lib/xero-inbound/deleted-payment-links";
import { getDerivedInboundPaymentRole, INVOICE_DERIVED_PAYMENT_ROLES, INVOICE_LINK_PAYMENT_ROLES } from "@/lib/xero-inbound/object-links";

const INVOICE = "inv-4531";
const NOTE = "cn-4531";
const SCOPE = [{ localModel: "Payment", localId: "pay-local-1" }];
const session = { tenantId: "tenant-test", xero: { accountingApi: { getPayment: h.getPayment } } } as never;

// ---- the honouring link-table double -------------------------------------------------
function readPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value);
}

function matches(row: object, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!(condition as Array<Record<string, unknown>>).some((branch) => matches(row, branch))) return false;
      continue;
    }
    const value = (row as Record<string, unknown>)[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date) && ("path" in condition || "equals" in condition)) {
      const filter = condition as { path?: string[]; equals: unknown };
      if (filter.path) {
        if (!isDeepStrictEqual(readPath(value, filter.path), filter.equals)) return false;
      } else if (filter.equals === Prisma.AnyNull) {
        if (value !== null && value !== undefined) return false;
      } else if (!isDeepStrictEqual(value, filter.equals)) {
        return false;
      }
      continue;
    }
    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (condition && typeof condition === "object") {
      const operators = condition as { in?: unknown[]; notIn?: unknown[]; lte?: Date };
      const unknownOperator = Object.keys(operators).find((operator) => !["in", "notIn", "lte"].includes(operator));
      if (unknownOperator) throw new Error(`The link double does not understand ${key}.${unknownOperator}`);
      if (operators.in && !operators.in.includes(value)) return false;
      if (operators.notIn && operators.notIn.includes(value)) return false;
      if (operators.lte && !(value instanceof Date && value.getTime() <= operators.lte.getTime())) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function honourQueries() {
  h.linkFindMany.mockImplementation(async (args: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
    let rows = h.store.filter((row) => matches(row, args.where)).map((row) => ({ ...row }));
    const orders = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
    for (const order of [...orders].reverse()) {
      const [field] = Object.keys(order as object);
      rows = [...rows].sort((a, b) => {
        const left = (a as Record<string, unknown>)[field];
        const right = (b as Record<string, unknown>)[field];
        return left instanceof Date && right instanceof Date ? left.getTime() - right.getTime() : String(left).localeCompare(String(right));
      });
    }
    return args.take ? rows.slice(0, args.take) : rows;
  });
  h.linkUpdateMany.mockImplementation(async (args: { where: Record<string, unknown>; data: Partial<LinkRow> }) => {
    const hit = h.store.filter((row) => matches(row, args.where));
    for (const row of hit) Object.assign(row, args.data, { updatedAt: new Date(Date.UTC(2026, 5, 30, 12, 0, h.tick++)) });
    return { count: hit.length };
  });
  h.linkFindUnique.mockImplementation(async (args: { where: { id: string } }) => {
    const row = h.store.find((candidate) => candidate.id === args.where.id);
    return row ? { ...row } : null;
  });
  h.opFindFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    const row = [...h.operations]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .find((operation) => matches(operation, args.where));
    return row ? { id: row.id, status: row.status, entityType: row.entityType, operationType: row.operationType } : null;
  });
  h.cursorCreate.mockImplementation(async (args: { data: CursorRow }) => {
    if (h.cursors.some((row) => row.resourceType === args.data.resourceType && row.scope === args.data.scope)) {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    h.cursors.push({ ...args.data });
    return args.data;
  });
  h.cursorUpdateMany.mockImplementation(async (args: { where: Record<string, unknown>; data: Partial<CursorRow> }) => {
    const hit = h.cursors.filter((row) => matches(row, args.where));
    for (const row of hit) Object.assign(row, args.data);
    return { count: hit.length };
  });
}

function seedOperation(overrides: Partial<OperationRow>): OperationRow {
  const row: OperationRow = {
    id: `op-${h.operations.length + 1}`,
    localModel: "Payment",
    localId: "pay-local-1",
    status: "PARTIAL",
    manuallyResolvedAt: null,
    replayable: true,
    queueType: null,
    requestPayload: null,
    entityType: "INVOICE",
    operationType: "CREATE",
    createdAt: new Date(Date.UTC(2026, 5, 29, 0, 0, h.operations.length)),
    ...overrides,
  };
  h.operations.push(row);
  return row;
}

function seedLink(xeroObjectId: string, overrides: Partial<LinkRow> = {}): LinkRow {
  const row: LinkRow = {
    id: `link-${xeroObjectId}-${overrides.localId ?? "pay-local-1"}`,
    localModel: "Payment",
    localId: "pay-local-1",
    role: "INVOICE_PAYMENT",
    xeroObjectType: "PAYMENT",
    active: true,
    xeroObjectId,
    xeroObjectNumber: null,
    metadata: { invoiceId: INVOICE, amount: 120, status: null },
    updatedAt: new Date(Date.UTC(2026, 5, 30, 10, 0, h.tick++)),
    ...overrides,
  };
  h.store.push(row);
  return row;
}

const stored = (id: string) => h.store.find((row) => row.id === id)!;

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoiceID: INVOICE,
    status: "AUTHORISED",
    amountPaid: 120,
    payments: [{ paymentID: "replacement", amount: 120, status: "AUTHORISED" }],
    ...overrides,
  } as unknown as Invoice;
}

function xeroPayment(paymentID: string, status: string, invoiceID = INVOICE) {
  return { body: { payments: [{ paymentID, status, invoice: { invoiceID } }] } };
}

function xeroError(statusCode: number) {
  return Object.assign(new Error(`Xero ${statusCode}`), { response: { statusCode, headers: {} } });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.store.length = 0;
  h.operations.length = 0;
  h.cursors.length = 0;
  h.modifications.length = 0;
  h.captures.length = 0;
  h.callOptions.length = 0;
  h.budgetAllows.mockResolvedValue(true);
  h.getClient.mockResolvedValue(session);
  honourQueries();
});

describe("which payloads may nominate a candidate (#4531)", () => {
  it("trusts an invoice whose listed payments are complete and add up to AmountPaid", () => {
    expect(invoicePaymentsForAbsence(invoice())).toEqual({ trusted: true, presentIds: new Set(["replacement"]) });
  });

  it("counts a DELETED entry as present but not toward AmountPaid", () => {
    const result = invoicePaymentsForAbsence(
      invoice({
        payments: [
          { paymentID: "gone", amount: 120, status: "DELETED" },
          { paymentID: "replacement", amount: 120, status: "AUTHORISED" },
        ] as never,
      }),
    );
    expect(result).toEqual({ trusted: true, presentIds: new Set(["gone", "replacement"]) });
  });

  it("refuses a payload with no Payments list at all", () => {
    expect(invoicePaymentsForAbsence(invoice({ payments: undefined })).trusted).toBe(false);
    expect(creditNotePaymentsForAbsence({ creditNoteID: NOTE } as CreditNote).trusted).toBe(false);
  });

  it("refuses a listed payment without an id or a readable amount", () => {
    expect(invoicePaymentsForAbsence(invoice({ payments: [{ amount: 120 }] as never })).trusted).toBe(false);
    expect(
      invoicePaymentsForAbsence(invoice({ payments: [{ paymentID: "replacement", amount: "120" }] as never })).trusted,
    ).toBe(false);
  });

  it("refuses a truncated list whose payments fall short of AmountPaid", () => {
    expect(invoicePaymentsForAbsence(invoice({ amountPaid: 240 })).trusted).toBe(false);
  });

  it("refuses a payload the module's degraded-shape guard finds incomplete", () => {
    const degraded = invoice({ overpayments: [{ overpaymentID: "op-1" }] as never });
    expect(invoicePaymentsForAbsence(degraded)).toEqual({ trusted: false, reason: "The invoice's cash figures are incomplete." });
  });

  it("trusts a credit note whose refund payments are all identified", () => {
    const result = creditNotePaymentsForAbsence({
      creditNoteID: NOTE,
      payments: [{ paymentID: "refund-live", amount: 50 }],
    } as unknown as CreditNote);
    expect(result).toEqual({ trusted: true, presentIds: new Set(["refund-live"]) });
  });
});

describe("which roles a document nominates (#4531)", () => {
  it("an invoice nominates exactly the payment roles its own reconcile derives, from one map", () => {
    // Every invoice role the derivation knows is in the map, so a new one is a candidate too.
    for (const [invoiceRole, paymentRole] of Object.entries(INVOICE_LINK_PAYMENT_ROLES)) {
      expect(getDerivedInboundPaymentRole({ xeroObjectType: "INVOICE", role: invoiceRole })).toBe(paymentRole);
      expect(INVOICE_DERIVED_PAYMENT_ROLES).toContain(paymentRole);
    }
    expect(INVOICE_DERIVED_PAYMENT_ROLES).toHaveLength(Object.keys(INVOICE_LINK_PAYMENT_ROLES).length);
    expect(getDerivedInboundPaymentRole({ xeroObjectType: "INVOICE", role: "GROUP_SETTLEMENT_INVOICE" })).toBeNull();
    expect(getDerivedInboundPaymentRole({ xeroObjectType: "CREDIT_NOTE", role: "REFUND_CREDIT_NOTE" })).toBe("REFUND_PAYMENT");
    expect(deletedPaymentCandidateRoles({ kind: "INVOICE", id: INVOICE })).toEqual(INVOICE_DERIVED_PAYMENT_ROLES);
    expect(deletedPaymentCandidateRoles({ kind: "CREDIT_NOTE", id: NOTE })).toEqual(["REFUND_PAYMENT"]);
  });
});

describe("retiring the links of payments Xero deleted (#4531)", () => {
  const retire = (payments = invoicePaymentsForAbsence(invoice())) =>
    retireDeletedPaymentLinksAbsentFromPayload({
      session,
      document: { kind: "INVOICE", id: INVOICE },
      payments,
      localScope: SCOPE,
    });

  it("retires nothing, and asks nothing, when the payload cannot be trusted", async () => {
    seedLink("deleted");
    const outcome = await retire(invoicePaymentsForAbsence(invoice({ payments: undefined })));
    expect(outcome).toMatchObject({ skippedReason: "The payload carries no Payments list.", retiredLinks: 0, xeroCalls: 0 });
    expect(h.linkFindMany).not.toHaveBeenCalled();
    expect(h.getPayment).not.toHaveBeenCalled();
    expect(stored("link-deleted-pay-local-1").active).toBe(true);
  });

  it("retires a confirmed DELETED payment and leaves the hand-entered replacement active", async () => {
    seedLink("deleted");
    seedLink("replacement");
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));

    const outcome = await retire();

    expect(h.linkFindMany.mock.calls[0][0].where).toMatchObject({
      xeroObjectType: "PAYMENT",
      active: true,
      role: { in: [...INVOICE_DERIVED_PAYMENT_ROLES] },
      metadata: { path: ["invoiceId"], equals: INVOICE },
      xeroObjectId: { notIn: ["replacement"] },
      OR: [{ localModel: "Payment", localId: "pay-local-1" }],
    });
    expect(h.getPayment).toHaveBeenCalledTimes(1);
    expect(h.getPayment).toHaveBeenCalledWith("tenant-test", "deleted");
    expect(h.linkUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "link-deleted-pay-local-1",
        xeroObjectType: "PAYMENT",
        active: true,
        metadata: { equals: { invoiceId: INVOICE, amount: 120, status: null } },
      },
      data: { active: false, metadata: { invoiceId: INVOICE, amount: 120, status: "DELETED" } },
    });
    expect(stored("link-deleted-pay-local-1")).toMatchObject({ active: false, metadata: { status: "DELETED" } });
    expect(stored("link-replacement-pay-local-1")).toMatchObject({ active: true, metadata: { status: null } });
    expect(outcome).toMatchObject({ candidatePayments: 1, xeroCalls: 1, confirmedDeleted: ["deleted"], retiredLinks: 1 });
    expect(h.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "xero-inbound-deleted-payment-retired",
        summary: "Xero payment link retired: payment deleted in Xero",
        links: [expect.objectContaining({ xeroObjectId: "deleted", role: "INVOICE_PAYMENT" })],
      }),
    );
  });

  it("never asks Xero about a refund payment that names the invoice it refunds", async () => {
    seedLink("refund-on-note", { role: "REFUND_PAYMENT", metadata: { invoiceId: INVOICE, creditNoteId: NOTE, amount: 50 } });
    const outcome = await retire();
    expect(outcome).toMatchObject({ candidatePayments: 0, xeroCalls: 0 });
    expect(h.getPayment).not.toHaveBeenCalled();
  });

  it("re-checks role, status, document and absence in code even if the query returned every row", async () => {
    seedLink("refund-on-note", { role: "REFUND_PAYMENT" });
    seedLink("replacement");
    seedLink("already-retired", { active: false });
    seedLink("other-invoice", { metadata: { invoiceId: "another-invoice", amount: 1 } });
    h.linkFindMany.mockImplementationOnce(async () => h.store.map((row) => ({ ...row })));
    const outcome = await retire();
    expect(outcome.candidatePayments).toBe(0);
    expect(h.getPayment).not.toHaveBeenCalled();
  });

  it("asks once per payment and retires every link that names it", async () => {
    seedLink("deleted");
    seedLink("deleted", { localModel: "Booking", localId: "booking-1" });
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));
    const outcome = await retireDeletedPaymentLinksAbsentFromPayload({
      session,
      document: { kind: "INVOICE", id: INVOICE },
      payments: invoicePaymentsForAbsence(invoice()),
      localScope: [...SCOPE, { localModel: "Booking", localId: "booking-1" }],
    });
    expect(h.getPayment).toHaveBeenCalledTimes(1);
    expect(outcome.retiredLinks).toBe(2);
  });

  it("keeps a candidate Xero still reports live, and clears a pending marker", async () => {
    seedLink("absent-but-live", { metadata: { invoiceId: INVOICE, deletionCheckPending: true, deletionCheckPendingSince: "x", deletionCheckAttempts: 2 } });
    h.getPayment.mockResolvedValue(xeroPayment("absent-but-live", "AUTHORISED"));
    const outcome = await retire();
    expect(outcome).toMatchObject({ confirmedLive: ["absent-but-live"], retiredLinks: 0 });
    expect(stored("link-absent-but-live-pay-local-1")).toMatchObject({ active: true, metadata: { invoiceId: INVOICE } });
    expect(stored("link-absent-but-live-pay-local-1").metadata).not.toHaveProperty("deletionCheckPending");
  });

  it("keeps a deleted payment Xero files under another invoice", async () => {
    seedLink("deleted");
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED", "another-invoice"));
    const outcome = await retire();
    expect(outcome).toMatchObject({ unconfirmed: ["deleted"], retiredLinks: 0 });
    expect(stored("link-deleted-pay-local-1").active).toBe(true);
  });

  it("marks a candidate whose answer failed, counting the attempt", async () => {
    seedLink("deleted");
    h.getPayment.mockRejectedValue(new Error("404 Not Found"));
    const outcome = await retire();
    expect(outcome).toMatchObject({ unconfirmed: ["deleted"], xeroCalls: 1, retiredLinks: 0 });
    expect(stored("link-deleted-pay-local-1")).toMatchObject({
      active: true,
      metadata: { invoiceId: INVOICE, deletionCheckPending: true, deletionCheckPendingSince: "2026-07-01T00:00:00.000Z", deletionCheckAttempts: 1 },
    });
  });

  it("defers and marks, without calling Xero, when the day's budget is spent", async () => {
    seedLink("deleted");
    h.budgetAllows.mockResolvedValue(false);
    const outcome = await retire();
    expect(outcome).toMatchObject({ deferred: ["deleted"], xeroCalls: 0, retiredLinks: 0 });
    expect(h.getPayment).not.toHaveBeenCalled();
    expect(stored("link-deleted-pay-local-1")).toMatchObject({ active: true, metadata: { deletionCheckPending: true, deletionCheckAttempts: 0 } });
  });

  it("stops asking once Xero's daily limit is hit, deferring and marking the rest", async () => {
    seedLink("first");
    seedLink("second");
    h.getPayment.mockRejectedValue(new XeroDailyLimitError(3600, true));
    const outcome = await retire();
    expect(h.getPayment).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ deferred: ["first", "second"], xeroCalls: 0, retiredLinks: 0 });
    expect(stored("link-second-pay-local-1").metadata).toMatchObject({ deletionCheckPending: true });
  });

  it(`asks about at most ${MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE} payments per reconcile and marks the rest`, async () => {
    const ids = Array.from({ length: MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE + 2 }, (_, index) => `p${index}`);
    for (const id of ids) seedLink(id);
    h.getPayment.mockImplementation(async (_tenant: string, id: string) => xeroPayment(id, "DELETED"));
    const outcome = await retire();
    expect(h.getPayment).toHaveBeenCalledTimes(MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE);
    expect(outcome.xeroCalls).toBe(MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE);
    expect(outcome.deferred).toEqual(ids.slice(MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE));
    expect(outcome.retiredLinks).toBe(MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE);
    expect(stored(`link-${ids.at(-1)}-pay-local-1`).metadata).toMatchObject({ deletionCheckPending: true });
  });

  it("a replay finds nothing to retire, asks nothing and writes no audit row", async () => {
    seedLink("deleted");
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));
    await retire();
    vi.clearAllMocks();
    honourQueries();
    const replay = await retire();
    expect(replay).toMatchObject({ candidatePayments: 0, retiredLinks: 0, xeroCalls: 0 });
    expect(h.getPayment).not.toHaveBeenCalled();
    expect(h.linkUpdateMany).not.toHaveBeenCalled();
    expect(h.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ links: [] }));
  });

  it("nominates only a credit note's refund payments, by the note's id", async () => {
    seedLink("refund-deleted", { role: "REFUND_PAYMENT", metadata: { creditNoteId: NOTE, amount: 50 } });
    seedLink("invoice-payment-naming-note", { role: "INVOICE_PAYMENT", metadata: { creditNoteId: NOTE, amount: 50 } });
    h.getPayment.mockResolvedValue({ body: { payments: [{ paymentID: "refund-deleted", status: "DELETED", creditNote: { creditNoteID: NOTE } }] } });
    const outcome = await retireDeletedPaymentLinksAbsentFromPayload({
      session,
      document: { kind: "CREDIT_NOTE", id: NOTE },
      payments: creditNotePaymentsForAbsence({ creditNoteID: NOTE, payments: [] } as unknown as CreditNote),
      localScope: SCOPE,
    });
    expect(h.linkFindMany.mock.calls[0][0].where).toMatchObject({ role: { in: ["REFUND_PAYMENT"] }, metadata: { path: ["creditNoteId"], equals: NOTE } });
    expect(h.getPayment).toHaveBeenCalledTimes(1);
    expect(outcome.retiredLinks).toBe(1);
  });
});

describe("the guarded write (#4531)", () => {
  it("re-reads after a concurrent write and retires over its metadata, dropping the pending marker", async () => {
    const stale = seedLink("deleted", { metadata: { invoiceId: INVOICE, deletionCheckPending: true } });
    stored(stale.id).metadata = { invoiceId: INVOICE, amount: 125, deletionCheckPending: true };
    expect(await retireDeletedXeroPaymentLink({ ...stale, metadata: { invoiceId: INVOICE, deletionCheckPending: true } })).toBe("retired");
    expect(h.linkUpdateMany).toHaveBeenCalledTimes(2);
    expect(stored(stale.id)).toMatchObject({ active: false, metadata: { invoiceId: INVOICE, amount: 125, status: "DELETED" } });
    expect(stored(stale.id).metadata).not.toHaveProperty("deletionCheckPending");
  });

  it("guards a link stored without metadata on its being null", async () => {
    const row = seedLink("deleted", { metadata: null });
    expect(await retireDeletedXeroPaymentLink(row)).toBe("retired");
    expect(h.linkUpdateMany.mock.calls[0][0].where.metadata).toEqual({ equals: Prisma.AnyNull });
    expect(stored(row.id).metadata).toEqual({ status: "DELETED" });
  });

  it("gives up after two lost guards rather than overwrite blindly", async () => {
    const row = seedLink("deleted");
    h.linkUpdateMany.mockResolvedValue({ count: 0 });
    expect(await retireDeletedXeroPaymentLink(row)).toBe("unchanged");
    expect(h.linkUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("writes nothing to a link already retired", async () => {
    const row = seedLink("deleted", { active: false });
    expect(await retireDeletedXeroPaymentLink(row)).toBe("unchanged");
    expect(stored(row.id).metadata).toEqual({ invoiceId: INVOICE, amount: 120, status: null });
  });
});

describe("an operation that may still run holds the retire back (#4531, PR #4596 finding 11)", () => {
  const retire = () =>
    retireDeletedPaymentLinksAbsentFromPayload({
      session,
      document: { kind: "INVOICE", id: INVOICE },
      payments: invoicePaymentsForAbsence(invoice()),
      localScope: SCOPE,
    });

  it("a PARTIAL invoice operation on the payment keeps the deleted payment's link, asks Xero nothing, and the next check after it completes retires it", async () => {
    seedLink("deleted");
    const partial = seedOperation({ status: "PARTIAL" });
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));

    const held = await retire();

    expect(held).toMatchObject({ blocked: ["deleted"], retiredLinks: 0, xeroCalls: 0 });
    expect(h.getPayment).not.toHaveBeenCalled();
    expect(h.opFindFirst.mock.calls[0][0].where).toEqual({
      localModel: "Payment",
      localId: "pay-local-1",
      manuallyResolvedAt: null,
      OR: [
        { status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] } },
        { status: { in: ["FAILED", "PARTIAL"] }, replayable: true },
      ],
    });
    expect(stored("link-deleted-pay-local-1")).toMatchObject({
      active: true,
      metadata: { deletionCheckPending: true, deletionCheckBlockedBy: partial.id, deletionCheckBlockedAt: "2026-07-01T00:00:00.000Z" },
    });

    partial.status = "SUCCEEDED";
    const recheck = await recheckPendingDeletedPaymentLinks({ minimumIntervalMs: 0 });

    expect(recheck).toMatchObject({ confirmedDeleted: ["deleted"], retiredLinks: 1, blocked: [] });
    expect(stored("link-deleted-pay-local-1")).toMatchObject({ active: false, metadata: { invoiceId: INVOICE, status: "DELETED" } });
    expect(stored("link-deleted-pay-local-1").metadata).not.toHaveProperty("deletionCheckBlockedBy");
  });

  it("an operation an officer resolved in Xero holds nothing back", async () => {
    seedLink("deleted");
    seedOperation({ status: "FAILED", manuallyResolvedAt: new Date("2026-06-30T00:00:00.000Z") });
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));
    expect(await retire()).toMatchObject({ retiredLinks: 1, blocked: [] });
  });

  it("re-asks at the write: an operation opened after Xero answered still holds the retire back", async () => {
    seedLink("deleted");
    h.getPayment.mockImplementation(async () => {
      seedOperation({ status: "RUNNING" });
      return xeroPayment("deleted", "DELETED");
    });
    const outcome = await retire();
    expect(outcome).toMatchObject({ confirmedDeleted: ["deleted"], blocked: ["deleted"], retiredLinks: 0 });
    expect(stored("link-deleted-pay-local-1")).toMatchObject({ active: true, metadata: { deletionCheckPending: true } });
  });

  it("holds back only the link whose record has the operation", async () => {
    seedLink("deleted");
    seedLink("deleted", { localModel: "Booking", localId: "booking-1" });
    seedOperation({ localModel: "Booking", localId: "booking-1", status: "FAILED" });
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));
    const outcome = await retireDeletedPaymentLinksAbsentFromPayload({
      session,
      document: { kind: "INVOICE", id: INVOICE },
      payments: invoicePaymentsForAbsence(invoice()),
      localScope: [...SCOPE, { localModel: "Booking", localId: "booking-1" }],
    });
    expect(outcome).toMatchObject({ retiredLinks: 1, blocked: ["deleted"] });
    expect(stored("link-deleted-pay-local-1").active).toBe(false);
    expect(stored("link-deleted-booking-1").active).toBe(true);
  });

  it("a FAILED row that can never run again (not replayable, like a REQUEUE row) holds nothing back", async () => {
    seedLink("deleted");
    seedOperation({ status: "FAILED", replayable: false, operationType: "REQUEUE" });
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));
    expect(await retire()).toMatchObject({ retiredLinks: 1, blocked: [] });
  });

  it("a replayable PARTIAL holds the retire back, and so does a live non-replayable REQUEUE row", async () => {
    seedLink("deleted");
    const partial = seedOperation({ status: "PARTIAL", replayable: true });
    expect(await retire()).toMatchObject({ blocked: ["deleted"], retiredLinks: 0 });
    partial.status = "SUCCEEDED";
    seedOperation({ status: "RUNNING", replayable: false, operationType: "REQUEUE" });
    expect(await retire()).toMatchObject({ blocked: ["deleted"], retiredLinks: 0 });
  });

  it("a supplementary invoice's payment link waits for the booking's open card receipt", async () => {
    h.modifications.push({ id: "mod-1", bookingId: "booking-1" });
    h.captures.push({ id: "txn-1", bookingId: "booking-1" });
    seedLink("supplementary-deleted", { localModel: "BookingModification", localId: "mod-1", role: "SUPPLEMENTARY_INVOICE_PAYMENT" });
    const receipt = seedOperation({ localModel: "PaymentTransaction", localId: "txn-1", status: "FAILED", queueType: "ADDITIONAL_CAPTURE_RECEIPT" });
    h.getPayment.mockResolvedValue(xeroPayment("supplementary-deleted", "DELETED"));
    const scope = [{ localModel: "BookingModification", localId: "mod-1" }];
    const run = () =>
      retireDeletedPaymentLinksAbsentFromPayload({ session, document: { kind: "INVOICE", id: INVOICE }, payments: invoicePaymentsForAbsence(invoice()), localScope: scope });

    expect(await run()).toMatchObject({ blocked: ["supplementary-deleted"], retiredLinks: 0 });
    receipt.status = "SUCCEEDED";
    expect(await run()).toMatchObject({ retiredLinks: 1, blocked: [] });
  });

  it("a card receipt's payment link waits for the booking's open supplementary invoice", async () => {
    h.captures.push({ id: "txn-1", bookingId: "booking-1" });
    const row = seedLink("capture-deleted", {
      localModel: "PaymentTransaction",
      localId: "txn-1",
      role: "ADDITIONAL_CAPTURE_PAYMENT",
      metadata: { invoiceId: INVOICE, deletionCheckPending: true },
    });
    seedOperation({ localModel: "BookingModification", localId: "mod-1", status: "PENDING", queueType: "SUPPLEMENTARY_INVOICE", requestPayload: { bookingId: "booking-1" } });
    seedOperation({ localModel: "BookingModification", localId: "mod-9", status: "PENDING", queueType: "SUPPLEMENTARY_INVOICE", requestPayload: { bookingId: "another-booking" } });
    expect(await retireDeletedXeroPaymentLink(row)).toBe("blocked");
    h.operations.shift();
    expect(await retireDeletedXeroPaymentLink({ ...row, metadata: stored(row.id).metadata })).toBe("retired");
  });

  it("a held link is rewritten on every check, so it moves behind the others", async () => {
    const row = seedLink("deleted", { metadata: { invoiceId: INVOICE, deletionCheckPending: true } });
    seedOperation({ status: "PARTIAL" });
    const before = stored(row.id).updatedAt.getTime();
    await recheckPendingDeletedPaymentLinks({ minimumIntervalMs: 0 });
    expect(stored(row.id).updatedAt.getTime()).toBeGreaterThan(before);
    expect(h.getPayment).not.toHaveBeenCalled();
  });
});

describe("confirming a payment's deletion (#4531)", () => {
  it("is one attempt that never waits and never arms the outage breaker", async () => {
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED"));
    await confirmXeroPaymentDeleted(session, "deleted", { workflow: "test" });
    expect(h.callOptions[0]).toMatchObject({ maxRetries: 0, maxTransientRetries: 0, armTransientBreaker: false });
  });

  it.each([429, 503, 408])("defers on a %s rather than calling it unanswered", async (statusCode) => {
    h.getPayment.mockRejectedValue(xeroError(statusCode));
    expect(await confirmXeroPaymentDeleted(session, "deleted", { workflow: "test" })).toEqual({ confirmation: "DEFERRED", called: true });
  });

  it("is DELETED only for the payment asked about", async () => {
    h.getPayment.mockResolvedValue(xeroPayment("someone-else", "DELETED"));
    expect(await confirmXeroPaymentDeleted(session, "deleted", { workflow: "test" })).toEqual({ confirmation: "UNCONFIRMED", called: true });
  });

  it("defers when today's usage cannot be read", async () => {
    h.budgetAllows.mockRejectedValue(new Error("db down"));
    expect(await confirmXeroPaymentDeleted(session, "deleted", { workflow: "test" })).toEqual({ confirmation: "DEFERRED", called: false });
    expect(h.getPayment).not.toHaveBeenCalled();
  });
});

describe("the scheduled re-check of pending links (#4531)", () => {
  const pending = (attempts = 0) => ({ deletionCheckPending: true, deletionCheckPendingSince: "2026-06-29T00:00:00.000Z", deletionCheckAttempts: attempts });

  it("waits out its interval without reading a link", async () => {
    h.cursors.push({ resourceType: "DELETED_PAYMENT_RECHECK", scope: "default", lastSuccessfulSyncAt: new Date(Date.now() - DELETED_PAYMENT_RECHECK_MIN_INTERVAL_MS + 60_000) });
    const outcome = await recheckPendingDeletedPaymentLinks();
    expect(outcome).toMatchObject({ skipped: true, xeroCalls: 0 });
    expect(h.linkFindMany).not.toHaveBeenCalled();
  });

  it("reads only marked links, and with none asks Xero nothing", async () => {
    seedLink("unmarked");
    const outcome = await recheckPendingDeletedPaymentLinks();
    expect(h.linkFindMany.mock.calls[0][0].where).toEqual({
      xeroObjectType: "PAYMENT",
      active: true,
      metadata: { path: ["deletionCheckPending"], equals: true },
    });
    expect(outcome.candidatePayments).toBe(0);
    expect(h.getClient).not.toHaveBeenCalled();
    expect(h.cursors).toEqual([{ resourceType: "DELETED_PAYMENT_RECHECK", scope: "default", lastSuccessfulSyncAt: expect.any(Date) }]);
  });

  it("retires a confirmed one, clears a live one and counts a failed answer", async () => {
    seedLink("now-deleted", { metadata: { invoiceId: INVOICE, ...pending() } });
    seedLink("live", { metadata: { invoiceId: INVOICE, ...pending() } });
    seedLink("silent", { metadata: { creditNoteId: NOTE, ...pending(3) }, role: "REFUND_PAYMENT" });
    h.getPayment.mockImplementation(async (_tenant: string, id: string) => {
      if (id === "silent") throw new Error("404 Not Found");
      return xeroPayment(id, id === "now-deleted" ? "DELETED" : "AUTHORISED");
    });

    const outcome = await recheckPendingDeletedPaymentLinks();

    expect(outcome).toMatchObject({ confirmedDeleted: ["now-deleted"], confirmedLive: ["live"], unconfirmed: ["silent"], retiredLinks: 1, xeroCalls: 3 });
    expect(stored("link-now-deleted-pay-local-1")).toMatchObject({ active: false, metadata: { invoiceId: INVOICE, status: "DELETED" } });
    expect(stored("link-now-deleted-pay-local-1").metadata).not.toHaveProperty("deletionCheckPending");
    expect(stored("link-live-pay-local-1")).toMatchObject({ active: true, metadata: { invoiceId: INVOICE } });
    expect(stored("link-live-pay-local-1").metadata).not.toHaveProperty("deletionCheckPending");
    expect(stored("link-silent-pay-local-1").metadata).toMatchObject({ deletionCheckPending: true, deletionCheckAttempts: 4 });
    expect(h.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ links: [expect.objectContaining({ xeroObjectId: "now-deleted" })] }));
  });

  it("asks least recently written first, so a link Xero never answers for rotates to the back", async () => {
    seedLink("silent", { metadata: { invoiceId: INVOICE, ...pending(1) } });
    const ids = Array.from({ length: MAX_DELETED_PAYMENT_CONFIRMATIONS_PER_RECONCILE }, (_, index) => `later-${index}`);
    for (const id of ids) seedLink(id, { metadata: { invoiceId: INVOICE, ...pending() } });
    h.getPayment.mockRejectedValue(new Error("404 Not Found"));

    await recheckPendingDeletedPaymentLinks({ minimumIntervalMs: 0 });
    expect(h.getPayment.mock.calls.map((call) => call[1])).toEqual(["silent", ...ids.slice(0, -1)]);

    h.getPayment.mockClear();
    await recheckPendingDeletedPaymentLinks({ minimumIntervalMs: 0 });
    expect(h.getPayment.mock.calls[0][1]).toBe(ids.at(-1));
  });

  it("judges a pending refund payment against its credit note, not the invoice it refunds", async () => {
    const refund = { role: "REFUND_PAYMENT", metadata: { invoiceId: INVOICE, creditNoteId: NOTE, ...pending() } };
    expect(documentNamedByLink(refund)).toEqual({ kind: "CREDIT_NOTE", id: NOTE });
    expect(documentNamedByLink({ role: "INVOICE_PAYMENT", metadata: { invoiceId: INVOICE, creditNoteId: NOTE } })).toEqual({ kind: "INVOICE", id: INVOICE });
    seedLink("refund-deleted", refund);
    h.getPayment.mockResolvedValue({ body: { payments: [{ paymentID: "refund-deleted", status: "DELETED", creditNote: { creditNoteID: "another-note" } }] } });
    expect(await recheckPendingDeletedPaymentLinks()).toMatchObject({ unconfirmed: ["refund-deleted"], retiredLinks: 0 });
  });

  it("claims its slot before any call, so two cycles at once spend the cap once", async () => {
    seedLink("deleted", { metadata: { invoiceId: INVOICE, ...pending() } });
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "AUTHORISED"));
    h.cursors.push({ resourceType: "DELETED_PAYMENT_RECHECK", scope: "default", lastSuccessfulSyncAt: new Date(Date.now() - DELETED_PAYMENT_RECHECK_MIN_INTERVAL_MS - 1) });
    const [first, second] = await Promise.all([recheckPendingDeletedPaymentLinks(), recheckPendingDeletedPaymentLinks()]);
    expect([first.skipped, second.skipped].filter(Boolean)).toHaveLength(1);
    expect(h.getPayment).toHaveBeenCalledTimes(1);
  });

  it(`stops asking on its own after ${MAX_DELETION_CHECK_ATTEMPTS} unanswered attempts`, async () => {
    seedLink("silent", { metadata: { invoiceId: INVOICE, ...pending(MAX_DELETION_CHECK_ATTEMPTS - 1) } });
    h.getPayment.mockRejectedValue(new Error("404 Not Found"));
    const outcome = await recheckPendingDeletedPaymentLinks({ minimumIntervalMs: 0 });
    expect(outcome).toMatchObject({ unconfirmed: ["silent"], gaveUp: ["silent"] });
    expect(stored("link-silent-pay-local-1")).toMatchObject({
      active: true,
      metadata: { deletionCheckPending: false, deletionCheckAttempts: MAX_DELETION_CHECK_ATTEMPTS, deletionCheckGaveUpAt: "2026-07-01T00:00:00.000Z" },
    });
    h.getPayment.mockClear();
    expect(await recheckPendingDeletedPaymentLinks({ minimumIntervalMs: 0 })).toMatchObject({ candidatePayments: 0 });
    expect(h.getPayment).not.toHaveBeenCalled();
  });

  it("an inbound read that finds a given-up payment live clears its marker", async () => {
    seedLink("live", { metadata: { invoiceId: INVOICE, deletionCheckPending: false, deletionCheckAttempts: 5, deletionCheckGaveUpAt: "x" } });
    h.getPayment.mockResolvedValue(xeroPayment("live", "AUTHORISED"));
    await retireDeletedPaymentLinksAbsentFromPayload({ session, document: { kind: "INVOICE", id: INVOICE }, payments: invoicePaymentsForAbsence(invoice()), localScope: SCOPE });
    expect(stored("link-live-pay-local-1").metadata).toEqual({ invoiceId: INVOICE });
  });

  it("judges a pending link against the document it names", async () => {
    seedLink("deleted", { metadata: { invoiceId: INVOICE, ...pending() } });
    h.getPayment.mockResolvedValue(xeroPayment("deleted", "DELETED", "another-invoice"));
    const outcome = await recheckPendingDeletedPaymentLinks();
    expect(outcome).toMatchObject({ unconfirmed: ["deleted"], retiredLinks: 0 });
  });
});
