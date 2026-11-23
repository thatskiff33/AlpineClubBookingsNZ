/**
 * ALP-795 (`INV-MCP-006`): the family group actions an AI app connection may
 * run, each held to the contract it exposes (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields;
 * - the change is made for the signed-in member only, though that member is
 *   also an officer (`officerMemberSession`);
 * - the browser's answer is unchanged.
 *
 * The withheld-field assertions name the bug each catches: a field the
 * website's answer or the database row carries reaching the AI provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  computeAgeTier: vi.fn(),
  prisma: {
    member: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    familyGroup: { create: vi.fn(), findUnique: vi.fn() },
    familyGroupMember: { create: vi.fn(), findUnique: vi.fn() },
    familyGroupJoinRequest: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    partnerInviteToken: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(async () => null),
  rateLimiters: { api: { id: "api" }, familyGroupJoinRequest: { id: "family-group-join-request" } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/email", () => ({
  sendAdminFamilyGroupRequestAlert: vi.fn(async () => undefined),
  sendChildRequestSubmittedEmail: vi.fn(async () => undefined),
  sendFamilyGroupInvitationEmail: vi.fn(async () => undefined),
  sendGroupCreateRequestConfirmationEmail: vi.fn(async () => undefined),
  sendJoinRequestConfirmationEmail: vi.fn(async () => undefined),
  sendPartnerInviteEmail: vi.fn(async () => undefined),
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTime: vi.fn(async () => ({ today: () => "2026-07-01" })),
  clubTimeZone: vi.fn(async () => "Pacific/Auckland"),
  clubTodayDateOnlyInstant: vi.fn(async () => new Date("2026-07-01T00:00:00.000Z")),
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: h.computeAgeTier,
  getSeasonStartDate: vi.fn(() => new Date("2026-05-01T00:00:00.000Z")),
}));
vi.mock("@/lib/member-partner-link", () => ({ requestPartnerLink: vi.fn() }));
vi.mock("@/lib/partner-invite-token-policy", () => ({
  buildPartnerInviteTokenData: vi.fn(),
  getPartnerInviteTokenExpiryDate: vi.fn(),
}));
// The delegated details save's side effects beyond the member row.
vi.mock("@/lib/member-profile-completeness", () => ({
  evaluateSelfServiceProfilePayload: vi.fn(() => ({ isProfileComplete: true, missingFields: [] })),
  evaluateMemberProfileCompleteness: vi.fn(() => ({
    isProfileComplete: true,
    isDetailsConfirmed: true,
    canBeBookedAsMember: true,
    missingFields: [],
    needsOwnLoginConfirmation: false,
    confirmationMode: "DELEGATED",
  })),
  getMissingMemberProfileFieldDetails: vi.fn(() => []),
}));
vi.mock("@/lib/age-tier-enforcement", () => ({
  loadMemberCurrentSeasonTypeExemption: vi.fn(async () => null),
  resolveEnforcedAgeTier: vi.fn(() => ({ ok: true, ageTier: "ADULT" })),
}));
vi.mock("@/lib/member-email-inheritance", () => ({ reconcileEmailInheritanceForMemberChange: vi.fn() }));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: vi.fn(async () => false) }));
vi.mock("@/lib/xero-contact-groups", () => ({ syncManagedXeroContactGroupForMember: vi.fn() }));
vi.mock("@/lib/xero-contacts", () => ({ updateXeroContact: vi.fn() }));
vi.mock("@/lib/xero-contact-sync", () => ({
  buildXeroContactUpdatePayload: vi.fn(),
  hasMemberXeroContactChanges: vi.fn(() => false),
  shouldRepairXeroContactNameOrder: vi.fn(async () => false),
}));

import { PUT as putDetails } from "@/app/api/members/family/[memberId]/details/route";
import { POST as createGroup } from "@/app/api/members/family/create-group/route";
import { GET as getInvitations } from "@/app/api/members/family/invitations/route";
import { POST as invite } from "@/app/api/members/family/invite/route";
import { POST as requestAdult } from "@/app/api/members/family/request-adult/route";
import { POST as requestChild } from "@/app/api/members/family/request-child/route";
import { POST as requestJoin } from "@/app/api/members/family/request-join/route";
import { POST as requestRemoval } from "@/app/api/members/family/request-removal/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { findMcpAction, mcpActionInputSchema } from "@/lib/mcp/catalogue";

const MEMBER_ID = "officer-1";

/** Every key anywhere in a JSON value. */
function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      allKeys(inner, keys);
    }
  }
  return keys;
}

