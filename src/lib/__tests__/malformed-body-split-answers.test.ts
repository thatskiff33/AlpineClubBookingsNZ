/**
 * #5407 item 27: routes that answered a body that is not JSON and a body of the
 * wrong shape with one message. A body that is not JSON now gets the shared
 * invalid-JSON 400; a body of the wrong shape keeps the route's own answer.
 * Two routes with no route tests of their own are covered here: the member's
 * membership-cancellation request (whose shape answer is a 422) and the
 * finance monthly-fact backfill (whose body is optional, and read only when it
 * says it is JSON).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { expectDefaultInvalidJsonAnswer, MALFORMED_JSON_BODY } from "./helpers/invalid-json-body";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  createMembershipCancellationRequest: vi.fn(),
  requireFinanceManagerApiAccess: vi.fn(),
  getLatestFinanceSyncRun: vi.fn(),
  backfillFinanceMonthlyFacts: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: () => "127.0.0.1",
  rateLimiters: { membershipCancellationRequest: { id: "membership-cancellation-request" } },
}));
vi.mock("@/lib/membership-cancellation-requests", () => ({
  createMembershipCancellationRequest: mocks.createMembershipCancellationRequest,
  getMembershipCancellationOverview: vi.fn(),
  MembershipCancellationRequestError: class extends Error {},
}));
vi.mock("@/lib/finance-api-auth", () => ({
  requireFinanceManagerApiAccess: mocks.requireFinanceManagerApiAccess,
}));
vi.mock("@/lib/finance-sync-storage", () => ({
  getLatestFinanceSyncRun: mocks.getLatestFinanceSyncRun,
}));
vi.mock("@/lib/finance-monthly-fact-backfill", () => ({
  backfillFinanceMonthlyFacts: mocks.backfillFinanceMonthlyFacts,
  DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS: 3,
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: () => null,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { POST as requestCancellation } from "@/app/api/member/membership-cancellation-requests/route";
import { POST as backfillMonthlyFacts } from "@/app/api/finance/sync/backfill-monthly-facts/route";

function post(path: string, body: string | undefined, contentType?: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : {},
    ...(body === undefined ? {} : { body }),
  });
}

describe("POST /api/member/membership-cancellation-requests (#5407)", () => {
  const path = "/api/member/membership-cancellation-requests";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.checkRateLimit.mockResolvedValue({ success: true, resetAt: 0 });
    mocks.createMembershipCancellationRequest.mockResolvedValue({ id: "mcr-1" });
  });

  it("answers a body that is not JSON with the shared 400 and creates nothing", async () => {
    const response = await requestCancellation(post(path, MALFORMED_JSON_BODY, "application/json"));

    await expectDefaultInvalidJsonAnswer(response);
    expect(mocks.createMembershipCancellationRequest).not.toHaveBeenCalled();
  });

  it("keeps its own 422 for a well-formed body of the wrong shape", async () => {
    const response = await requestCancellation(
      post(path, JSON.stringify({ participantMemberIds: [] }), "application/json"),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Invalid cancellation request payload" });
    expect(mocks.createMembershipCancellationRequest).not.toHaveBeenCalled();
  });

  it("creates the request for a valid body, as before", async () => {
    const response = await requestCancellation(
      post(
        path,
        JSON.stringify({ participantMemberIds: ["member-1"], acknowledgedWarning: true }),
        "application/json",
      ),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "mcr-1" });
  });
});

describe("POST /api/finance/sync/backfill-monthly-facts (#5407)", () => {
  const path = "/api/finance/sync/backfill-monthly-facts";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireFinanceManagerApiAccess.mockResolvedValue({ ok: true, member: { id: "admin-1" } });
    mocks.getLatestFinanceSyncRun.mockResolvedValue(null);
    mocks.backfillFinanceMonthlyFacts.mockResolvedValue({
      runId: "run-1",
      status: "SUCCEEDED",
      snapshotCount: 1,
      totalRowCount: 2,
      datasetResults: [],
    });
    mocks.createAuditLog.mockResolvedValue(undefined);
  });

  it("answers a JSON body that does not parse with the shared 400 and runs nothing", async () => {
    const response = await backfillMonthlyFacts(post(path, MALFORMED_JSON_BODY, "application/json"));

    await expectDefaultInvalidJsonAnswer(response);
    expect(mocks.backfillFinanceMonthlyFacts).not.toHaveBeenCalled();
  });

  it.each([
    ["no body and no content type", undefined, undefined],
    ["an empty JSON body", "", "application/json"],
    ["a body that does not say it is JSON", MALFORMED_JSON_BODY, "text/plain"],
  ])("runs with the defaults for %s", async (_label, body, contentType) => {
    const response = await backfillMonthlyFacts(post(path, body, contentType));

    expect(response.status).toBe(200);
    expect(mocks.backfillFinanceMonthlyFacts).toHaveBeenCalledWith(
      expect.objectContaining({ fromMonth: null, maxChunks: 3 }),
    );
  });

  it("refuses a JSON null body with a 400 and runs nothing, where it used to run the defaults", async () => {
    const response = await backfillMonthlyFacts(post(path, "null", "application/json"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid request body" });
    expect(mocks.backfillFinanceMonthlyFacts).not.toHaveBeenCalled();
  });

  it("passes a valid body's options through", async () => {
    const response = await backfillMonthlyFacts(
      post(path, JSON.stringify({ fromMonth: "2020-04", maxChunks: 5 }), "application/json"),
    );

    expect(response.status).toBe(200);
    expect(mocks.backfillFinanceMonthlyFacts).toHaveBeenCalledWith(
      expect.objectContaining({ fromMonth: "2020-04", maxChunks: 5 }),
    );
  });

  it("keeps its own answer for options of the wrong shape", async () => {
    const response = await backfillMonthlyFacts(
      post(path, JSON.stringify({ fromMonth: "April" }), "application/json"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "fromMonth must be a YYYY-MM month key" });
    expect(mocks.backfillFinanceMonthlyFacts).not.toHaveBeenCalled();
  });
});
