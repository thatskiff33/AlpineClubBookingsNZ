/**
 * ALP-720 (`INV-MCP-006`): the family group actions an officer's AI app
 * connection may run, each held to its contract (`expectActionContract`): the
 * connection gets exactly the action's `returns` fields and the browser's
 * answer is unchanged. Family groups carry children, so each read also pins
 * that the connection never receives an age, a date of birth, a sign-in field
 * or a provider id the screen's answer carries.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  prisma: {
    familyGroup: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    familyGroupMember: { createMany: vi.fn(), deleteMany: vi.fn() },
    member: { findMany: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  searchFamilyGroupCandidateMembers: vi.fn(),
  listAdminFamilyGroupRequests: vi.fn(),
  reviewAdminFamilyGroupRequest: vi.fn(),
  listOutstandingPartnerInviteTokens: vi.fn(),
  revokePartnerInviteToken: vi.fn(),
  suggestFamilyGroups: vi.fn(),
  createFamilyGroupFromSuggestion: vi.fn(),
  hideFamilySuggestion: vi.fn(),
  resetHiddenFamilySuggestions: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), createAuditLog: vi.fn() }));
vi.mock("@/lib/club-time/server", () => ({
  clubTime: vi.fn(async () => ({ today: () => ({ year: 2026, month: 7, day: 1 }) })),
}));
vi.mock("@/lib/member-age", async (importActual) => ({
  ...((await importActual()) as typeof import("@/lib/member-age")),
  formatMemberIdentityAge: vi.fn(() => "9 years"),
}));
vi.mock("@/lib/password-reset", () => ({ hasMemberCompletedAccountSetup: vi.fn(() => true) }));
// The services keep their real request schemas: the routes and the catalogue
// both parse with them.
vi.mock("@/lib/admin-family-group-member-search", async (importActual) => ({
  ...((await importActual()) as typeof import("@/lib/admin-family-group-member-search")),
  searchFamilyGroupCandidateMembers: h.searchFamilyGroupCandidateMembers,
}));
vi.mock("@/lib/admin-family-group-requests-service", async (importActual) => ({
  ...((await importActual()) as typeof import("@/lib/admin-family-group-requests-service")),
  listAdminFamilyGroupRequests: h.listAdminFamilyGroupRequests,
  reviewAdminFamilyGroupRequest: h.reviewAdminFamilyGroupRequest,
}));
vi.mock("@/lib/partner-invite-token", () => ({
  listOutstandingPartnerInviteTokens: h.listOutstandingPartnerInviteTokens,
  revokePartnerInviteToken: h.revokePartnerInviteToken,
}));
vi.mock("@/lib/family-suggestions", () => ({
  FamilySuggestionError: class FamilySuggestionError extends Error {},
  suggestFamilyGroups: h.suggestFamilyGroups,
  createFamilyGroupFromSuggestion: h.createFamilyGroupFromSuggestion,
  hideFamilySuggestion: h.hideFamilySuggestion,
  resetHiddenFamilySuggestions: h.resetHiddenFamilySuggestions,
}));

import { GET as listFamilyGroups, POST as createFamilyGroup } from "@/app/api/admin/family-groups/route";
import {
  DELETE as deleteFamilyGroup,
  GET as getFamilyGroup,
  PUT as updateFamilyGroup,
} from "@/app/api/admin/family-groups/[id]/route";
import { GET as searchMembers } from "@/app/api/admin/family-groups/member-search/route";
import {
  DELETE as revokePartnerInvite,
  GET as listPartnerInvites,
} from "@/app/api/admin/family-groups/partner-invites/route";
import {
  GET as listRequests,
  PUT as reviewRequest,
} from "@/app/api/admin/family-groups/requests/route";
import {
  GET as listSuggestions,
  POST as createFromSuggestion,
} from "@/app/api/admin/family-suggestions/route";
import { POST as hideSuggestion } from "@/app/api/admin/family-suggestions/hide/route";
import { POST as resetSuggestions } from "@/app/api/admin/family-suggestions/reset/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";

const CREATED_AT = new Date("2026-06-01T00:00:00.000Z");
const UPDATED_AT = new Date("2026-06-15T00:00:00.000Z");

/** A child on a group's roster, with the columns no action sends. */
const childRow = {
  id: "member-2",
  firstName: "Mia",
  lastName: "Hale",
  email: "ana@example.test",
  ageTier: "CHILD",
  active: true,
  canLogin: false,
  archivedAt: null,
};