/** The signed-in member as the family routes read them: an adult with a login in group `fg-1`. */
const REQUESTER = {
  id: MEMBER_ID,
  firstName: "Ana",
  lastName: "Reid",
  email: "ana@example.test",
  active: true,
  canLogin: true,
  ageTier: "ADULT",
  familyGroupMemberships: [{ familyGroupId: "fg-1" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession(MEMBER_ID));
  h.prisma.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation(h.prisma));
  h.prisma.member.findUnique.mockResolvedValue(REQUESTER);
  h.prisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
  h.prisma.familyGroup.findUnique.mockResolvedValue({ name: "Reid family" });
});

describe("list_my_family_invitations", () => {
  it("answers with who invited the member, to which group, and nothing else from the request row", async () => {
    h.prisma.familyGroupJoinRequest.findMany.mockResolvedValue([
      {
        id: "inv-1",
        familyGroupId: "fg-2",
        requesterId: "member-2",
        invitedMemberId: MEMBER_ID,
        type: "ADULT_INVITE",
        status: "PENDING",
        requestNotes: "Private note to the club",
        requestedEmail: "someone@example.test",
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
        familyGroup: { id: "fg-2", name: "Moana family" },
        requester: { id: "member-2", firstName: "Moana", lastName: "Hale" },
      },
    ]);
    const { connection, browser } = await expectActionContract({
      actionId: "list_my_family_invitations",
      handler: getInvitations,
    });
    expect(connection).toEqual({
      invitations: [
        {
          id: "inv-1",
          createdAt: "2026-06-20T00:00:00.000Z",
          familyGroup: { id: "fg-2", name: "Moana family" },
          requester: { id: "member-2", firstName: "Moana", lastName: "Hale" },
        },
      ],
    });
    expect(allKeys(browser).has("requestNotes")).toBe(true);
    // Only invitations addressed to the signed-in member, whatever their officer roles.
    expect(h.prisma.familyGroupJoinRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ invitedMemberId: MEMBER_ID }) }),
    );
  });
});

describe("invite_to_family_group", () => {
  it("invites as the signed-in member and answers with the message and invitation id", async () => {
    h.prisma.member.findFirst.mockResolvedValue({
      id: "member-2",
      firstName: "Moana",
      lastName: "Hale",
      ageTier: "ADULT",
      familyGroupMemberships: [],
    });
    h.prisma.familyGroupJoinRequest.create.mockResolvedValue({ id: "inv-9" });
    const { connection, browser } = await expectActionContract({
      actionId: "invite_to_family_group",
      handler: invite,
      args: { email: "moana@example.test", familyGroupId: "fg-1" },
    });
    expect(connection).toEqual(browser);
    expect(h.prisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requesterId: MEMBER_ID, invitedMemberId: "member-2" }),
    });
  });
});

describe("request_family_group", () => {
  it("files the request for the signed-in member and answers with its ids", async () => {
    h.prisma.member.findUnique.mockResolvedValue({ ...REQUESTER, familyGroupMemberships: [] });
    h.prisma.familyGroup.create.mockResolvedValue({ id: "fg-new", name: "Reid family" });
    h.prisma.familyGroupJoinRequest.create
      .mockResolvedValueOnce({ id: "create-1" })
      .mockResolvedValueOnce({ id: "child-1" })
      .mockResolvedValueOnce({ id: "create-2" })
      .mockResolvedValueOnce({ id: "child-2" });
    h.computeAgeTier.mockResolvedValue("CHILD");
    const { connection } = await expectActionContract({
      actionId: "request_family_group",
      handler: createGroup,
      args: { children: [{ firstName: "Mere", lastName: "Reid", dateOfBirth: "2019-05-06" }] },
    });
    expect(connection).toEqual({
      message: "Request submitted. An admin will review your new family group.",
      requestId: "create-1",
      familyGroupId: "fg-new",
      childRequestIds: ["child-1"],
    });
    expect(h.prisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requesterId: MEMBER_ID, type: "GROUP_CREATE" }),
    });
  });
});

