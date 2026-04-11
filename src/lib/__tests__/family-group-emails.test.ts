import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Template tests (no mocking needed) ────────────────────────────────────

describe("Family group email templates", () => {
  it("familyGroupInvitationTemplate includes inviter name and group name", async () => {
    const { familyGroupInvitationTemplate } = await import("../email-templates");
    const html = familyGroupInvitationTemplate("Jane Doe", "Doe Family", "https://example.com/profile");

    expect(html).toContain("Jane Doe");
    expect(html).toContain("Doe Family");
    expect(html).toContain("https://example.com/profile");
    expect(html).toContain("View Invitation");
  });

  it("familyGroupInvitationTemplate escapes HTML in names", async () => {
    const { familyGroupInvitationTemplate } = await import("../email-templates");
    const html = familyGroupInvitationTemplate("<b>Evil</b>", "<script>alert(1)</script>", "https://x.com");

    expect(html).not.toContain("<b>Evil</b>");
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(html).not.toContain("<script>");
  });

  it("familyGroupInviteAcceptedTemplate includes invitee name and group name", async () => {
    const { familyGroupInviteAcceptedTemplate } = await import("../email-templates");
    const html = familyGroupInviteAcceptedTemplate("Alice Smith", "Smith Family");

    expect(html).toContain("Alice Smith");
    expect(html).toContain("Smith Family");
    expect(html).toContain("Invitation Accepted");
  });

  it("childRequestSubmittedTemplate includes parent name, child name, and group", async () => {
    const { childRequestSubmittedTemplate } = await import("../email-templates");
    const html = childRequestSubmittedTemplate("Bob", "Bobby Jr", "Johnson Family");

    expect(html).toContain("Bob");
    expect(html).toContain("Bobby Jr");
    expect(html).toContain("Johnson Family");
    expect(html).toContain("submitted");
  });

  it("childRequestApprovedTemplate includes parent name, child name, and group", async () => {
    const { childRequestApprovedTemplate } = await import("../email-templates");
    const html = childRequestApprovedTemplate("Carol", "Timmy", "Taylor Family");

    expect(html).toContain("Carol");
    expect(html).toContain("Timmy");
    expect(html).toContain("Taylor Family");
    expect(html).toContain("added to your family group");
  });

  it("childRequestRejectedTemplate includes parent name and child name", async () => {
    const { childRequestRejectedTemplate } = await import("../email-templates");
    const html = childRequestRejectedTemplate("Dave", "Susie", "Child is not registered");

    expect(html).toContain("Dave");
    expect(html).toContain("Susie");
    expect(html).toContain("not approved");
    expect(html).toContain("Child is not registered");
  });

  it("childRequestRejectedTemplate works without reason", async () => {
    const { childRequestRejectedTemplate } = await import("../email-templates");
    const html = childRequestRejectedTemplate("Dave", "Susie");

    expect(html).toContain("Dave");
    expect(html).toContain("not approved");
    // Should not contain admin note box
    expect(html).not.toContain("Admin note:");
  });
});

// ── Route integration tests ──────────────────────────────────────────────

vi.mock("../prisma", () => ({
  prisma: {
    member: {
      count: vi.fn(),
findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    familyGroup: {
      findUnique: vi.fn(),
    },
    familyGroupJoinRequest: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    familyGroupMember: {
      upsert: vi.fn(),
    },
    $transaction: vi.fn((fn: (tx: any) => any) =>
      fn({
        familyGroupMember: { upsert: vi.fn() },
        familyGroupJoinRequest: { update: vi.fn() },
      })
    ),
  },
}));

vi.mock("../email", () => ({
  sendFamilyGroupInvitationEmail: vi.fn(),
  sendFamilyGroupInviteAcceptedEmail: vi.fn(),
  sendChildRequestSubmittedEmail: vi.fn(),
  sendChildRequestApprovedEmail: vi.fn(),
  sendChildRequestRejectedEmail: vi.fn(),
  sendAdminFamilyGroupRequestAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../auth", () => ({
  auth: vi.fn(),
}));

vi.mock("../audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("../logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../rate-limit", () => ({
  applyRateLimit: vi.fn(() => null),
  rateLimiters: { familyGroupJoinRequest: {} },
}));