const childOnRoster = { id: "member-2", firstName: "Mia", lastName: "Hale", ageTier: "CHILD" };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.prisma.$transaction.mockImplementation(async (run: (tx: typeof h.prisma) => unknown) => run(h.prisma));
});

describe("list_family_groups", () => {
  it("sends each group's roster without email addresses or sign-in fields", async () => {
    h.prisma.familyGroup.findMany.mockResolvedValue([
      {
        id: "group-1",
        name: "Hale Family",
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        memberships: [{ member: childRow }],
        _count: { joinRequests: 2 },
      },
    ]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_family_groups",
      handler: listFamilyGroups,
    });

    expect(connection).toEqual({
      familyGroups: [
        {
          id: "group-1",
          name: "Hale Family",
          createdAt: CREATED_AT.toISOString(),
          updatedAt: UPDATED_AT.toISOString(),
          members: [{ ...childOnRoster, active: true }],
          memberCount: 1,
          inactiveCount: 0,
          pendingRequests: 2,
        },
      ],
    });
    expect(browser).toMatchObject({
      familyGroups: [{ members: [{ email: "ana@example.test", canLogin: false }] }],
    });
  });
});

describe("get_family_group", () => {
  it("reads the group named in the address and sends no age, email or credential field", async () => {
    h.prisma.familyGroup.findUnique.mockResolvedValue({
      id: "group-1",
      name: "Hale Family",
      createdAt: CREATED_AT,
      memberships: [
        {
          member: {
            ...childRow,
            inheritEmailFromId: "member-1",
            inheritEmailFrom: { email: "ana@example.test" },
            passwordHash: "hash",
            passwordChangedAt: null,
            lastLoginAt: null,
            dateOfBirth: new Date("2017-03-01T00:00:00.000Z"),
          },
        },
      ],
    });

    const { connection, browser } = await expectActionContract({
      actionId: "get_family_group",
      handler: getFamilyGroup,
      args: { id: "group-1" },
    });

    expect(connection).toEqual({
      id: "group-1",
      name: "Hale Family",
      createdAt: CREATED_AT.toISOString(),
      members: [{ ...childOnRoster, active: true }],
    });
    expect(browser).toMatchObject({
      members: [{ email: "ana@example.test", ageLabel: "9 years", hasPassword: true }],
    });
    expect(h.prisma.familyGroup.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "group-1" } }),
    );
  });
});

describe("create_family_group, update_family_group and delete_family_group", () => {
  it("creates the group with each member once", async () => {
    h.prisma.member.findMany.mockResolvedValue([
      { id: "member-1", firstName: "Ana", lastName: "Hale", active: true, archivedAt: null },
      { id: "member-2", firstName: "Mia", lastName: "Hale", active: true, archivedAt: null },
    ]);
    h.prisma.familyGroup.create.mockResolvedValue({ id: "group-1" });
    h.prisma.familyGroup.findUnique.mockResolvedValue({
      id: "group-1",
      name: "Hale Family",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      memberships: [{ member: { ...childOnRoster, email: "ana@example.test" } }],
    });

    const { connection, browser } = await expectActionContract({
      actionId: "create_family_group",
      handler: createFamilyGroup,
      args: { name: "Hale Family", memberIds: ["member-1", "member-2", "member-1"] },
    });

    expect(connection).toEqual({
      id: "group-1",
      name: "Hale Family",
      createdAt: CREATED_AT.toISOString(),
      updatedAt: UPDATED_AT.toISOString(),
      members: [childOnRoster],
    });
    expect(browser).toMatchObject({ memberships: [{ member: { email: "ana@example.test" } }] });
    expect(h.prisma.familyGroupMember.createMany).toHaveBeenCalledWith({
      data: [
        { familyGroupId: "group-1", memberId: "member-1" },
        { familyGroupId: "group-1", memberId: "member-2" },
      ],
      skipDuplicates: true,
    });
  });

  it("replaces the member list of the group named in the address", async () => {
    h.prisma.familyGroup.findUnique.mockImplementation(
      async (args: { include: { memberships: { select: Record<string, unknown> } } }) =>
        "memberId" in args.include.memberships.select
          ? { id: "group-1", memberships: [{ memberId: "member-2" }, { memberId: "member-9" }] }
          : {
              id: "group-1",
              name: "Hale Whānau",
              createdAt: CREATED_AT,
              memberships: [{ member: { ...childOnRoster, email: "ana@example.test" } }],
            },
    );
    h.prisma.member.findMany.mockResolvedValue([
      { id: "member-2", firstName: "Mia", lastName: "Hale", active: true, archivedAt: null },
    ]);

    const { connection, browser } = await expectActionContract({
      actionId: "update_family_group",
      handler: updateFamilyGroup,
      args: { id: "group-1", name: "Hale Whānau", memberIds: ["member-2"] },
    });

    expect(connection).toEqual({
      id: "group-1",
      name: "Hale Whānau",
      createdAt: CREATED_AT.toISOString(),
      members: [childOnRoster],
    });
    expect(browser).toMatchObject({ members: [{ email: "ana@example.test" }] });
    expect(h.prisma.familyGroupMember.deleteMany).toHaveBeenCalledWith({
      where: { familyGroupId: "group-1", memberId: { in: ["member-9"] } },
    });
    expect(h.prisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["member-9"] }, billingFamilyGroupId: "group-1" },
      data: { billingFamilyGroupId: null },
    });
  });

  it("deletes the group named in the address", async () => {
    h.prisma.familyGroup.findUnique.mockResolvedValue({ id: "group-1" });

    const { connection } = await expectActionContract({
      actionId: "delete_family_group",
      handler: deleteFamilyGroup,
      args: { id: "group-1" },
    });

    expect(connection).toEqual({ success: true });
    expect(h.prisma.familyGroup.delete).toHaveBeenCalledWith({ where: { id: "group-1" } });
  });
});

