import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4421 (owner decision 26 Oct 2026, `INV-INT-028`): "Resolve by hand" on a
 * FAILED payment refund credit-note create that names no note of its own asks
 * for the Xero note's number, checks it with the #4162 hand-made answer's own
 * check, and records it with the resolve - on the row and as the payment's
 * tracked link - refused when any other create row or link here records it.
 * Every other row resolves as before.
 *
 * A fake database stands in for PostgreSQL (the real races and the link write
 * are in `resolve-records-refund-note.realdb.test.ts`); the Xero check and the
 * shared link writer are stubbed at `bank-refund-void-answer`, whose own
 * checks are pinned by `bank-refund-void-answer.test.ts`.
 */

type Row = Record<string, unknown> & { id: string };
type Link = Record<string, unknown> & { id: string };

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown> & { id: string }>(),
  links: [] as Array<Record<string, unknown> & { id: string }>,
  calls: [] as string[],
  /** Runs once, right after the next transaction commits. */
  afterCommit: null as null | (() => void),
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  createAuditLog: vi.fn(),
  verifyHandMadeRefundNote: vi.fn(),
  readPaymentHandMadeNoteExpectation: vi.fn(),
  writeHandMadeRefundNoteLink: vi.fn(),
  reconcileHandMadeNoteAfterRecording: vi.fn(),
  notifyXeroSyncError: vi.fn(),
}));

/** A small evaluator of the Prisma `where` shapes these writers use. */
const matching = vi.hoisted(() => {
  const condition = (value: unknown, c: unknown): boolean => {
    if (c === null) return value === null || value === undefined;
    if (c instanceof Date) return value instanceof Date && value.getTime() === c.getTime();
    if (typeof c === "object") {
      const op = c as { in?: unknown[]; not?: unknown; gte?: Date; lte?: Date };
      if (op.in) return op.in.includes(value ?? null);
      if ("not" in op) return !condition(value, op.not);
      if (op.gte) return value instanceof Date && value.getTime() >= op.gte.getTime();
      if (op.lte) return value instanceof Date && value.getTime() <= op.lte.getTime();
    }
    return value === c;
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, c]) => {
      if (key === "OR") return (c as Record<string, unknown>[]).some((clause) => matches(row, clause));
      if (key === "AND") return (c as Record<string, unknown>[]).every((clause) => matches(row, clause));
      if (key === "metadata") {
        const { path, equals } = c as { path: string[]; equals: unknown };
        return (row.metadata as Record<string, unknown> | null)?.[path[0]!] === equals;
      }
      return condition(row[key], c);
    });
  return { matches };
});

const fakeDb = vi.hoisted(() => {
  const label = (where: Record<string, unknown>) =>
    where.operationType === "REQUEUE"
      ? "read retries"
      : where.OR && (where.status as { in?: unknown } | undefined)?.in
        ? "read superseding runs"
        : where.xeroObjectType === "CREDIT_NOTE"
          ? "read rows recording the note"
          : "read live copies";
  const operations = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = state.rows.get(where.id);
      return row ? { ...row } : null;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      state.calls.push(label(where));
      const found = [...state.rows.values()].find((row) => matching.matches(row, where));
      return found ? { ...found } : null;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      state.calls.push("claim row");
      const row = state.rows.get(where.id as string);
      if (!row || !matching.matches(row, where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  const links = {
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      state.calls.push("read links recording the note");
      return state.links.filter((link) => matching.matches(link, where)).map((link) => ({ ...link }));
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      state.calls.push("retire link");
      const hit = state.links.filter((link) => matching.matches(link, where));
      for (const link of hit) Object.assign(link, data);
      return { count: hit.length };
    },
  };
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?").trim();
      state.calls.push(sql.includes("pg_advisory_xact_lock(1)") ? "lock(1)" : sql.includes('"Payment"') ? "lock Payment row" : sql);
      return 1;
    },
    xeroSyncOperation: operations,
    xeroObjectLink: links,
  };
  return {
    prisma: {
      ...tx,
      $transaction: async (run: (client: typeof tx) => Promise<unknown>) => {
        state.calls.push("BEGIN");
        const rows = new Map([...state.rows].map(([key, row]) => [key, { ...row }]));
        const linkCopies = state.links.map((link) => ({ ...link }));
        try {
          const result = await run(tx);
          state.calls.push("COMMIT");
          const after = state.afterCommit;
          state.afterCommit = null;
          after?.();
          return result;
        } catch (error) {
          state.rows.clear();
          for (const [key, row] of rows) state.rows.set(key, row);
          state.links.splice(0, state.links.length, ...linkCopies);
          state.calls.push("ROLLBACK");
          throw error;
        }
      },
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: fakeDb.prisma }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog, logAudit: vi.fn() }));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST,
}));
vi.mock("@/lib/bank-refund-void-answer", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bank-refund-void-answer")),
  verifyHandMadeRefundNote: mocks.verifyHandMadeRefundNote,
  readPaymentHandMadeNoteExpectation: mocks.readPaymentHandMadeNoteExpectation,
  writeHandMadeRefundNoteLink: mocks.writeHandMadeRefundNoteLink,
  reconcileHandMadeNoteAfterRecording: mocks.reconcileHandMadeNoteAfterRecording,
}));
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: mocks.notifyXeroSyncError }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { POST as resolveOperation } from "@/app/api/admin/xero/operations/[id]/resolve/route";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { refundNoteResolveShape, resolveCreditNotePrompt, type RefundNoteResolveRow } from "@/lib/xero-resolve-refund-note";
import {
  RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE,
  RESOLVE_NOTE_NOT_ASKED_MESSAGE,
  RESOLVE_NOTE_PARTIAL_NO_NOTE_MESSAGE,
  RESOLVE_NOTE_RETRY_RAN_MESSAGE,
  RESOLVE_NOTE_SUPERSEDED_MESSAGE,
  RESOLVE_NOTE_WITHDRAW_FAILED_MESSAGE,
} from "@/lib/bank-refund-void-follow-up-copy";
import { QUEUED_LIVE_COPY_REFUSAL } from "@/lib/xero-operation-resolve-guards";

