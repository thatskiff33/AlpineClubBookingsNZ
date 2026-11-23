import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { expectDefaultInvalidJsonAnswer, MALFORMED_JSON_BODY } from "./helpers/invalid-json-body";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    familyGroupMember: { findFirst: vi.fn() },
  },
}));
const mockRequireActiveSession = vi.fn();
const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: (...args: unknown[]) => mockRequireActiveSession(...args),
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { familyGroupJoinRequest: {}, api: {} },
}));
vi.mock("@/lib/member-partner-link", () => ({
  getPartnerLinkState: vi.fn(),
  getPendingPartnerInviteIntent: vi.fn(),
  listOneStepPartnerCandidates: vi.fn(),
  requestPartnerLink: vi.fn(),
  respondToPartnerLink: vi.fn(),
  removeOwnPartnerLink: vi.fn(),
  adminAssignPartnerLink: vi.fn(),
  adminRemovePartnerLink: vi.fn(),
}));
vi.mock("@/lib/partner-invite-token", () => ({
  cancelOwnPartnerInviteToken: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import {
  getPartnerLinkState,
  getPendingPartnerInviteIntent,
  listOneStepPartnerCandidates,
  requestPartnerLink,
  respondToPartnerLink,
  removeOwnPartnerLink,
  adminAssignPartnerLink,
  adminRemovePartnerLink,
} from "@/lib/member-partner-link";
import { cancelOwnPartnerInviteToken } from "@/lib/partner-invite-token";
import {
  GET as getPartnerLink,
  POST as postPartnerLink,
  PUT as putPartnerLink,
  DELETE as deletePartnerLink,
} from "@/app/api/members/partner-link/route";
import {
  POST as adminPostPartnerLink,
  DELETE as adminDeletePartnerLink,
} from "@/app/api/admin/members/[id]/partner-link/route";

const activeSession = { ok: true, session: { user: { id: "member-a" } } };
const guardDenied = {
  ok: false,
  response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
};

const emptyState = {
  confirmed: null,
  pendingIncoming: [],
  pendingOutgoing: [],
};

function makeRequest(method: string, body?: Record<string, unknown>, query = "") {
  return new NextRequest(`http://localhost/api/members/partner-link${query}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireActiveSession.mockResolvedValue(activeSession);
  mockRequireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
});

describe("GET /api/members/partner-link", () => {
  it("returns the guard response for unauthenticated requests", async () => {
    mockRequireActiveSession.mockResolvedValue(guardDenied);
    const res = await getPartnerLink(new Request("http://localhost/api/members/partner-link"));
    expect(res.status).toBe(401);
  });

  it("returns state, one-step candidates, and pending invite intent", async () => {
    vi.mocked(getPartnerLinkState).mockResolvedValue(emptyState);
    vi.mocked(listOneStepPartnerCandidates).mockResolvedValue([
      { id: "member-c", firstName: "Cora", lastName: "Ash", canLogin: false },
    ]);
    vi.mocked(getPendingPartnerInviteIntent).mockResolvedValue(null);

    const res = await getPartnerLink(new Request("http://localhost/api/members/partner-link"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.oneStepCandidates).toHaveLength(1);
    expect(body.pendingPartnerInvite).toBeNull();
    expect(getPartnerLinkState).toHaveBeenCalledWith("member-a");
    expect(listOneStepPartnerCandidates).toHaveBeenCalledWith("member-a");
  });
});

describe("POST /api/members/partner-link", () => {
  it("rejects a memberId target outside the caller's family groups (no probing)", async () => {
    vi.mocked(prisma.familyGroupMember.findFirst).mockResolvedValue(null as never);

    const res = await postPartnerLink(makeRequest("POST", { memberId: "stranger-1" }));
    expect(res.status).toBe(404);
    expect(requestPartnerLink).not.toHaveBeenCalled();
  });

  it("passes a family co-member id through to the service", async () => {
    vi.mocked(prisma.familyGroupMember.findFirst).mockResolvedValue({
      familyGroupId: "group-1",
    } as never);
    vi.mocked(requestPartnerLink).mockResolvedValue({
      ok: true,
      linkId: "link-1",
      status: "CONFIRMED",
      message: "done",
    });

    const res = await postPartnerLink(makeRequest("POST", { memberId: "member-c" }));
    expect(res.status).toBe(201);
    expect(requestPartnerLink).toHaveBeenCalledWith({
      initiatorMemberId: "member-a",
      targetEmail: undefined,
      targetMemberId: "member-c",
    });
  });

  it("requires exactly one of email or memberId", async () => {
    const both = await postPartnerLink(
      makeRequest("POST", { email: "a@b.nz", memberId: "member-c" })
    );
    expect(both.status).toBe(422);

    const neither = await postPartnerLink(makeRequest("POST", {}));
    expect(neither.status).toBe(422);
  });

  it("maps service errors to their status codes", async () => {
    vi.mocked(requestPartnerLink).mockResolvedValue({
      ok: false,
      status: 409,
      error: "a request between you two is already pending",
    });

    const res = await postPartnerLink(makeRequest("POST", { email: "b@x.nz" }));
    expect(res.status).toBe(409);
  });

  it("returns byte-identical by-email bodies for a real and a D9-suppressed request", async () => {
    const genericMessage =
      "If they're eligible, we've sent them a partner request. They can confirm or decline from their profile.";
    vi.mocked(requestPartnerLink).mockResolvedValueOnce({
      ok: true,
      linkId: "link-1",
      status: "PENDING",
      message: genericMessage,
    });
    const real = await postPartnerLink(makeRequest("POST", { email: "free@x.nz" }));

    vi.mocked(requestPartnerLink).mockResolvedValueOnce({
      ok: true,
      linkId: null,
      status: "PENDING",
      suppressed: true,
      message: genericMessage,
    });
    const suppressed = await postPartnerLink(makeRequest("POST", { email: "taken@x.nz" }));

    expect(real.status).toBe(201);
    expect(suppressed.status).toBe(201);
    const realBody = await real.text();
    const suppressedBody = await suppressed.text();
    expect(realBody).toBe(suppressedBody);
    // Neither the created link's id nor its status may leak into the reply.
    expect(realBody).not.toContain("link-1");
    expect(realBody).not.toContain("PENDING");
  });

  it("keeps the richer body for the family memberId path", async () => {
    vi.mocked(prisma.familyGroupMember.findFirst).mockResolvedValue({
      familyGroupId: "group-1",
    } as never);
    vi.mocked(requestPartnerLink).mockResolvedValue({
      ok: true,
      linkId: "link-2",
      status: "CONFIRMED",
      message: "Cora Ash has been recorded as your partner.",
    });

    const res = await postPartnerLink(makeRequest("POST", { memberId: "member-c" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ linkId: "link-2", status: "CONFIRMED" });
  });
});

describe("PUT /api/members/partner-link", () => {
  it("returns the guard response for unauthenticated requests", async () => {
    mockRequireActiveSession.mockResolvedValue(guardDenied);
    const res = await putPartnerLink(
      makeRequest("PUT", { linkId: "link-1", action: "accept" })
    );
    expect(res.status).toBe(401);
    expect(respondToPartnerLink).not.toHaveBeenCalled();
  });

  it("validates the action enum", async () => {
    const res = await putPartnerLink(
      makeRequest("PUT", { linkId: "link-1", action: "maybe" })
    );
    expect(res.status).toBe(422);
  });

  it("passes accept/decline through and maps the result", async () => {
    vi.mocked(respondToPartnerLink).mockResolvedValue({
      ok: true,
      linkId: "link-1",
      status: "CONFIRMED",
      message: "confirmed",
    });

    const res = await putPartnerLink(
      makeRequest("PUT", { linkId: "link-1", action: "accept" })
    );
    expect(res.status).toBe(200);
    expect(respondToPartnerLink).toHaveBeenCalledWith({
      memberId: "member-a",
      linkId: "link-1",
      action: "accept",
    });
  });

  it("maps service conflicts to their status codes", async () => {
    vi.mocked(respondToPartnerLink).mockResolvedValue({
      ok: false,
      status: 409,
      error: "already processed",
    });

    const res = await putPartnerLink(
      makeRequest("PUT", { linkId: "link-1", action: "decline" })
    );
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/members/partner-link", () => {
  it("requires a link id", async () => {
    const res = await deletePartnerLink(makeRequest("DELETE"));
    expect(res.status).toBe(400);
    expect(removeOwnPartnerLink).not.toHaveBeenCalled();
  });

  it("passes the caller's id and link id to the service", async () => {
    vi.mocked(removeOwnPartnerLink).mockResolvedValue({
      ok: true,
      linkId: "link-1",
      status: "REMOVED",
      message: "removed",
    });

    const res = await deletePartnerLink(makeRequest("DELETE", undefined, "?id=link-1"));
    expect(res.status).toBe(200);
    expect(removeOwnPartnerLink).toHaveBeenCalledWith({
      memberId: "member-a",
      linkId: "link-1",
    });
  });

  it("rejects a request carrying both a link id and an invite token id", async () => {
    const res = await deletePartnerLink(
      makeRequest("DELETE", undefined, "?id=link-1&inviteTokenId=pit-1")
    );
    expect(res.status).toBe(400);
    expect(removeOwnPartnerLink).not.toHaveBeenCalled();
    expect(cancelOwnPartnerInviteToken).not.toHaveBeenCalled();
  });

  it("cancels the caller's own partner invitation by token id (#1754)", async () => {
    vi.mocked(cancelOwnPartnerInviteToken).mockResolvedValue(true);

    const res = await deletePartnerLink(
      makeRequest("DELETE", undefined, "?inviteTokenId=pit-1")
    );
    expect(res.status).toBe(200);
    expect(cancelOwnPartnerInviteToken).toHaveBeenCalledWith({
      tokenId: "pit-1",
      memberId: "member-a",
    });
    expect(removeOwnPartnerLink).not.toHaveBeenCalled();
  });

  it("returns 404 when the invitation is not the caller's, unknown, or claimed", async () => {
    vi.mocked(cancelOwnPartnerInviteToken).mockResolvedValue(false);

    const res = await deletePartnerLink(
      makeRequest("DELETE", undefined, "?inviteTokenId=pit-1")
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/members/[id]/partner-link", () => {
  function makeAdminPost(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/admin/members/member-a/partner-link", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("requires partnerMemberId", async () => {
    const res = await adminPostPartnerLink(makeAdminPost({}), {
      params: Promise.resolve({ id: "member-a" }),
    });
    expect(res.status).toBe(422);
    expect(adminAssignPartnerLink).not.toHaveBeenCalled();
  });

  it("assigns between the routed member and the chosen partner", async () => {
    vi.mocked(adminAssignPartnerLink).mockResolvedValue({
      ok: true,
      linkId: "link-1",
      status: "CONFIRMED",
      message: "assigned",
    });

    const res = await adminPostPartnerLink(
      makeAdminPost({ partnerMemberId: "member-b" }),
      { params: Promise.resolve({ id: "member-a" }) }
    );
    expect(res.status).toBe(201);
    // #1769a: no notifyMember in the body → threaded through as undefined
    // (default = notify).
    expect(adminAssignPartnerLink).toHaveBeenCalledWith({
      adminMemberId: "admin-1",
      memberOneId: "member-a",
      memberTwoId: "member-b",
      notifyMember: undefined,
    });
  });

  it("threads notifyMember: false through to the service (#1769a)", async () => {
    vi.mocked(adminAssignPartnerLink).mockResolvedValue({
      ok: true,
      linkId: "link-1",
      status: "CONFIRMED",
      message: "assigned",
    });

    const res = await adminPostPartnerLink(
      makeAdminPost({ partnerMemberId: "member-b", notifyMember: false }),
      { params: Promise.resolve({ id: "member-a" }) }
    );
    expect(res.status).toBe(201);
    expect(adminAssignPartnerLink).toHaveBeenCalledWith(
      expect.objectContaining({ notifyMember: false })
    );
  });

  it("rejects a non-boolean notifyMember with 422 (#1769a)", async () => {
    const res = await adminPostPartnerLink(
      makeAdminPost({ partnerMemberId: "member-b", notifyMember: "false" }),
      { params: Promise.resolve({ id: "member-a" }) }
    );
    expect(res.status).toBe(422);
    expect(adminAssignPartnerLink).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/members/[id]/partner-link", () => {
  function makeDeleteRequest(linkId: string) {
    return new NextRequest(
      `http://localhost/api/admin/members/member-a/partner-link?id=${linkId}`,
      { method: "DELETE" }
    );
  }

  function makeDeleteRequestWithBody(linkId: string, body: Record<string, unknown>) {
    return new NextRequest(
      `http://localhost/api/admin/members/member-a/partner-link?id=${linkId}`,
      {
        method: "DELETE",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  it("scopes the removal to the routed member", async () => {
    vi.mocked(adminRemovePartnerLink).mockResolvedValue({
      ok: true,
      linkId: "link-1",
      status: "REMOVED",
      message: "removed",
    });

    const res = await adminDeletePartnerLink(makeDeleteRequest("link-1"), {
      params: Promise.resolve({ id: "member-a" }),
    });
    expect(res.status).toBe(200);
    // #1769a: a bodyless DELETE (silent pending removal) threads notifyMember
    // through as undefined.
    expect(adminRemovePartnerLink).toHaveBeenCalledWith({
      adminMemberId: "admin-1",
      linkId: "link-1",
      memberScopeId: "member-a",
      notifyMember: undefined,
    });
  });

  it("threads notifyMember: false from the request body (#1769a)", async () => {
    vi.mocked(adminRemovePartnerLink).mockResolvedValue({
      ok: true,
      linkId: "link-1",
      status: "REMOVED",
      message: "removed",
    });

    const res = await adminDeletePartnerLink(
      makeDeleteRequestWithBody("link-1", { notifyMember: false }),
      { params: Promise.resolve({ id: "member-a" }) }
    );
    expect(res.status).toBe(200);
    expect(adminRemovePartnerLink).toHaveBeenCalledWith(
      expect.objectContaining({
        linkId: "link-1",
        memberScopeId: "member-a",
        notifyMember: false,
      })
    );
  });

  it("rejects a non-boolean notifyMember body with 422 (#1769a)", async () => {
    const res = await adminDeletePartnerLink(
      makeDeleteRequestWithBody("link-1", { notifyMember: "false" }),
      { params: Promise.resolve({ id: "member-a" }) }
    );
    expect(res.status).toBe(422);
    expect(adminRemovePartnerLink).not.toHaveBeenCalled();
  });

  it("maps a scope miss (foreign link id) to 404", async () => {
    vi.mocked(adminRemovePartnerLink).mockResolvedValue({
      ok: false,
      status: 404,
      error: "Partner link not found.",
    });

    const res = await adminDeletePartnerLink(makeDeleteRequest("foreign-link"), {
      params: Promise.resolve({ id: "member-a" }),
    });
    expect(res.status).toBe(404);
  });

  // #5407 item 27: a bodyless or empty-bodied DELETE still means "no choice"
  // (the silent pending removal); a body that is present but not JSON used to
  // be swallowed as an empty one and now answers the shared invalid-JSON 400.
  it("treats an empty body with a JSON content type as no body", async () => {
    vi.mocked(adminRemovePartnerLink).mockResolvedValue({
      ok: true,
      linkId: "link-1",
      status: "REMOVED",
      message: "removed",
    });

    const res = await adminDeletePartnerLink(
      new NextRequest("http://localhost/api/admin/members/member-a/partner-link?id=link-1", {
        method: "DELETE",
        body: "",
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "member-a" }) }
    );
    expect(res.status).toBe(200);
    expect(adminRemovePartnerLink).toHaveBeenCalledWith(
      expect.objectContaining({ linkId: "link-1", notifyMember: undefined })
    );
  });

  it("refuses a JSON null body with the schema 422 and removes nothing (#5407)", async () => {
    const res = await adminDeletePartnerLink(
      new NextRequest("http://localhost/api/admin/members/member-a/partner-link?id=link-1", {
        method: "DELETE",
        body: "null",
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "member-a" }) }
    );
    expect(res.status).toBe(422);
    expect(adminRemovePartnerLink).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON and removes nothing (#5407)", async () => {
    const res = await adminDeletePartnerLink(
      new NextRequest("http://localhost/api/admin/members/member-a/partner-link?id=link-1", {
        method: "DELETE",
        body: MALFORMED_JSON_BODY,
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: "member-a" }) }
    );
    await expectDefaultInvalidJsonAnswer(res);
    expect(adminRemovePartnerLink).not.toHaveBeenCalled();
  });
});