describe("search_family_group_members", () => {
  it("passes the parsed search through and sends no age or sign-in field", async () => {
    h.searchFamilyGroupCandidateMembers.mockResolvedValue({
      members: [
        {
          ...childRow,
          ageLabel: "9 years",
          parentLinks: [
            {
              id: "member-1",
              firstName: "Ana",
              lastName: "Hale",
              email: "ana@example.test",
              ageTier: "ADULT",
              active: true,
              canLogin: true,
              inheritEmailFromId: null,
              parentLinkType: "PRIMARY",
            },
          ],
          ineligibleReason: "The same two members cannot be both direct parent/dependant and partners.",
        },
      ],
      total: 1,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "search_family_group_members",
      handler: searchMembers,
      args: { q: "Hale", ageTierIn: "CHILD,YOUTH", prospectiveParentMemberId: "member-1" },
    });

    expect(connection).toEqual({
      members: [
        {
          id: "member-2",
          firstName: "Mia",
          lastName: "Hale",
          email: "ana@example.test",
          ageTier: "CHILD",
          active: true,
          parentLinks: [{ id: "member-1", firstName: "Ana", lastName: "Hale", parentLinkType: "PRIMARY" }],
          ineligibleReason: "The same two members cannot be both direct parent/dependant and partners.",
        },
      ],
      total: 1,
    });
    expect(browser).toMatchObject({ members: [{ ageLabel: "9 years", canLogin: false }] });
    expect(h.searchFamilyGroupCandidateMembers).toHaveBeenCalledWith({
      q: "Hale",
      ageTierIn: ["CHILD", "YOUTH"],
      prospectiveParentMemberId: "member-1",
    });
  });
});

