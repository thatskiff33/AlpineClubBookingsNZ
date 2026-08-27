import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// E10 (#1936): HTTP surface — the approval-preview route (gating, validation,
// wiring) and the PUT route threading personDecisions + mappingPreviewToken.

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  buildApprovalMappingPreview: vi.fn(),
  approveMemberApplication: vi.fn(),
  rejectMemberApplication: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/member-application-mapping", () => ({
  buildApprovalMappingPreview: h.buildApprovalMappingPreview,
}));
vi.mock("@/lib/nomination", () => ({
  approveMemberApplication: h.approveMemberApplication,
  rejectMemberApplication: h.rejectMemberApplication,
  MembershipApplicationError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/member-applications/[id]/approval-preview/route";
import { PUT } from "@/app/api/admin/member-applications/[id]/route";

const params = Promise.resolve({ id: "app-1" });

function post(body: unknown) {
  return new NextRequest("http://localhost/api/admin/member-applications/app-1/approval-preview", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function put(body: unknown) {
  return new NextRequest("http://localhost/api/admin/member-applications/app-1", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", accessRoles: ["ADMIN"] } },
  });
  h.buildApprovalMappingPreview.mockResolvedValue({
    body: { preview: { previewToken: "tok", persons: [], blockingErrors: [], hasMappings: true } },
    init: undefined,
  });
  h.approveMemberApplication.mockResolvedValue({
    application: { status: "APPROVED" },
    applicantMember: { id: "member-1" },
    createdMemberIds: [],
    mappedMemberIds: ["member-x"],
    warnings: [],
  });
  h.rejectMemberApplication.mockResolvedValue({ status: "REJECTED" });
});

describe("POST /approval-preview", () => {
  it("requires the membership:edit permission (E1 pattern)", async () => {
    const res = await POST(post({}), { params });
    expect(res.status).toBe(200);
    expect(h.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "membership", level: "edit" },
    });
  });

  it("returns 403 when the guard fails", async () => {
    h.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await POST(post({}), { params });
    expect(res.status).toBe(403);
    expect(h.buildApprovalMappingPreview).not.toHaveBeenCalled();
  });

  it("passes personDecisions, the current season, and the DB-verified actor to the engine", async () => {
    const personDecisions = { applicant: { mode: "MAP", memberId: "member-x" }, family: [] };
    const res = await POST(post({ personDecisions }), { params });
    expect(res.status).toBe(200);
    expect(h.buildApprovalMappingPreview).toHaveBeenCalledWith({
      applicationId: "app-1",
      personDecisions,
      seasonYear: 2026,
      actor: { id: "admin-1", isFullAdmin: true },
    });
  });

  it("marks a scoped (non-Full-Admin) session actor as isFullAdmin: false", async () => {
    h.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-2", accessRoles: ["ADMIN_MEMBERSHIP"] } },
    });
    const res = await POST(post({}), { params });
    expect(res.status).toBe(200);
    expect(h.buildApprovalMappingPreview).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { id: "admin-2", isFullAdmin: false } }),
    );
  });

  it("422s an invalid decision shape", async () => {
    const res = await POST(post({ personDecisions: { applicant: { mode: "NOPE" }, family: [] } }), { params });
    expect(res.status).toBe(422);
  });
});

describe("PUT threads mapping payload", () => {
  it("requires the membership:edit permission explicitly (matches the preview route)", async () => {
    const res = await PUT(put({ decision: "APPROVE" }), { params });
    expect(res.status).toBe(200);
    expect(h.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "membership", level: "edit" },
    });
  });

  it("passes personDecisions (arg 6) and mappingPreviewToken (arg 7)", async () => {
    const personDecisions = { applicant: { mode: "MAP", memberId: "member-x" }, family: [] };
    const res = await PUT(
      put({ decision: "APPROVE", personDecisions, mappingPreviewToken: "tok" }),
      { params },
    );
    expect(res.status).toBe(200);
    const call = h.approveMemberApplication.mock.calls[0];
    expect(call[5]).toEqual(personDecisions);
    expect(call[6]).toBe("tok");
  });

  it("stays all-CREATE (undefined decisions) when the field is omitted", async () => {
    const res = await PUT(put({ decision: "APPROVE" }), { params });
    expect(res.status).toBe(200);
    const call = h.approveMemberApplication.mock.calls[0];
    expect(call[5]).toBeUndefined();
    expect(call[6]).toBeUndefined();
  });

  it("422s unknown body keys (strict schema) so a mis-nested mapping payload cannot silently approve all-CREATE", async () => {
    const res = await PUT(
      put({ decision: "APPROVE", mappingToken: "tok", personDecision: {} }),
      { params },
    );
    expect(res.status).toBe(422);
    expect(h.approveMemberApplication).not.toHaveBeenCalled();
  });
});