/** A FAILED $200 refund note on pay_1, queued and never raised: no note of its own. */
function refundNoteRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "op_note",
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "pay_1",
    status: "FAILED",
    queueType: "REFUND_CREDIT_NOTE",
    requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 20_000, watermarkCents: 20_000, refundMethod: "internet-banking" },
    responsePayload: null,
    correlationKey: "payment:pay_1:refund-credit-note:20000:v2",
    idempotencyKey: "payment:pay_1:refund-credit-note:20000:v2",
    xeroObjectType: null,
    xeroObjectId: null,
    xeroObjectNumber: null,
    manuallyResolvedAt: null,
    manuallyResolvedReason: null,
    manuallyResolvedById: null,
    replayable: true,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** A queued retry of `op_note` (`buildXeroOperationRequeueCorrelationKey`). */
function requeueRow(overrides: Partial<Row>): Row {
  return {
    id: "op_requeue",
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "REQUEUE",
    correlationKey: "xero-operation:requeue:op_note",
    status: "PENDING",
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** The payment's link a resolve of `op_note` wrote for the officer's note. */
function resolveLink(overrides: Partial<Link> = {}): Link {
  return {
    id: "link_resolve",
    localModel: "Payment",
    localId: "pay_1",
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: "cn-hand",
    role: "REFUND_CREDIT_NOTE",
    active: true,
    metadata: { amountCents: 20_000, perDelta: true, recordedByHand: true, resolvedOperationId: "op_note", handBackTaskId: null, status: "AUTHORISED" },
    ...overrides,
  };
}

const VERIFIED = { creditNoteId: "cn-hand", creditNoteNumber: "CN-0123", amountCents: 20_000, status: "AUTHORISED", total: 200, updatedDateUTC: null };

function resolve(body: Record<string, unknown>, id = "op_note") {
  return resolveOperation(
    new NextRequest(`http://localhost/api/admin/xero/operations/${id}/resolve`, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
}

const withNumber = { reason: "Made the credit note by hand in Xero", creditNoteNumber: "CN-0123" };
const unresolved = { manuallyResolvedAt: null, xeroObjectId: null, xeroObjectNumber: null };

function refusalAudit(status: number) {
  return expect.objectContaining({
    action: "xero.operation.manually_resolved",
    category: "xero",
    outcome: "failure",
    metadata: expect.objectContaining({ operationId: "op_note", status }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.clear();
  state.links.length = 0;
  state.calls.length = 0;
  state.afterCommit = null;
  mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.readPaymentHandMadeNoteExpectation.mockResolvedValue({ xeroInvoiceId: "inv_1", ownerXeroContactId: "contact_1" });
  mocks.verifyHandMadeRefundNote.mockResolvedValue(VERIFIED);
  mocks.createAuditLog.mockResolvedValue(undefined);
  mocks.reconcileHandMadeNoteAfterRecording.mockResolvedValue(undefined);
  mocks.notifyXeroSyncError.mockResolvedValue(undefined);
  // The shared writer, as far as these tests need it: the link it leaves behind.
  mocks.writeHandMadeRefundNoteLink.mockImplementation(async (_tx: unknown, input: { records: { resolvedOperationId?: string } }) => {
    state.calls.push("write link");
    const existing = state.links.find((link) => link.id === "link_resolve");
    if (existing) Object.assign(existing, { active: true });
    else state.links.push(resolveLink({ metadata: { ...(resolveLink().metadata as object), resolvedOperationId: input.records.resolvedOperationId } }));
  });
});

describe("which rows 'Resolve by hand' asks a note number of (#4421)", () => {
  const shape = (overrides: Partial<Row>) => refundNoteResolveShape(refundNoteRow(overrides) as unknown as RefundNoteResolveRow);

  it("asks it of a FAILED payment refund note's create that names no note, sized on the row's own refund amount", () => {
    expect(shape({})).toEqual({ kind: "asks-number", paymentId: "pay_1", amountCents: 20_000 });
    // The executed shape, and a legacy row with no queue type, read the same way the coverage reader reads them.
    expect(shape({ queueType: null, requestPayload: { allocation: { invoiceId: "inv_1", amount: 150 }, creditNotes: [] } })).toEqual({ kind: "asks-number", paymentId: "pay_1", amountCents: 15_000 });
    // A note that names the invoice it credits is checked against that invoice's contact.
    expect(shape({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5_000, creditsInvoiceId: "inv_receipt" } })).toMatchObject({ creditsInvoiceId: "inv_receipt" });
    expect(resolveCreditNotePrompt(refundNoteRow() as unknown as RefundNoteResolveRow)).toEqual({
      resolveAsksCreditNoteNumber: true,
      resolveCreditNoteAmountCents: 20_000,
      resolveRefusal: null,
    });
  });

  it("MUTATION (FAILED only): a row naming its note, a refund request's note, a covered-by row, an account-credit note and every other row resolve as before", () => {
    expect(shape({ status: "PARTIAL", xeroObjectId: "cn-own" })).toEqual({ kind: "records-note" });
    // #4391's: a refund request's note, by its payload or by its key.
    expect(shape({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 30_000, refundRequestId: "rr_1" } })).toEqual({ kind: "other" });
    expect(shape({ correlationKey: "payment:pay_1:refund-request-credit-note:rr_1", idempotencyKey: null, requestPayload: null })).toEqual({ kind: "other" });
    expect(shape({ responsePayload: { coveredByExistingNote: true } })).toEqual({ kind: "other" });
    expect(shape({ queueType: "ACCOUNT_CREDIT_NOTE", requestPayload: { queueType: "ACCOUNT_CREDIT_NOTE", refundAmountCents: 20_000 } })).toEqual({ kind: "other" });
    expect(shape({ queueType: null, requestPayload: { creditNotes: [{ lineItems: [{ unitAmount: 200 }] }] } })).toEqual({ kind: "other" });
    expect(shape({ entityType: "INVOICE" })).toEqual({ kind: "other" });
    expect(shape({ localModel: "Member" })).toEqual({ kind: "other" });
    expect(shape({ direction: "INBOUND" })).toEqual({ kind: "other" });
  });

  it("MUTATION (PARTIAL, round 2): refuses a part-done refund note naming no note - readable or not - rather than resolving it as covered with no note on record", () => {
    for (const requestPayload of [refundNoteRow().requestPayload, null]) {
      expect(shape({ status: "PARTIAL", requestPayload })).toEqual({ kind: "refused", paymentId: "pay_1", message: RESOLVE_NOTE_PARTIAL_NO_NOTE_MESSAGE });
      expect(resolveCreditNotePrompt(refundNoteRow({ status: "PARTIAL", requestPayload }) as unknown as RefundNoteResolveRow).resolveRefusal).toBe(RESOLVE_NOTE_PARTIAL_NO_NOTE_MESSAGE);
    }
  });

  it("MUTATION (superseded, round 2): the panel says up front that a row a later run already raised is refused", () => {
    expect(resolveCreditNotePrompt(refundNoteRow() as unknown as RefundNoteResolveRow, true)).toEqual({
      resolveAsksCreditNoteNumber: false,
      resolveCreditNoteAmountCents: null,
      resolveRefusal: RESOLVE_NOTE_SUPERSEDED_MESSAGE,
    });
  });

  it("calls a refund note whose amount cannot be read refused, and the panel says why before anything is typed", () => {
    expect(shape({ requestPayload: null })).toEqual({ kind: "refused", paymentId: "pay_1", message: RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE });
    expect(resolveCreditNotePrompt(refundNoteRow({ requestPayload: null }) as unknown as RefundNoteResolveRow)).toEqual({
      resolveAsksCreditNoteNumber: false,
      resolveCreditNoteAmountCents: null,
      resolveRefusal: RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE,
    });
    expect(RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE).toMatch(/Mark non-replayable/);
  });
});

describe("Resolve by hand records the officer's note on a refund credit-note create (#4421)", () => {
  it("checks the note, then under lock(1) and the Payment row records it on the row and as the payment's link, and re-reads it after the commit", async () => {
    state.rows.set("op_note", refundNoteRow());

    const response = await resolve(withNumber);

    expect(response.status).toBe(200);
    expect((await response.json()).message).toContain("recording credit note CN-0123");
    expect(mocks.readPaymentHandMadeNoteExpectation).toHaveBeenCalledWith("pay_1", undefined);
    expect(mocks.verifyHandMadeRefundNote).toHaveBeenCalledWith(
      expect.objectContaining({ creditNoteNumber: "CN-0123", expectedAmountCents: 20_000, xeroInvoiceId: "inv_1", ownerXeroContactId: "contact_1" }),
    );
    expect(state.rows.get("op_note")).toMatchObject({
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn-hand",
      xeroObjectNumber: "CN-0123",
      manuallyResolvedReason: "Made the credit note by hand in Xero",
      manuallyResolvedById: "admin-1",
      manuallyResolvedAt: expect.any(Date),
    });
    // The Xero check ran before the transaction; lock(1), then the Payment row, then the reads, the claim and the link last.
    expect(state.calls.slice(state.calls.indexOf("BEGIN"), state.calls.indexOf("BEGIN") + 11)).toEqual([
      "BEGIN",
      "lock(1)",
      "lock Payment row",
      "read superseding runs",
      "read retries",
      "read live copies",
      "read rows recording the note",
      "read links recording the note",
      "claim row",
      "write link",
      "COMMIT",
    ]);
    expect(mocks.writeHandMadeRefundNoteLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentId: "pay_1", note: VERIFIED, records: { resolvedOperationId: "op_note" } }),
    );
    expect(mocks.reconcileHandMadeNoteAfterRecording).toHaveBeenCalledWith(VERIFIED, expect.objectContaining({ alertKey: "xero-resolve-hand-made-note" }));
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "success", metadata: expect.objectContaining({ creditNoteId: "cn-hand", creditNoteNumber: "CN-0123", amountCents: 20_000 }) }),
    );
  });

  it("MUTATION: refuses without a note number, audits the refusal, and writes nothing", async () => {
    state.rows.set("op_note", refundNoteRow());
    for (const body of [{ reason: "Made it in Xero" }, { reason: "Made it in Xero", creditNoteNumber: "   " }]) {
      const response = await resolve(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/Type the number of the credit note you made in Xero \(for example CN-0123\)/);
    }
    expect(mocks.verifyHandMadeRefundNote).not.toHaveBeenCalled();
    expect(state.rows.get("op_note")).toMatchObject(unresolved);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(refusalAudit(400));
    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
  });

  it("MUTATION: refuses a note number for a row that does not ask for one - it names its note, or takes none - and writes nothing", async () => {
    for (const row of [
      refundNoteRow({ status: "PARTIAL", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-own", xeroObjectNumber: "CN-0001" }),
      refundNoteRow({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 30_000, refundRequestId: "rr_1" } }),
      refundNoteRow({ entityType: "CONTACT", operationType: "UPDATE", localModel: "Member", queueType: null, requestPayload: null }),
    ]) {
      state.rows.clear();
      state.rows.set("op_note", row);
      const response = await resolve(withNumber);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe(RESOLVE_NOTE_NOT_ASKED_MESSAGE);
      expect(state.rows.get("op_note")).toMatchObject({ manuallyResolvedAt: null, xeroObjectId: row.xeroObjectId });
    }
    expect(mocks.verifyHandMadeRefundNote).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(refusalAudit(409));
  });

  it("passes the Xero check's refusal through in plain English, audits it with the number tried, and writes nothing", async () => {
    state.rows.set("op_note", refundNoteRow());
    mocks.verifyHandMadeRefundNote.mockRejectedValue(new ManualBookingPaymentError("Credit note CN-0123 is for $150.00 in Xero, not $200.00, so it does not record this refund.", 409));

    const response = await resolve(withNumber);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/not \$200\.00/);
    expect(state.calls).not.toContain("BEGIN");
    expect(state.rows.get("op_note")).toMatchObject(unresolved);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure", metadata: { operationId: "op_note", creditNoteNumber: "CN-0123", status: 409 } }),
    );
  });

  it("MUTATION: refuses a note another credit-note create row records - any payment, any status - and writes nothing", async () => {
    state.rows.set("op_note", refundNoteRow());
    state.rows.set("op_other", refundNoteRow({ id: "op_other", localId: "pay_2", status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-hand", xeroObjectNumber: "CN-0123" }));

    const response = await resolve(withNumber);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/CN-0123 is already recorded against another refund or booking here/);
    expect(state.rows.get("op_note")).toMatchObject(unresolved);
    expect(state.calls).not.toContain("claim row");
    expect(state.calls).toContain("ROLLBACK");
    expect(mocks.writeHandMadeRefundNoteLink).not.toHaveBeenCalled();
  });

  it("MUTATION: refuses a note any other link records - live or retired, this payment's or another's - and writes nothing", async () => {
    for (const link of [
      resolveLink({ id: "link_answer", metadata: { handBackTaskId: "task_1", resolvedOperationId: null } }),
      resolveLink({ id: "link_answer", active: false, metadata: { handBackTaskId: "task_1", resolvedOperationId: null } }),
      resolveLink({ id: "link_other_row", active: false, metadata: { resolvedOperationId: "op_elsewhere" } }),
      resolveLink({ id: "link_other_payment", localId: "pay_2", active: false }),
      // This row's own link, still live: the row records it already, so it is no withdrawn link to take back.
      resolveLink({ active: true }),
    ]) {
      state.rows.clear();
      state.links.length = 0;
      state.rows.set("op_note", refundNoteRow());
      state.links.push(link);
      const response = await resolve(withNumber);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/already recorded against another refund/);
      expect(state.rows.get("op_note")).toMatchObject(unresolved);
    }
    expect(mocks.writeHandMadeRefundNoteLink).not.toHaveBeenCalled();
  });

  it("MUTATION: takes back the link THIS row wrote and a withdrawal retired, so a withdrawn officer can resolve again with the same note", async () => {
    state.rows.set("op_note", refundNoteRow());
    state.links.push(resolveLink({ active: false }));

    const response = await resolve(withNumber);

    expect(response.status).toBe(200);
    expect(state.rows.get("op_note")).toMatchObject({ xeroObjectId: "cn-hand" });
    expect(state.links).toEqual([expect.objectContaining({ id: "link_resolve", active: true })]);
  });

  it("MUTATION (retry race): refuses when a retry of the row ran since the route read it, or is running, and writes nothing", async () => {
    for (const retry of [
      // Started and finished while the route checked Xero and waited for the lock (FAILED: it may still
      // have reached Xero; one that SUCCEEDED is refused as superseding the row, the more specific answer).
      (readAt: Date) => requeueRow({ status: "FAILED", startedAt: new Date(readAt.getTime() + 5), completedAt: new Date(readAt.getTime() + 9) }),
      // Started before the read, finished after it.
      (readAt: Date) => requeueRow({ status: "FAILED", startedAt: new Date(readAt.getTime() - 50), completedAt: new Date(readAt.getTime() + 1) }),
      // Still running.
      () => requeueRow({ status: "RUNNING", startedAt: new Date("2026-06-30T00:00:00.000Z") }),
    ]) {
      state.rows.clear();
      state.rows.set("op_note", refundNoteRow());
      // The retry appears during the Xero check: after the route's read.
      mocks.verifyHandMadeRefundNote.mockImplementationOnce(async () => {
        state.rows.set("op_requeue", retry(new Date()));
        return VERIFIED;
      });
      const response = await resolve(withNumber);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe(RESOLVE_NOTE_RETRY_RAN_MESSAGE);
      expect(state.rows.get("op_note")).toMatchObject(unresolved);
    }
    expect(mocks.writeHandMadeRefundNoteLink).not.toHaveBeenCalled();
  });

  it("is not refused by a retry that finished before the route read the row, or one that stood down", async () => {
    state.rows.set("op_note", refundNoteRow());
    state.rows.set("op_requeue", requeueRow({ status: "FAILED", startedAt: new Date("2026-06-29T00:00:00.000Z"), completedAt: new Date("2026-06-29T00:00:05.000Z") }));
    state.rows.set("op_requeue_2", requeueRow({ id: "op_requeue_2", status: "CANCELLED", startedAt: new Date("2026-06-29T00:00:00.000Z"), completedAt: new Date("2099-01-01T00:00:00.000Z") }));

    const response = await resolve(withNumber);

    expect(response.status).toBe(200);
  });

  it("MUTATION (withdrawal): a retry found running after the commit withdraws the mark, the note and the link together, under lock(1) and the Payment row, and audits it", async () => {
    // A non-null type before the claim, so a restore is told from "always null".
    state.rows.set("op_note", refundNoteRow({ xeroObjectType: "LEGACY_TYPE" }));
    // A drain that claimed its queued retry just as the claim committed.
    state.afterCommit = () => state.rows.set("op_requeue", requeueRow({ status: "RUNNING", startedAt: new Date() }));

    const response = await resolve(withNumber);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/retry of this Xero operation is running/);
    expect(state.rows.get("op_note")).toMatchObject({
      manuallyResolvedAt: null,
      manuallyResolvedReason: null,
      manuallyResolvedById: null,
      xeroObjectType: "LEGACY_TYPE",
      xeroObjectId: null,
      xeroObjectNumber: null,
    });
    expect(state.links).toEqual([expect.objectContaining({ id: "link_resolve", active: false })]);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
        metadata: { operationId: "op_note", creditNoteId: "cn-hand", creditNoteNumber: "CN-0123", amountCents: 20_000, result: "withdrawn: retry running", status: 409 },
      }),
    );
    const withdrawal = state.calls.slice(state.calls.lastIndexOf("BEGIN"));
    expect(withdrawal).toEqual(["BEGIN", "lock(1)", "lock Payment row", "claim row", "retire link", "COMMIT"]);
    expect(mocks.reconcileHandMadeNoteAfterRecording).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
  });

  it("MUTATION (withdrawal fails, round 2): the mark and link stay, so a refund-ledger alert names the operation and the note, the failure is audited and the officer told", async () => {
    state.rows.set("op_note", refundNoteRow());
    state.afterCommit = () => state.rows.set("op_requeue", requeueRow({ status: "RUNNING", startedAt: new Date() }));
    // The claim commits; the withdrawal's transaction fails (a lock timeout, say).
    let calls = 0;
    const real = fakeDb.prisma.$transaction;
    const failing = vi.spyOn(fakeDb.prisma, "$transaction").mockImplementation((async (run: never) => {
      calls += 1;
      if (calls === 2) throw new Error("canceling statement due to lock timeout");
      return real(run);
    }) as never);

    const response = await resolve(withNumber);
    failing.mockRestore();

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe(RESOLVE_NOTE_WITHDRAW_FAILED_MESSAGE);
    expect(mocks.notifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "refund-ledger-divergence",
        operation: "xero-resolve-withdraw:op_note",
        errorMessage: expect.stringContaining("credit note CN-0123"),
      }),
    );
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure", metadata: expect.objectContaining({ creditNoteId: "cn-hand", result: "withdrawal failed: retry running" }) }),
    );
    // What the alert is about: the mark and the live link are still there.
    expect(state.rows.get("op_note")).toMatchObject({ xeroObjectId: "cn-hand", manuallyResolvedAt: expect.any(Date) });
    expect(state.links).toEqual([expect.objectContaining({ active: true })]);
  });

  it("MUTATION (superseded, round 2): refuses a row a later run already raised - its retry, or another create of the same note, SUCCEEDED or PARTIAL at any time - and writes nothing", async () => {
    for (const run of [
      requeueRow({ status: "SUCCEEDED", startedAt: new Date("2026-06-01T00:00:00.000Z"), completedAt: new Date("2026-06-01T00:00:05.000Z") }),
      requeueRow({ status: "PARTIAL", startedAt: new Date("2026-06-01T00:00:00.000Z"), completedAt: new Date("2026-06-01T00:00:05.000Z") }),
      refundNoteRow({ id: "op_inline", status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-0200", xeroObjectNumber: "CN-0200" }),
      refundNoteRow({ id: "op_inline", status: "PARTIAL", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-0200", xeroObjectNumber: "CN-0200" }),
    ]) {
      state.rows.clear();
      state.rows.set("op_note", refundNoteRow());
      state.rows.set(run.id, run);
      const response = await resolve(withNumber);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe(RESOLVE_NOTE_SUPERSEDED_MESSAGE);
      expect(state.rows.get("op_note")).toMatchObject(unresolved);
    }
    expect(mocks.verifyHandMadeRefundNote).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(refusalAudit(409));
    // Another payment's create with the same key is not this note's run.
    state.rows.clear();
    state.rows.set("op_note", refundNoteRow());
    state.rows.set("op_inline", refundNoteRow({ id: "op_inline", localId: "pay_2", status: "SUCCEEDED", xeroObjectId: "cn-0200" }));
    expect((await resolve(withNumber)).status).toBe(200);
  });

  it("MUTATION (superseded under the lock, round 2): a run that raised the note while the route checked Xero is refused by the claim", async () => {
    state.rows.set("op_note", refundNoteRow());
    mocks.verifyHandMadeRefundNote.mockImplementationOnce(async () => {
      state.rows.set("op_inline", refundNoteRow({ id: "op_inline", status: "SUCCEEDED", startedAt: new Date("2026-06-01T00:00:00.000Z"), xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-0200" }));
      return VERIFIED;
    });

    const response = await resolve(withNumber);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(RESOLVE_NOTE_SUPERSEDED_MESSAGE);
    expect(state.calls).toContain("ROLLBACK");
    expect(state.rows.get("op_note")).toMatchObject(unresolved);
  });

  it("MUTATION (live copy under the lock, round 2): a fresh copy queued while the route checked Xero is refused by the claim", async () => {
    state.rows.set("op_note", refundNoteRow());
    mocks.verifyHandMadeRefundNote.mockImplementationOnce(async () => {
      state.rows.set("op_copy", refundNoteRow({ id: "op_copy", status: "PENDING" }));
      return VERIFIED;
    });

    const response = await resolve(withNumber);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(QUEUED_LIVE_COPY_REFUSAL);
    expect(state.calls).toContain("ROLLBACK");
    expect(state.rows.get("op_note")).toMatchObject(unresolved);
  });

  describe("#4692 review (finding 2): a row holding an unrecorded note is never refused for good over a copy its fence holds", () => {
    const stamped = (overrides: Partial<Row> = {}) => refundNoteRow({ lastErrorCode: "REFUND_NOTE_UNRECORDED", ...overrides });

    it("MUTATION: resolves over a PENDING copy of the same refund (re-queued after Mark failed), which the fence keeps from minting", async () => {
      state.rows.set("op_note", stamped());
      state.rows.set("op_copy", refundNoteRow({ id: "op_copy", status: "PENDING" }));

      const response = await resolve(withNumber);

      expect(response.status).toBe(200);
      expect(state.rows.get("op_note")).toMatchObject({ xeroObjectId: "cn-hand", xeroObjectNumber: "CN-0123", manuallyResolvedAt: expect.any(Date) });
      // The copy is left to the outbox, which closes it CANCELLED at its next claim (`findResolvedSiblingSince`).
      expect(state.rows.get("op_copy")).toMatchObject({ status: "PENDING" });
    });

    it("MUTATION: resolves over a PENDING copy queued while the route checked Xero (the claim's re-check under the locks)", async () => {
      state.rows.set("op_note", stamped());
      mocks.verifyHandMadeRefundNote.mockImplementationOnce(async () => {
        state.rows.set("op_copy", refundNoteRow({ id: "op_copy", status: "PENDING" }));
        return VERIFIED;
      });

      expect((await resolve(withNumber)).status).toBe(200);
    });

    it("still refuses over a copy RUNNING now: it is past the fence's read, or about to be", async () => {
      state.rows.set("op_note", stamped());
      state.rows.set("op_copy", refundNoteRow({ id: "op_copy", status: "RUNNING", startedAt: new Date("2026-07-01T00:00:00.000Z") }));

      const response = await resolve(withNumber);

      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe(QUEUED_LIVE_COPY_REFUSAL);
      expect(state.rows.get("op_note")).toMatchObject(unresolved);
    });
  });

  it("MUTATION (audit, round 2): every refusal of a resolve that offered a number is audited, whichever check refused it", async () => {
    const cases: Array<[Row, Row | null]> = [
      [refundNoteRow({ status: "RUNNING" }), null],
      [refundNoteRow({ status: "SUCCEEDED" }), null],
      [refundNoteRow({ entityType: "ALLOCATION", operationType: "UPDATE", queueType: "APPLIED_CREDIT_ALLOCATION" }), null],
      [refundNoteRow(), refundNoteRow({ id: "op_copy", status: "PENDING" })],
      [refundNoteRow({ manuallyResolvedAt: new Date("2026-06-30T00:00:00.000Z"), xeroObjectId: "cn-first", xeroObjectNumber: "CN-0001" }), null],
    ];
    for (const [row, beside] of cases) {
      state.rows.clear();
      mocks.createAuditLog.mockClear();
      state.rows.set("op_note", row);
      if (beside) state.rows.set(beside.id, beside);
      const response = await resolve(withNumber);
      expect(response.status).toBe(409);
      expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
      expect(mocks.createAuditLog).toHaveBeenCalledWith(refusalAudit(409));
    }
  });

  it("MUTATION: claims the row status-guarded - a row that names a note or was resolved since the read loses, and nothing is written", async () => {
    const unlockedRead = refundNoteRow();
    const findUnique = vi.spyOn(fakeDb.prisma.xeroSyncOperation, "findUnique");
    findUnique.mockResolvedValueOnce(unlockedRead as never);
    state.rows.set("op_note", refundNoteRow({ status: "PARTIAL", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-own" }));

    const response = await resolve(withNumber);
    findUnique.mockRestore();

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/changed while it was being resolved/);
    expect(state.rows.get("op_note")).toMatchObject({ manuallyResolvedAt: null, xeroObjectId: "cn-own" });
    expect(mocks.writeHandMadeRefundNoteLink).not.toHaveBeenCalled();
  });

  it("MUTATION: refuses when the row's amount under the lock is not the amount the note was checked against, and writes nothing", async () => {
    state.rows.set("op_note", refundNoteRow({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 15_000 } }));
    const findUnique = vi.spyOn(fakeDb.prisma.xeroSyncOperation, "findUnique");
    findUnique.mockResolvedValueOnce(refundNoteRow() as never);

    const response = await resolve(withNumber);
    findUnique.mockRestore();

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/amount changed while you were resolving it/);
    expect(state.rows.get("op_note")).toMatchObject(unresolved);
  });

  it("MUTATION: the claim's own guard holds even past the re-read: it writes only an unresolved FAILED row naming no note", async () => {
    state.rows.set("op_note", refundNoteRow());
    const updateMany = vi.spyOn(fakeDb.prisma.xeroSyncOperation, "updateMany");

    await resolve(withNumber);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "op_note", status: "FAILED", manuallyResolvedAt: null, xeroObjectId: null },
      data: expect.objectContaining({ xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-hand", xeroObjectNumber: "CN-0123" }),
    });
    updateMany.mockRestore();
  });

  it("tells a second officer who offered a note which note the first resolve recorded", async () => {
    const markedAt = new Date("2026-06-30T00:00:00.000Z");
    state.rows.set("op_note", refundNoteRow({ manuallyResolvedAt: markedAt, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-first", xeroObjectNumber: "CN-0001" }));

    const other = await resolve(withNumber);
    expect(other.status).toBe(409);
    expect((await other.json()).error).toMatch(/already resolved, recording credit note CN-0001/);

    const same = await resolve({ ...withNumber, creditNoteNumber: "CN-0001" });
    expect(same.status).toBe(200);
    expect((await same.json()).message).toMatch(/already resolved, recording credit note CN-0001/);
    expect(state.rows.get("op_note")).toMatchObject({ xeroObjectId: "cn-first" });
  });

  it("refuses a refund note whose amount cannot be read, pointing at Mark non-replayable, and writes nothing", async () => {
    state.rows.set("op_note", refundNoteRow({ requestPayload: null }));

    const response = await resolve(withNumber);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE);
    expect(mocks.verifyHandMadeRefundNote).not.toHaveBeenCalled();
    expect(state.rows.get("op_note")).toMatchObject({ manuallyResolvedAt: null });
  });

  it("audits a refused refund-note row's refusal even when no number came with the request (review round 3)", async () => {
    const noNumber = { reason: "Made the credit note by hand in Xero" };
    for (const [row, message] of [
      [refundNoteRow({ requestPayload: null }), RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE],
      [refundNoteRow({ status: "PARTIAL" }), RESOLVE_NOTE_PARTIAL_NO_NOTE_MESSAGE],
    ] as const) {
      mocks.createAuditLog.mockClear();
      state.rows.set("op_note", row);
      const response = await resolve(noNumber);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe(message);
      expect(mocks.createAuditLog).toHaveBeenCalledWith(refusalAudit(409));
      expect(state.rows.get("op_note")).toMatchObject({ manuallyResolvedAt: null });
    }
  });

  it("resolves a refund request's note, a row naming its note and any other row exactly as before: no number, no lock, no note written", async () => {
    for (const row of [
      refundNoteRow({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 30_000, refundRequestId: "rr_1" } }),
      refundNoteRow({ status: "PARTIAL", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-own", xeroObjectNumber: "CN-0001" }),
      refundNoteRow({ entityType: "CONTACT", operationType: "UPDATE", localModel: "Member", queueType: null, requestPayload: null }),
    ]) {
      state.rows.clear();
      state.calls.length = 0;
      state.rows.set("op_note", row);
      const before = { xeroObjectType: row.xeroObjectType, xeroObjectId: row.xeroObjectId, xeroObjectNumber: row.xeroObjectNumber };

      const response = await resolve({ reason: "Fixed by hand in Xero" });

      expect(response.status).toBe(200);
      expect(state.calls).not.toContain("BEGIN");
      expect(state.rows.get("op_note")).toMatchObject({ ...before, manuallyResolvedAt: expect.any(Date) });
    }
    expect(mocks.verifyHandMadeRefundNote).not.toHaveBeenCalled();
    expect(mocks.writeHandMadeRefundNoteLink).not.toHaveBeenCalled();
  });
});
