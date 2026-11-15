import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// #2108: route-level coverage for the membership-type gating and zod refinements
// layered onto the Xero member import.

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockImport = vi.fn();
const errors = vi.hoisted(() => {
  class XeroDailyLimitError extends Error {}
  class XeroMemberImportValidationError extends Error {
    offenders: Array<{ membershipTypeId: string; reason: string }>;
    constructor(offenders: Array<{ membershipTypeId: string; reason: string }>) {
      super("invalid");
      this.offenders = offenders;
    }
  }
  return { XeroDailyLimitError, XeroMemberImportValidationError };
});
vi.mock("@/lib/xero-member-import", () => ({
  importMembersFromXeroGroups: (...a: unknown[]) => mockImport(...a),
  XeroMemberImportValidationError: errors.XeroMemberImportValidationError,
}));
vi.mock("@/lib/xero-api-client", () => ({
  XeroDailyLimitError: errors.XeroDailyLimitError,
}));
vi.mock("@/lib/audit", () => ({ getAuditRequestContext: () => ({}) }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "@/app/api/admin/xero/import-members/route";

function okGuard(userId = "admin_1") {
  return { ok: true as const, session: { user: { id: userId } } };
}

let financeOk = true;
let membershipOk = true;

function configureGuards() {
  mockRequireAdmin.mockImplementation(
    (options?: {
      permission?: { area?: string };
      forbiddenResponse?: () => NextResponse;
    }) => {
      const isMembershipCheck = options?.permission?.area === "membership";
      if (isMembershipCheck) {
        if (membershipOk) return okGuard();
        return {
          ok: false as const,
          response: options?.forbiddenResponse
            ? options.forbiddenResponse()
            : NextResponse.json({ error: "Forbidden" }, { status: 403 }),
        };
      }
      if (financeOk) return okGuard();
      return {
        ok: false as const,
        response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      };
    },
  );
}

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/xero/import-members", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  financeOk = true;
  membershipOk = true;
  configureGuards();
  mockImport.mockResolvedValue({ created: 1, assignmentsCreated: 0 });
});

describe("POST /api/admin/xero/import-members (#2108)", () => {
  it("tier-only import stays finance-gated and succeeds", async () => {
    const res = await POST(
      postReq({ groupMappings: [{ groupId: "g1", groupName: "Adults", ageTier: "ADULT" }] }),
    );
    expect(res.status).toBe(200);
    expect(mockImport).toHaveBeenCalledTimes(1);
    // Only the inferred (finance) guard runs — no membership check for tier-only.
    expect(
      mockRequireAdmin.mock.calls.every(
        ([opts]) => (opts as { permission?: { area?: string } } | undefined)?.permission?.area !== "membership",
      ),
    ).toBe(true);
  });

  it("rejects a finance-only admin when a mapping carries a membership type (403)", async () => {
    membershipOk = false;
    const res = await POST(
      postReq({
        groupMappings: [{ groupId: "g1", groupName: "Full", membershipTypeId: "type_full" }],
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/membership edit access/i);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("allows a membership-edit admin to import into types and passes adminMemberId", async () => {
    const res = await POST(
      postReq({
        groupMappings: [{ groupId: "g1", groupName: "Full", membershipTypeId: "type_full", ageTier: "ADULT" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(mockImport).toHaveBeenCalledTimes(1);
    const [, , options] = mockImport.mock.calls[0];
    expect(options).toMatchObject({ adminMemberId: "admin_1" });
  });

  it("rejects an explicit NOT_APPLICABLE tier (422)", async () => {
    const res = await POST(
      postReq({ groupMappings: [{ groupId: "g1", groupName: "Org", ageTier: "NOT_APPLICABLE" }] }),
    );
    expect(res.status).toBe(422);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("rejects a mapping with neither tier nor type (422)", async () => {
    const res = await POST(
      postReq({ groupMappings: [{ groupId: "g1", groupName: "Empty" }] }),
    );
    expect(res.status).toBe(422);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("rejects an over-long groupName (>200 chars) with 422", async () => {
    const res = await POST(
      postReq({
        groupMappings: [
          { groupId: "g1", groupName: "x".repeat(201), ageTier: "ADULT" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("maps a service membership-type validation error to 422 with offenders", async () => {
    mockImport.mockRejectedValue(
      new errors.XeroMemberImportValidationError([{ membershipTypeId: "type_x", reason: "inactive" }]),
    );
    const res = await POST(
      postReq({
        groupMappings: [{ groupId: "g1", groupName: "X", membershipTypeId: "type_x" }],
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.offenders).toEqual([{ membershipTypeId: "type_x", reason: "inactive" }]);
  });
});