import { prisma } from "../prisma";
import { auth } from "../auth";
import {
  sendFamilyGroupInvitationEmail,
  sendFamilyGroupInviteAcceptedEmail,
  sendChildRequestSubmittedEmail,
} from "../email";

const mockedAuth = vi.mocked(auth);
const mockedSendInvitation = vi.mocked(sendFamilyGroupInvitationEmail);
const mockedSendInviteAccepted = vi.mocked(sendFamilyGroupInviteAcceptedEmail);
const mockedSendChildSubmitted = vi.mocked(sendChildRequestSubmittedEmail);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/members/family/invite — email sending", () => {
  it("should send invitation email on successful invite", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "u1", role: "MEMBER", email: "inviter@test.com" },
    } as any);

    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "u1",
      firstName: "Jane",
      lastName: "Doe",
      active: true,
      ageTier: "ADULT",
      canLogin: true,
      familyGroupMemberships: [{ familyGroupId: "fg1" }],
    } as any);

    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "u2",
      firstName: "Bob",
      lastName: "Smith",
      ageTier: "ADULT",
      familyGroupMemberships: [],
    } as any);

    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.familyGroupJoinRequest.create).mockResolvedValue({ id: "inv1" } as any);
    vi.mocked(prisma.familyGroup.findUnique).mockResolvedValue({ name: "Doe Family" } as any);
    mockedSendInvitation.mockResolvedValue(undefined);

    const { POST } = await import(
      "../../app/api/members/family/invite/route"
    );

    const req = new Request("http://localhost/api/members/family/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bob@test.com", familyGroupId: "fg1" }),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(201);

    // Email should be sent
    expect(mockedSendInvitation).toHaveBeenCalledWith(
      "bob@test.com",
      "Jane Doe",
      "Doe Family"
    );
  });
});

describe("PUT /api/members/family/invitations — email on accept", () => {
  it("should send accepted email to inviter when invitation is accepted", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "u2", role: "MEMBER", email: "invitee@test.com" },
    } as any);

    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue({
      id: "inv1",
      familyGroupId: "fg1",
      invitedMemberId: "u2",
      type: "ADULT_INVITE",
      status: "PENDING",
      requesterId: "u1",
      familyGroup: { id: "fg1", name: "Doe Family" },
      requester: { id: "u1", firstName: "Jane", lastName: "Doe", email: "jane@test.com" },
    } as any);

    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      firstName: "Bob",
      lastName: "Smith",
    } as any);

    mockedSendInviteAccepted.mockResolvedValue(undefined);

    const { PUT } = await import(
      "../../app/api/members/family/invitations/route"
    );

    const req = new Request("http://localhost/api/members/family/invitations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: "inv1", action: "accept" }),
    });

    const res = await PUT(req as any);
    expect(res.status).toBe(200);

    expect(mockedSendInviteAccepted).toHaveBeenCalledWith(
      "jane@test.com",
      "Bob Smith",
      "Doe Family"
    );
  });
});

describe("POST /api/members/family/request-child — email on submit", () => {
  it("should send submitted email to parent on successful child request", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "u1", role: "MEMBER", email: "parent@test.com" },
    } as any);

    vi.mocked(prisma.member.findUnique)
      .mockResolvedValueOnce({
        id: "u1",
        firstName: "Jane",
        lastName: "Doe",
        active: true,
        ageTier: "ADULT",
        familyGroupMemberships: [{ familyGroupId: "fg1" }],
      } as any)
      // Second call: parent email lookup
      .mockResolvedValueOnce({ email: "parent@test.com" } as any);

    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.familyGroupJoinRequest.create).mockResolvedValue({ id: "req1" } as any);
    vi.mocked(prisma.familyGroup.findUnique).mockResolvedValue({ name: "Doe Family" } as any);
    mockedSendChildSubmitted.mockResolvedValue(undefined);

    const { POST } = await import(
      "../../app/api/members/family/request-child/route"
    );

    const req = new Request("http://localhost/api/members/family/request-child", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        familyGroupId: "fg1",
        firstName: "Timmy",
        lastName: "Doe",
      }),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(201);

    expect(mockedSendChildSubmitted).toHaveBeenCalledWith(
      "parent@test.com",
      "Jane",
      "Timmy Doe",
      "Doe Family"
    );
  });
});