describe("the four family requests an officer reviews", () => {
  beforeEach(() => {
    h.prisma.familyGroupJoinRequest.create.mockResolvedValue({ id: "req-1", status: "PENDING" });
  });

  it("request_to_join_family_group files a join request for the signed-in member", async () => {
    h.prisma.member.findFirst.mockResolvedValue({
      id: "member-2",
      firstName: "Moana",
      lastName: "Hale",
      familyGroupMemberships: [{ familyGroupId: "fg-2", familyGroup: { id: "fg-2", name: "Hale family" } }],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "request_to_join_family_group",
      handler: requestJoin,
      args: { targetEmail: "moana@example.test" },
    });
    expect(connection).toEqual(browser);
    expect(h.prisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: { familyGroupId: "fg-2", requesterId: MEMBER_ID, type: "JOIN_REQUEST" },
    });
  });

  it("request_family_child files a child request for the signed-in member", async () => {
    h.computeAgeTier.mockResolvedValue("CHILD");
    const { connection } = await expectActionContract({
      actionId: "request_family_child",
      handler: requestChild,
      args: { familyGroupId: "fg-1", firstName: "Mere", lastName: "Reid", dateOfBirth: "2019-05-06" },
    });
    expect(connection).toEqual({
      message: "Request submitted. An admin will review the infant/child/youth member for your family group.",
      requestId: "req-1",
    });
    expect(h.prisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requesterId: MEMBER_ID, type: "CHILD_REQUEST" }),
    });
  });

  it("request_family_adult files a same-email adult request for the signed-in member", async () => {
    h.computeAgeTier.mockResolvedValue("ADULT");
    const { connection } = await expectActionContract({
      actionId: "request_family_adult",
      handler: requestAdult,
      args: { familyGroupId: "fg-1", firstName: "Rawiri", lastName: "Reid", dateOfBirth: "1960-01-02" },
    });
    expect(connection).toEqual({
      message: "Request submitted. An admin will review the adult addition.",
      requestId: "req-1",
    });
    expect(h.prisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requesterId: MEMBER_ID, type: "ADULT_REQUEST" }),
    });
  });

  it("request_family_member_removal files a removal request and removes nobody", async () => {
    h.prisma.familyGroupMember.findUnique.mockResolvedValue({
      member: { id: "member-3", firstName: "Tui", lastName: "Reid", active: true },
      familyGroup: { id: "fg-1", name: "Reid family" },
    });
    const { connection } = await expectActionContract({
      actionId: "request_family_member_removal",
      handler: requestRemoval,
      args: { familyGroupId: "fg-1", memberId: "member-3" },
    });
    expect(connection).toEqual({
      message: "Removal request submitted. An admin will review it.",
      requestId: "req-1",
    });
    expect(h.prisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requesterId: MEMBER_ID, type: "REMOVAL_REQUEST", subjectMemberId: "member-3" }),
    });
  });
});

describe("confirm_family_member_details", () => {
  const target = {
    ...REQUESTER,
    id: "member-4",
    firstName: "Rawiri",
    email: "ana@example.test",
    canLogin: false,
    role: "USER",
    accessRoles: [{ role: "USER" }],
    xeroContactId: null,
    dateOfBirth: new Date("1960-01-02T00:00:00.000Z"),
    phoneNumber: "021 555 0100",
    streetAddressLine1: "1 Ruapehu Road",
  };

  it("answers with the name, age group and profile state, never the date of birth or the copied contact details", async () => {
    h.prisma.member.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === MEMBER_ID ? { ...REQUESTER, role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } : target,
    );
    h.prisma.member.update.mockResolvedValue(target);
    h.computeAgeTier.mockResolvedValue("ADULT");
    const { connection, browser } = await expectActionContract({
      actionId: "confirm_family_member_details",
      handler: putDetails,
      args: { memberId: "member-4", firstName: "Rawiri", lastName: "Reid", dateOfBirth: "1960-01-02" },
    });
    expect(connection).toEqual({
      member: { id: "member-4", firstName: "Rawiri", lastName: "Reid", ageTier: "ADULT", canLogin: false },
      profileStatus: { isProfileComplete: true, isDetailsConfirmed: true, canBeBookedAsMember: true, missingFields: [] },
    });
    const keys = allKeys(connection);
    for (const withheld of ["dateOfBirth", "email", "phoneNumber", "streetAddressLine1", "confirmationMode"]) {
      expect(keys.has(withheld), withheld).toBe(false);
    }
    // The website still gets the full profile status it renders.
    expect(allKeys(browser).has("confirmationMode")).toBe(true);
    // The details are vouched for by the signed-in member, whatever their officer roles.
    expect(h.prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-4" },
        data: expect.objectContaining({ detailsConfirmedByMemberId: MEMBER_ID }),
      }),
    );
  });

  it("always sends the contact-copy acknowledgement the route requires, which the app cannot set", () => {
    const action = findMcpAction("confirm_family_member_details")!;
    expect(action.fixedBody).toEqual({ inheritContactFromSelf: true });
    expect(Object.keys(mcpActionInputSchema(action).shape)).not.toContain("inheritContactFromSelf");
  });
});