describe("list_partner_invites and revoke_partner_invite", () => {
  it("lists the outstanding invitations and drops any field the action does not name", async () => {
    h.listOutstandingPartnerInviteTokens.mockResolvedValue([
      {
        id: "invite-1",
        invitedEmail: "kai@example.test",
        expiresAt: new Date("2026-07-08T00:00:00.000Z"),
        createdAt: CREATED_AT,
        familyGroupId: "group-1",
        familyGroupName: "Hale Family",
        createdBy: { id: "member-1", name: "Ana Hale" },
        // Not in today's answer: proves a later addition never reaches an app.
        tokenHash: "never-sent",
      },
    ]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_partner_invites",
      handler: listPartnerInvites,
    });

    expect(connection).toEqual({
      invites: [
        {
          id: "invite-1",
          invitedEmail: "kai@example.test",
          expiresAt: "2026-07-08T00:00:00.000Z",
          createdAt: CREATED_AT.toISOString(),
          familyGroupId: "group-1",
          familyGroupName: "Hale Family",
          createdBy: { id: "member-1", name: "Ana Hale" },
        },
      ],
    });
    expect(browser).toMatchObject({ invites: [{ tokenHash: "never-sent" }] });
  });

  it("revokes the invitation named in the query, as the signed-in officer", async () => {
    h.revokePartnerInviteToken.mockResolvedValue(true);

    const { connection } = await expectActionContract({
      actionId: "revoke_partner_invite",
      handler: revokePartnerInvite,
      args: { id: "invite-1" },
    });

    expect(connection).toEqual({ success: true });
    expect(h.revokePartnerInviteToken).toHaveBeenCalledWith({
      tokenId: "invite-1",
      adminMemberId: "officer-1",
    });
  });

  it("still refuses a blank invitation id with the same answer", async () => {
    const response = await revokePartnerInvite(
      new NextRequest("https://club.example.test/api/admin/family-groups/partner-invites?id=%20%20", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invitation id required" });
    expect(h.revokePartnerInviteToken).not.toHaveBeenCalled();
  });
});

describe("list_family_group_requests and review_family_group_request", () => {
  it("sends each pending request without dates of birth, ages or sign-in fields", async () => {
    const person = { id: "member-3", firstName: "Kai", lastName: "Ngata", email: "kai@example.test" };
    h.listAdminFamilyGroupRequests.mockResolvedValue({
      body: {
        requests: [
          {
            id: "request-1",
            familyGroupId: "group-1",
            requesterId: "member-1",
            type: "CHILD_REQUEST",
            status: "PENDING",
            createdAt: CREATED_AT,
            reviewedAt: null,
            reviewedBy: null,
            invitedMemberId: "member-3",
            linkedMemberId: null,
            subjectMemberId: "member-3",
            childFirstName: "Mia",
            childLastName: "Hale",
            childDateOfBirth: new Date("2017-03-01T00:00:00.000Z"),
            requestedFirstName: null,
            requestedLastName: null,
            requestedDateOfBirth: null,
            requestedEmail: null,
            requestNotes: "Our youngest",
            requestedAgeTier: "CHILD",
            requestedAgeTierLabel: "Child",
            canCreateMemberFromRequest: true,
            childAgeLabel: "9 years",
            requestedAgeLabel: null,
            requester: { id: "member-1", firstName: "Ana", lastName: "Hale", email: "ana@example.test", ageLabel: "40 years" },
            subjectMember: { ...person, ageTier: "ADULT", active: true, ageLabel: "38 years" },
            invitedMember: { ...person, ageTier: "ADULT", active: true, ageLabel: "38 years" },
            familyGroup: {
              id: "group-1",
              name: "Hale Family",
              members: [{ ...childOnRoster, email: "ana@example.test" }],
            },
            matchingMembers: [
              {
                ...childRow,
                ageLabel: "9 years",
                parentLinks: [
                  {
                    id: "member-1",
                    firstName: "Ana",
                    lastName: "Hale",
                    email: "ana@example.test",
                    canLogin: true,
                    parentLinkType: "PRIMARY",
                  },
                ],
                alreadyInGroup: false,
                ineligibleReason: "The same two members cannot be both direct parent/dependant and partners.",
              },
            ],
          },
        ],
      },
      init: undefined,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "list_family_group_requests",
      handler: listRequests,
    });

    const personSent = { ...person, ageTier: "ADULT", active: true };
    expect(connection).toEqual({
      requests: [
        {
          id: "request-1",
          familyGroupId: "group-1",
          requesterId: "member-1",
          type: "CHILD_REQUEST",
          status: "PENDING",
          createdAt: CREATED_AT.toISOString(),
          invitedMemberId: "member-3",
          linkedMemberId: null,
          subjectMemberId: "member-3",
          childFirstName: "Mia",
          childLastName: "Hale",
          requestedFirstName: null,
          requestedLastName: null,
          requestedEmail: null,
          requestNotes: "Our youngest",
          requestedAgeTier: "CHILD",
          requestedAgeTierLabel: "Child",
          canCreateMemberFromRequest: true,
          requester: { id: "member-1", firstName: "Ana", lastName: "Hale", email: "ana@example.test" },
          subjectMember: personSent,
          invitedMember: personSent,
          familyGroup: { id: "group-1", name: "Hale Family", members: [childOnRoster] },
          matchingMembers: [
            {
              id: "member-2",
              firstName: "Mia",
              lastName: "Hale",
              email: "ana@example.test",
              ageTier: "CHILD",
              active: true,
              parentLinks: [{ id: "member-1", firstName: "Ana", lastName: "Hale", parentLinkType: "PRIMARY" }],
              alreadyInGroup: false,
              ineligibleReason: "The same two members cannot be both direct parent/dependant and partners.",
            },
          ],
        },
      ],
    });
    expect(browser).toMatchObject({
      requests: [{ childDateOfBirth: "2017-03-01T00:00:00.000Z", childAgeLabel: "9 years" }],
    });
  });

  it("reviews the request as the signed-in officer, with the app's choices", async () => {
    h.reviewAdminFamilyGroupRequest.mockResolvedValue({ body: { success: true, action: "approve" } });

    const { connection } = await expectActionContract({
      actionId: "review_family_group_request",
      handler: reviewRequest,
      args: { requestId: "request-1", action: "approve", linkedMemberId: "member-2", notifyMember: false },
    });

    expect(connection).toEqual({ success: true, action: "approve" });
    expect(h.reviewAdminFamilyGroupRequest).toHaveBeenCalledWith({
      adminMemberId: "officer-1",
      data: { requestId: "request-1", action: "approve", linkedMemberId: "member-2", notifyMember: false },
    });
  });
});

describe("family suggestion actions", () => {
  it("lists suggestions without ages, sign-in fields or Xero contact ids", async () => {
    h.suggestFamilyGroups.mockResolvedValue({
      suggestions: [
        {
          signature: "member-1|member-2",
          suggestedName: "Hale Family",
          reason: "2 members share email ana@example.test",
          score: 10,
          members: [{ ...childOnRoster, email: "ana@example.test", canLogin: false, xeroContactId: "xero-1", ageLabel: "9 years" }],
        },
      ],
      ungroupedCount: 4,
      totalMembers: 20,
      hiddenCount: 1,
    });

    const { connection, browser } = await expectActionContract({
      actionId: "list_family_suggestions",
      handler: listSuggestions,
    });

    expect(connection).toEqual({
      suggestions: [
        {
          signature: "member-1|member-2",
          suggestedName: "Hale Family",
          reason: "2 members share email ana@example.test",
          score: 10,
          members: [{ ...childOnRoster, email: "ana@example.test" }],
        },
      ],
      ungroupedCount: 4,
      totalMembers: 20,
      hiddenCount: 1,
    });
    expect(browser).toMatchObject({ suggestions: [{ members: [{ xeroContactId: "xero-1", ageLabel: "9 years" }] }] });
  });

  it("creates a group from the members the app names", async () => {
    h.createFamilyGroupFromSuggestion.mockResolvedValue({ groupId: "group-9", memberCount: 2 });

    const { connection } = await expectActionContract({
      actionId: "create_family_group_from_suggestion",
      handler: createFromSuggestion,
      args: { name: "Hale Family", memberIds: ["member-1", "member-2"] },
    });

    expect(connection).toEqual({ message: 'Family group "Hale Family" created with 2 members.', groupId: "group-9" });
    expect(h.createFamilyGroupFromSuggestion).toHaveBeenCalledWith("Hale Family", ["member-1", "member-2"]);
  });

  it("hides the suggestion as the signed-in officer", async () => {
    h.hideFamilySuggestion.mockResolvedValue({ signature: "member-1|member-2", memberIds: ["member-1", "member-2"] });

    const { connection } = await expectActionContract({
      actionId: "hide_family_suggestion",
      handler: hideSuggestion,
      args: { memberIds: ["member-2", "member-1"] },
    });

    expect(connection).toEqual({ message: "Family suggestion hidden.", signature: "member-1|member-2" });
    expect(h.hideFamilySuggestion).toHaveBeenCalledWith(["member-2", "member-1"], "officer-1");
  });

  it("unhides every suggestion and says how many", async () => {
    h.resetHiddenFamilySuggestions.mockResolvedValue({ count: 3 });

    const { connection } = await expectActionContract({
      actionId: "reset_hidden_family_suggestions",
      handler: resetSuggestions,
    });

    expect(connection).toEqual({ message: "Hidden family suggestions reset.", deletedCount: 3 });
    expect(h.resetHiddenFamilySuggestions).toHaveBeenCalledWith();
  });
});
