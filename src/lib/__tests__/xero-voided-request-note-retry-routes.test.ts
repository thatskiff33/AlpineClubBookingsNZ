/**
 * #4195 review F-A, #4214 (owner decision: the officer re-raises a voided
 * refund request note; nothing does it automatically).
 *
 * The Xero Operations doors - Retry all, a row's Retry and its Requeue - all
 * queue through the REAL `enqueueXeroSyncOperationRetry`, and the queued
 * retry's worker runs the REAL `retryXeroSyncOperation`. Over a fake ledger
 * holding a stale FAILED request-note row and the PARTIAL row whose retry
 * raised the request's note, which the treasurer then voided in Xero, every
 * door refuses with the #4214 reason and nothing is queued or raised.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  operations: [] as Row[],
  links: [] as Row[],
}));

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  auth: vi.fn(),
  logAudit: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  getFailedXeroOperationOverview: vi.fn(),
}));

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key] ?? null;
    if (expected && typeof expected === "object") {
      if ("in" in expected) return (expected as { in: unknown[] }).in.includes(actual);
      if ("not" in expected) return actual !== (expected as { not: unknown }).not;
      return true;
    }
    return actual === expected;
  });
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.operations.find((row) => row.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: Row }) => state.operations.find((row) => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Row }) => state.operations.filter((row) => matches(row, where))),
    },
    xeroObjectLink: {
      findMany: vi.fn(async ({ where }: { where: Row }) => state.links.filter((row) => matches(row, where))),
    },
  },
}));

vi.mock("next/server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("next/server")),
  after: mocks.after,
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn(async () => ({})) }));
vi.mock("@/lib/xero-admin-failures", () => ({ getFailedXeroOperationOverview: mocks.getFailedXeroOperationOverview }));
vi.mock("@/lib/xero-sync", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-sync")),
  startXeroSyncOperation: mocks.startXeroSyncOperation,
}));

import { POST as retryAll } from "@/app/api/admin/xero/operations/retry-all/route";
import { POST as retryOne } from "@/app/api/admin/xero/operations/[id]/retry/route";
import { POST as requeueOne } from "@/app/api/admin/xero/operations/[id]/requeue/route";
import { retryXeroSyncOperation } from "@/lib/xero-operation-retry";
import { VOIDED_REQUEST_NOTE_RETRY_REASON } from "@/lib/xero-refund-note-status";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const KEY = "payment:pay_1:refund-request-credit-note:rr_1:v1";
const queued = { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5000, refundMethod: "internet-banking", refundRequestId: "rr_1" };
const requestRow = (overrides: Row): Row => ({
  direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: "pay_1",
  replayable: true, manuallyResolvedAt: null, createdByMemberId: null, correlationKey: KEY, idempotencyKey: KEY,
  requestPayload: queued, xeroObjectId: null, responsePayload: null, queueType: "REFUND_CREDIT_NOTE", ...overrides,
});
const noteLink = (overrides: Row): Row => ({
  localModel: "Payment", localId: "pay_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_100", xeroObjectNumber: "CN-100",
  role: "REFUND_REQUEST_CREDIT_NOTE", metadata: { amountCents: 5000, refundRequestId: "rr_1", status: "VOIDED" }, ...overrides,
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (path: string) => new NextRequest(`http://localhost${path}`, { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
  mocks.startXeroSyncOperation.mockImplementation(async (input: Row) => ({ id: "queue_new", ...input }));
  state.operations = [
    // Row A failed before Xero raised anything...
    requestRow({ id: "op_a", status: "FAILED", createdAt: new Date("2026-06-01T00:00:00Z") }),
    // ...an inline retry R1 raised CN-100, whose payment then failed...
    requestRow({
      id: "op_r1", status: "PARTIAL", xeroObjectId: "cn_100", createdAt: new Date("2026-06-02T00:00:00Z"),
      requestPayload: { creditNotes: [], allocation: { invoiceId: "inv_1", amount: 50 }, refundMethod: "internet-banking", refundRequestId: "rr_1" },
    }),
  ];
  // ...and the treasurer voided CN-100: the inbound sync wrote its mirror off.
  state.links = [noteLink({ active: false })];
  mocks.getFailedXeroOperationOverview.mockResolvedValue({
    activeOperations: state.operations.map((row) => ({ id: row.id, replayable: true })),
    legacyFailedCount: 0,
  });
});

describe("#4214: no retry door re-raises a voided refund request note", () => {
  it("MUTATION: Retry all queues neither row, and says why", async () => {
    const response = await retryAll(new Request("http://localhost/api/admin/xero/operations/retry-all", { method: "POST" }));
    const body = await response.json();

    expect(body).toMatchObject({ queued: 0, skipped: 2 });
    expect(body.skippedOperations).toEqual([
      { id: "op_a", reason: VOIDED_REQUEST_NOTE_RETRY_REASON },
      { id: "op_r1", reason: VOIDED_REQUEST_NOTE_RETRY_REASON },
    ]);
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["Retry", retryOne, "/retry"],
    ["Requeue", requeueOne, "/requeue"],
  ] as const)("MUTATION: a row's %s is refused with 409 for either row", async (_door, handler, suffix) => {
    for (const id of ["op_a", "op_r1"]) {
      const response = await handler(request(`/api/admin/xero/operations/${id}${suffix}`), params(id));
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe(VOIDED_REQUEST_NOTE_RETRY_REASON);
    }
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("MUTATION: a retry queued before the void is refused by its worker too", async () => {
    await expect(retryXeroSyncOperation("op_a", CLUB_FORMAT_TEST)).rejects.toMatchObject({
      status: 409,
      message: VOIDED_REQUEST_NOTE_RETRY_REASON,
    });
  });

  it("a mirror left active before #4195 that records VOIDED is refused the same way", async () => {
    state.links = [noteLink({ active: true })];
    const response = await retryOne(request("/api/admin/xero/operations/op_a/retry"), params("op_a"));
    expect(response.status).toBe(409);
  });

  it("a live own note leaves Retry as it was", async () => {
    state.links = [noteLink({ active: true, metadata: { amountCents: 5000, refundRequestId: "rr_1" } })];
    const response = await retryOne(request("/api/admin/xero/operations/op_r1/retry"), params("op_r1"));
    expect(response.status).toBe(202);
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledTimes(1);
  });

  it("a request whose note was never raised can still be retried", async () => {
    state.operations = [requestRow({ id: "op_a", status: "FAILED", createdAt: new Date("2026-06-01T00:00:00Z") })];
    state.links = [];
    const response = await retryOne(request("/api/admin/xero/operations/op_a/retry"), params("op_a"));
    expect(response.status).toBe(202);
  });
});
