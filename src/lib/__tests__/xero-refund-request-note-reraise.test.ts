/**
 * #4214 (owner decision, 17 Oct 2026): the officer's "Raise a fresh credit
 * note" for a refund request whose own Xero credit note was voided in Xero.
 *
 * Over a fake ledger - the request's note row and its voided note's link - the
 * REAL `reraiseVoidedRefundRequestNote` and the REAL routes run: the action is
 * finance:edit (the list finance:view), it queues the request's note row under
 * the after-void key through the shared builder, its audit entry is written on
 * the same transaction, and every guard refuses with 409 before anything is
 * queued: a live note, no voided note, a row still in flight (the second
 * click), an amount that cannot be read, and a row resolved by hand. The
 * concurrent double click is proven on real PostgreSQL
 * (`xero-refund-request-note-reraise.realdb.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { matchesWhere as matches } from "./support/prisma-where";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  operations: [] as Row[],
  links: [] as Row[],
  audits: [] as Row[],
  calls: [] as string[],
}));

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  auth: vi.fn(),
  kick: vi.fn(),
  startXeroSyncOperation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      state.calls.push(strings.join("?").includes("FOR UPDATE") ? "lock" : "raw");
      return 0;
    }),
    xeroSyncOperation: {
      findMany: vi.fn(async ({ where, select }: { where: Row; select?: Row }) => {
        state.calls.push("read-rows");
        return state.operations.filter((row) => matches(row, where)).map((row) =>
          select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null])) : row,
        );
      }),
      findFirst: vi.fn(async ({ where }: { where: Row }) => state.operations.find((row) => matches(row, where)) ?? null),
      count: vi.fn(async ({ where }: { where: Row }) => state.operations.filter((row) => matches(row, where)).length),
    },
    xeroObjectLink: {
      findMany: vi.fn(async ({ where }: { where: Row }) => {
        state.calls.push("read-links");
        return state.links.filter((row) => matches(row, where));
      }),
    },
    payment: { findUnique: vi.fn(async () => ({ bookingId: "booking_1" })) },
    auditLog: { create: vi.fn(async ({ data }: { data: Row }) => void state.audits.push(data)) },
  };
  return {
    prisma: { ...client, $transaction: vi.fn(async (run: (tx: typeof client) => unknown) => run(client)) },
  };
});

vi.mock("next/server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("next/server")),
  after: mocks.after,
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/xero-operation-outbox", () => ({ kickQueuedXeroOutboxOperationsIfConnected: mocks.kick }));
vi.mock("@/lib/xero-link-short-code", () => ({ getXeroOrgShortCode: vi.fn(async () => null) }));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: vi.fn(async () => "Pacific/Auckland") }));
vi.mock("@/lib/xero-admin-failures", () => ({ resolveFailedXeroOperationStates: vi.fn(async () => new Map()) }));
vi.mock("@/lib/xero-sync", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-sync")),
  startXeroSyncOperation: mocks.startXeroSyncOperation,
}));

import { GET as listRoute } from "@/app/api/admin/xero/operations/voided-request-notes/route";
import { GET as listOperations } from "@/app/api/admin/xero/operations/route";
import { VOIDED_REQUEST_NOTE_RETRY_REASON } from "@/lib/xero-refund-note-status";
import { POST as reraiseRoute } from "@/app/api/admin/xero/operations/voided-request-notes/reraise/route";
import {
  listVoidedRefundRequestNotes,
  reraiseVoidedRefundRequestNote,
  voidedRequestNoteOperationIds,
} from "@/lib/xero-refund-request-note-reraise";

const KEY = "payment:pay_1:refund-request-credit-note:rr_1:v1";
const AFTER_VOID_KEY = `${KEY}:after-void:cn_100`;
const requestRow = (overrides: Row): Row => ({
  direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: "pay_1",
  manuallyResolvedAt: null, correlationKey: KEY, idempotencyKey: KEY, queueType: "REFUND_CREDIT_NOTE", xeroObjectId: null,
  requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5000, refundMethod: "internet-banking", refundRequestId: "rr_1" },
  ...overrides,
});
const noteLink = (overrides: Row): Row => ({
  localModel: "Payment", localId: "pay_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_100", xeroObjectNumber: "CN-100",
  role: "REFUND_REQUEST_CREDIT_NOTE", active: false, metadata: { amountCents: 5000, refundRequestId: "rr_1", status: "VOIDED" },
  ...overrides,
});
const ADMIN = { user: { id: "admin-1", role: "ADMIN", canLogin: true, accessRoles: ["ADMIN"] } };
const FINANCE_VIEWER = { user: { id: "viewer-1", role: "MEMBER", canLogin: true, accessRoles: ["FINANCE_USER"] } };
const body = { paymentId: "pay_1", refundRequestId: "rr_1" };
const post = (payload: unknown = body) =>
  new NextRequest("http://localhost/api/admin/xero/operations/voided-request-notes/reraise", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.audits = [];
  state.calls = [];
  mocks.auth.mockResolvedValue(ADMIN);
  let n = 0;
  mocks.startXeroSyncOperation.mockImplementation(async (input: Row) => {
    state.calls.push("queue");
    const row = requestRow({ id: `queue_${++n}`, ...input, store: undefined });
    state.operations.push(row);
    return row;
  });
  // The request's note was raised and succeeded, then the treasurer voided it in Xero.
  state.operations = [requestRow({ id: "op_raised", status: "SUCCEEDED", xeroObjectId: "cn_100" })];
  state.links = [noteLink({})];
});

describe("reraiseVoidedRefundRequestNote (#4214)", () => {
  it("MUTATION: queues the request's note under the after-void key, after locking its links, with an audit entry", async () => {
    const result = await reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" });

    expect(result).toEqual({ operationId: "queue_1", amountCents: 5000, correlationKey: AFTER_VOID_KEY, voidedNoteIds: ["cn_100"] });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
    expect(mocks.startXeroSyncOperation.mock.calls[0]![0]).toMatchObject({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "pay_1",
      status: "PENDING",
      correlationKey: AFTER_VOID_KEY,
      idempotencyKey: AFTER_VOID_KEY,
      requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5000, refundMethod: "internet-banking", refundRequestId: "rr_1" },
      createdByMemberId: "admin-1",
    });
    // The lock comes before every read the guard decides on, and the queue after them.
    expect(state.calls[0]).toBe("lock");
    expect(state.calls.at(-1)).toBe("queue");
    expect(state.audits).toEqual([
      expect.objectContaining({
        action: "xero.refund_request_note.reraised",
        category: "xero",
        memberId: "admin-1",
        targetId: "pay_1",
        entityType: "XeroSyncOperation",
        entityId: "queue_1",
      }),
    ]);
  });

  it("MUTATION: a second click is refused while the first's row is in flight, and queues nothing", async () => {
    await reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" });
    await expect(reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-2" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already queued"),
    });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
    expect(state.audits).toHaveLength(1);
  });

  it("MUTATION: refused while a live note of the request's own exists", async () => {
    state.links.push(noteLink({ xeroObjectId: "cn_200", xeroObjectNumber: "CN-200", active: true, metadata: { amountCents: 5000, refundRequestId: "rr_1" } }));
    await expect(reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("CN-200"),
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(state.audits).toEqual([]);
  });

  it("MUTATION: refused when no note of the request is recorded voided", async () => {
    state.links = [];
    await expect(reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("nothing to raise again"),
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("another request's voided note on the same payment is not this request's", async () => {
    state.links = [noteLink({ metadata: { amountCents: 5000, refundRequestId: "rr_2", status: "VOIDED" } })];
    await expect(reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("nothing to raise again"),
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("MUTATION: refused, failing closed, when the voided note's amount cannot be read", async () => {
    state.links = [noteLink({ metadata: { refundRequestId: "rr_1", status: "VOIDED" } })];
    state.operations = [requestRow({ id: "op_raised", status: "SUCCEEDED", xeroObjectId: "cn_100", requestPayload: { refundRequestId: "rr_1" } })];
    await expect(reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("cannot be read"),
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("refused when two voided notes of the request recorded different amounts", async () => {
    state.links.push(noteLink({ xeroObjectId: "cn_050", metadata: { amountCents: 4000, refundRequestId: "rr_1", status: "DELETED" } }));
    await expect(reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" })).rejects.toMatchObject({ status: 409 });
  });

  it("refused when an officer resolved the fresh note's row by hand in Xero", async () => {
    state.operations.push(
      requestRow({ id: "op_fresh", status: "FAILED", correlationKey: AFTER_VOID_KEY, idempotencyKey: AFTER_VOID_KEY, manuallyResolvedAt: new Date() }),
    );
    await expect(reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("resolved"),
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("a fresh note's row that failed before Xero raised anything may be raised again, under the same key", async () => {
    state.operations.push(requestRow({ id: "op_fresh", status: "FAILED", correlationKey: AFTER_VOID_KEY, idempotencyKey: AFTER_VOID_KEY }));
    const result = await reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" });
    expect(result.correlationKey).toBe(AFTER_VOID_KEY);
  });

  it.each([
    { correlationKey: AFTER_VOID_KEY, idempotencyKey: null, requestPayload: null },
    { correlationKey: null, idempotencyKey: AFTER_VOID_KEY, requestPayload: { damaged: true } },
  ])("refuses a resolved fresh note with unreadable payload using either request key: %j", async (identity) => {
    state.operations.push(requestRow({
      id: "op_fresh", status: "FAILED", manuallyResolvedAt: new Date(), ...identity,
    }));

    await expect(reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" })).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("resolved"),
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(state.audits).toEqual([]);
  });

  it("does not fence another request's re-raise because a different request has an unreadable resolved row", async () => {
    const otherKey = AFTER_VOID_KEY.replace(":rr_1:", ":rr_other:");
    state.operations.push(requestRow({
      id: "op_other", status: "FAILED", correlationKey: otherKey, idempotencyKey: otherKey,
      manuallyResolvedAt: new Date(), requestPayload: null,
    }));

    await expect(reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" })).resolves.toMatchObject({
      correlationKey: AFTER_VOID_KEY,
    });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
  });

  it("a second void names both voided notes in the key", async () => {
    state.links.push(noteLink({ xeroObjectId: "cn_090", metadata: { amountCents: 5000, refundRequestId: "rr_1", status: "VOIDED" } }));
    const result = await reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" });
    expect(result.correlationKey).toBe(`${KEY}:after-void:cn_090:cn_100`);
  });
});

describe("listVoidedRefundRequestNotes and the per-row reason (#4214)", () => {
  it("lists the request with its voided note, amount and no row in flight", async () => {
    expect(await listVoidedRefundRequestNotes()).toEqual([
      {
        paymentId: "pay_1",
        bookingId: "booking_1",
        refundRequestId: "rr_1",
        voidedNotes: [{ xeroObjectId: "cn_100", xeroObjectNumber: "CN-100", status: "VOIDED" }],
        amountCents: 5000,
        activeOperationId: null,
      },
    ]);
  });

  it("names the queued re-raise once one is in flight, and drops the request once its fresh note is live", async () => {
    await reraiseVoidedRefundRequestNote({ ...body, actingMemberId: "admin-1" });
    expect((await listVoidedRefundRequestNotes())[0]!.activeOperationId).toBe("queue_1");
    state.links.push(noteLink({ xeroObjectId: "cn_200", active: true, metadata: { amountCents: 5000, refundRequestId: "rr_1" } }));
    expect(await listVoidedRefundRequestNotes()).toEqual([]);
  });

  it("MUTATION: the operations list gives the request's row the reason, never a Retry, and points at the action", async () => {
    state.operations.push(requestRow({ id: "op_failed", status: "FAILED", createdAt: new Date("2026-06-01T00:00:00Z") }));
    state.operations.push(requestRow({ id: "op_other", localId: "pay_2", status: "FAILED", createdAt: new Date("2026-06-01T00:00:00Z") }));
    const response = await listOperations(new NextRequest("http://localhost/api/admin/xero/operations"));
    const rows = (await response.json()).data as Array<{ id: string; supported: boolean; reason: string | null; voidedRequestNote: boolean }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of ["op_raised", "op_failed"]) {
      expect(byId.get(id)).toMatchObject({ supported: false, reason: VOIDED_REQUEST_NOTE_RETRY_REASON, voidedRequestNote: true });
    }
    expect(VOIDED_REQUEST_NOTE_RETRY_REASON).toContain("Raise a fresh credit note");
    expect(byId.get("op_other")).toMatchObject({ voidedRequestNote: false });
  });

  it("marks the request's note rows, and only them, as voided with no live note", async () => {
    state.operations.push(requestRow({ id: "op_other", localId: "pay_2", status: "FAILED" }));
    const rows = state.operations.map((row) => row as Row & { id: string; localModel: string; localId: string; entityType: string; operationType: string; requestPayload: unknown });
    expect(await voidedRequestNoteOperationIds(rows)).toEqual(new Set(["op_raised"]));
  });
});

describe("the routes (#4214)", () => {
  it("MUTATION: the re-raise is finance:edit - a view-only finance admin is refused and nothing is queued", async () => {
    mocks.auth.mockResolvedValue(FINANCE_VIEWER);
    const response = await reraiseRoute(post());
    expect(response.status).toBe(403);
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(state.audits).toEqual([]);
  });

  it("the list is finance:view - a view-only finance admin reads it", async () => {
    mocks.auth.mockResolvedValue(FINANCE_VIEWER);
    const response = await listRoute();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([
      expect.objectContaining({ paymentId: "pay_1", refundRequestId: "rr_1", amountCents: 5000, paymentUrl: expect.any(String) }),
    ]);
  });

  it("an anonymous caller is refused both", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await listRoute()).status).toBe(401);
    expect((await reraiseRoute(post())).status).toBe(401);
  });

  it("queues with 202, kicks the outbox after the response, and a double click gets 409", async () => {
    const first = await reraiseRoute(post());
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ ok: true, queueOperationId: "queue_1" });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0]![0]();
    expect(mocks.kick).toHaveBeenCalledWith({ limit: 1 });

    const second = await reraiseRoute(post());
    expect(second.status).toBe(409);
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed body with 400 before touching the ledger", async () => {
    const response = await reraiseRoute(post({ paymentId: "pay_1" }));
    expect(response.status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it("still queues and kicks the outbox if after registration is unavailable", async () => {
    mocks.after.mockImplementationOnce(() => { throw new Error("No request scope"); });
    const response = await reraiseRoute(post());
    expect(response.status).toBe(202);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(mocks.kick).toHaveBeenCalledExactlyOnceWith({ limit: 1 });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
  });
});
