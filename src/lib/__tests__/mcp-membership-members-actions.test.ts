/**
 * ALP-720 (`INV-MCP-006`): the member actions an officer's AI app connection
 * may run, each held to its contract (`expectActionContract`): the
 * connection gets exactly the action's `returns` fields and the browser's
 * answer is unchanged. The member list and detail fixtures carry the personal
 * fields a connection must never get (date of birth, addresses, dietary data,
 * Xero ids, sign-in internals) so a widened shape fails here.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  listAdminMembers: vi.fn(),
  getAdminMemberDetail: vi.fn(),
  getAuditTimelinePage: vi.fn(),
  getPartnerLinkState: vi.fn(),
  adminAssignPartnerLink: vi.fn(),
  adminRemovePartnerLink: vi.fn(),
  resolveInheritedEmailSourceId: vi.fn(),
  prisma: {
    member: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
    memberLodgeAccess: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    lodge: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    familyGroupMember: { upsert: vi.fn() },
    membershipType: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((input: unknown) => ({ data: input })),
  getAuditRequestContext: vi.fn(() => ({})),
}));
vi.mock("@/lib/admin-members-service", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/admin-members-service")),
  listAdminMembers: h.listAdminMembers,
}));
vi.mock("@/lib/admin-member-detail-service", () => ({
  getAdminMemberDetail: h.getAdminMemberDetail,
  updateAdminMember: vi.fn(),
  updateMemberSchema: { safeParse: vi.fn() },
}));
vi.mock("@/lib/member-dietary", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-dietary")),
  isDietaryFieldEnabled: vi.fn(async () => false),
  grantMembershipAdminDietaryAccess: vi.fn(),
}));
vi.mock("@/lib/audit-query", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit-query")),
  getAuditTimelinePage: h.getAuditTimelinePage,
}));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn(async () => ({})) }));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: vi.fn(async () => "Pacific/Auckland") }));
vi.mock("@/lib/member-partner-link", () => ({
  getPartnerLinkState: h.getPartnerLinkState,
  adminAssignPartnerLink: h.adminAssignPartnerLink,
  adminRemovePartnerLink: h.adminRemovePartnerLink,
}));
vi.mock("@/lib/member-lifecycle-lock", () => ({ acquireMemberLifecycleLocks: vi.fn() }));
vi.mock("@/lib/member-partner-lock", () => ({ acquireMemberPartnerLinkLocks: vi.fn() }));
vi.mock("@/lib/member-parent-partner-exclusivity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-parent-partner-exclusivity")),
  acquireMemberParentPartnerPairLocks: vi.fn(),
}));
vi.mock("@/lib/member-family-link-depth", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-family-link-depth")),
  describeParentSideDepth: vi.fn(async () => ({ ancestorIds: [], ancestorGenerations: 0, truncated: false })),
  describeChildSideDepth: vi.fn(async () => ({ descendantIds: [], descendantGenerations: 0, truncated: false })),
}));
vi.mock("@/lib/dependent-link-eligibility", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/dependent-link-eligibility")),
  dependentLinkBlockers: vi.fn(() => []),
  dependentParentStateBlocker: vi.fn(() => null),
}));
vi.mock("@/lib/member-email-inheritance", () => ({
  reconcileEmailInheritanceForMemberChange: vi.fn(),
  validateInheritEmailSource: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/member-parent-links", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-parent-links")),
  resolveInheritedEmailSourceId: h.resolveInheritedEmailSourceId,
}));

import { GET as listMembers } from "@/app/api/admin/members/route";
import { GET as getMember } from "@/app/api/admin/members/[id]/route";
import { GET as listMemberActivity } from "@/app/api/admin/members/[id]/audit-log/route";
import { GET as getLodgeAccess, PUT as setLodgeAccess } from "@/app/api/admin/members/[id]/lodge-access/route";
import {
  DELETE as removePartnerLink,
  GET as getPartnerLinks,
  POST as linkPartner,
} from "@/app/api/admin/members/[id]/partner-link/route";
import { POST as linkDependant } from "@/app/api/admin/members/[id]/dependents/link/route";
import { DELETE as unlinkDependant } from "@/app/api/admin/members/[id]/dependents/[dependentId]/route";
import { GET as listMembershipTypes } from "@/app/api/admin/membership-types/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { findMcpAction, mcpActionInputSchema } from "@/lib/mcp/catalogue";

/** Fields a connection never gets, carried by every member fixture below. */
const personalFields = {
  dateOfBirth: "1980-02-03",
  streetAddressLine1: "1 Ridge Road",
  postalAddressLine1: "PO Box 7",
  xeroContactId: "xero-contact-1",
  canLogin: true,
  forcePasswordChange: false,
  // Access roles are never sent: an app must not learn who holds admin access.
  role: "ADMIN",
  accessRoles: ["ADMIN"],
  comments: "Officer note",
};

const standing = {
  id: "member-2",
  firstName: "Ana",
  lastName: "Hale",
  email: "ana@example.test",
  ageTier: "ADULT",
  active: true,
  cancelledAt: null,
  archivedAt: null,
  joinedDate: "2010-04-01T00:00:00.000Z",
  lifeMemberDate: null,
  familyGroups: [{ id: "fg-1", name: "Hale family" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.prisma.$transaction.mockImplementation(async (run: (tx: typeof h.prisma) => unknown) => run(h.prisma));
});

describe("list_members", () => {
  it("sends each member's identity and standing, never their phone, birth date, address or Xero id", async () => {
    h.listAdminMembers.mockResolvedValue({
      body: {
        members: [
          {
            ...standing,
            ...personalFields,
            phoneNumber: "021 555 0101",
            deletedAccount: false,
            subscriptionStatus: "PAID",
            subscriptionXeroInvoiceId: "inv-1",
            currentMembershipType: { id: "type-1", key: "FULL", name: "Full", isActive: true, ageExemption: "NONE" },
            parentLinks: [{ id: "member-9", firstName: "Mere", lastName: "Hale", email: "mere@example.test" }],
            pendingInviteExpiresAt: null,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      },
    });

    const { connection, browser } = await expectActionContract({
      actionId: "list_members",
      handler: listMembers,
      args: { q: " Hale ", contactability: "unreachable", page: 2, pageSize: 10 },
    });

    expect(connection).toEqual({
      members: [
        {
          ...standing,
          deletedAccount: false,
          subscriptionStatus: "PAID",
          currentMembershipType: { id: "type-1", key: "FULL", name: "Full", isActive: true },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    expect(browser).toMatchObject({
      members: [{ phoneNumber: "021 555 0101", dateOfBirth: "1980-02-03", xeroContactId: "xero-contact-1" }],
    });
    // The route reads every field its schema names: `contactability` used to be dropped.
    expect(h.listAdminMembers).toHaveBeenCalledWith(
      expect.objectContaining({ trimmedQuery: "Hale", contactability: "unreachable", page: 2, pageSize: 10 }),
    );
  });

  it("offers the app no screen-only filter", () => {
    const offered = Object.keys(findMcpAction("list_members")?.query?.shape ?? {});
    for (const screenOnly of ["xeroContactGroup", "xeroLinked", "inheritEmailEligible", "excludeId", "inviteStatus", "role"]) {
      expect(offered).not.toContain(screenOnly);
    }
  });

  it("refuses to sort by access role and any filter value the route does not know", () => {
    const listAction = findMcpAction("list_members");
    if (!listAction) throw new Error("list_members is not catalogued");
    for (const args of [{ sortBy: "access" }, { lifecycleStatus: "gone" }, { subscription: "LAPSED" }, { contactability: "x" }]) {
      // The dispatcher validates the app's arguments with this schema before anything is sent.
      expect(mcpActionInputSchema(listAction).safeParse(args).success, JSON.stringify(args)).toBe(false);
    }
  });
});

describe("get_member", () => {
  it("sends the contact, membership and family facts, never birth date, address, dietary data, Xero ids or audit entries", async () => {
    const shared = {
      ...standing,
      phoneCountryCode: "+64",
      phoneAreaCode: "21",
      phoneNumber: "555 0101",
      deletedAt: null,
      leavingDate: null,
      requiresInduction: false,
      createdAt: "2010-04-01T00:00:00.000Z",
      inheritParentEmail: false,
      inheritEmailFromId: "member-9",
      inheritEmailFrom: { id: "member-9", firstName: "Mere", lastName: "Hale", email: "mere@example.test" },
      dependentEmailSource: { id: "member-2", firstName: "Ana", lastName: "Hale", email: "ana@example.test" },
      billingFamilyGroupId: "fg-1",
      currentSeasonYear: 2026,
    };
    h.getAdminMemberDetail.mockResolvedValue({
      body: {
        ...shared,
        ...personalFields,
        dietaryRequirements: "Vegetarian",
        auditLogs: [{ id: "audit-1", ipAddress: "203.0.113.4" }],
        xeroContactGroups: [{ id: "group-1", name: "Members" }],
        bookings: [{ id: "booking-1" }],
        parentLinks: [
          {
            id: "member-9",
            firstName: "Mere",
            lastName: "Hale",
            email: "mere@example.test",
            ageTier: "ADULT",
            active: true,
            canLogin: true,
            inheritEmailFromId: null,
            parentLinkType: "PRIMARY",
          },
        ],
        dependents: [
          {
            id: "member-3",
            firstName: "Kai",
            lastName: "Hale",
            ageTier: "CHILD",
            active: true,
            dateOfBirth: "2018-05-06",
            canLogin: false,
            parentLinkType: "PRIMARY",
          },
        ],
        subscriptions: [
          { id: "sub-1", seasonYear: 2026, status: "PAID", paidAt: "2026-05-01T00:00:00.000Z", xeroInvoiceId: "inv-1" },
        ],
        seasonalMembershipAssignments: [
          {
            id: "assign-1",
            memberId: "member-2",
            seasonYear: 2026,
            membershipTypeId: "type-1",
            subscriptionCategoryId: "cat-1",
            applyFrom: null,
            assignedByMemberId: "officer-1",
            membershipType: { id: "type-1", key: "FULL", name: "Full", isActive: true, bookingBehavior: "STANDARD" },
            subscriptionCategory: { id: "cat-1", key: "FAMILY", name: "Family", isActive: true },
          },
        ],
        openCancellationRequest: {
          id: "cancel-1",
          status: "REQUESTED",
          reason: "Moving overseas",
          submittedAt: "2026-06-01T00:00:00.000Z",
          participantId: "participant-1",
          participantStatus: "REQUESTED",
          requestedBy: { id: "member-2", name: "Ana Hale", email: "ana@example.test" },
          requestedByCurrentAdmin: false,
        },
      },
    });

    const { connection, browser } = await expectActionContract({
      actionId: "get_member",
      handler: getMember,
      args: { id: "member-2" },
    });

    expect(connection).toEqual({
      ...shared,
      parentLinks: [
        {
          id: "member-9",
          firstName: "Mere",
          lastName: "Hale",
          email: "mere@example.test",
          ageTier: "ADULT",
          active: true,
          parentLinkType: "PRIMARY",
        },
      ],
      dependents: [
        { id: "member-3", firstName: "Kai", lastName: "Hale", ageTier: "CHILD", active: true, parentLinkType: "PRIMARY" },
      ],
      subscriptions: [{ id: "sub-1", seasonYear: 2026, status: "PAID", paidAt: "2026-05-01T00:00:00.000Z" }],
      seasonalMembershipAssignments: [
        {
          id: "assign-1",
          seasonYear: 2026,
          membershipTypeId: "type-1",
          subscriptionCategoryId: "cat-1",
          applyFrom: null,
          membershipType: { id: "type-1", key: "FULL", name: "Full", isActive: true },
          subscriptionCategory: { id: "cat-1", key: "FAMILY", name: "Family", isActive: true },
        },
      ],
      openCancellationRequest: {
        id: "cancel-1",
        status: "REQUESTED",
        submittedAt: "2026-06-01T00:00:00.000Z",
        participantStatus: "REQUESTED",
        requestedBy: { id: "member-2", name: "Ana Hale" },
      },
    });
    expect(browser).toMatchObject({ dateOfBirth: "1980-02-03", dietaryRequirements: "Vegetarian" });
    expect(h.getAdminMemberDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "member-2", currentAdminMemberId: "officer-1" }),
    );
  });
});

describe("list_member_activity", () => {
  it("sends when, what kind, the outcome and the summary of each entry, for the member in the address", async () => {
    h.prisma.member.findUnique.mockResolvedValue({ id: "member-2" });
    h.getAuditTimelinePage.mockResolvedValue({
      data: [
        {
          id: "audit-1",
          action: "member.updated",
          category: "profile",
          severity: "info",
          outcome: "success",
          summary: "Profile updated",
          description: null,
          details: "{\"field\":\"phone\"}",
          createdAt: "2026-06-30T00:00:00.000Z",
          actor: null,
          actorDisplayName: "Ana Hale",
          metadata: { phone: "555" },
          ipAddress: "203.0.113.4",
          userAgent: "Browser",
        },
      ],
      total: 1,
      page: 2,
      pageSize: 5,
      totalPages: 1,
      category: "all",
      categories: [{ value: "all", label: "All" }],
    });

    const { connection } = await expectActionContract({
      actionId: "list_member_activity",
      handler: listMemberActivity,
      args: { id: "member-2", page: 2, pageSize: 5 },
    });

    expect(connection).toEqual({
      data: [{ createdAt: "2026-06-30T00:00:00.000Z", category: "profile", outcome: "success", summary: "Profile updated" }],
      total: 1,
      page: 2,
      pageSize: 5,
      totalPages: 1,
      category: "all",
    });
    expect(h.prisma.member.findUnique).toHaveBeenCalledWith({ where: { id: "member-2" }, select: { id: true } });
    expect(h.getAuditTimelinePage).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 5, category: "all", audience: "admin" }),
    );
  });
});

const lodgeAccessRows = [
  { id: "access-1", lodgeId: "lodge-1", kind: "BOOKING_RESTRICTION", createdAt: new Date("2026-06-01T00:00:00.000Z") },
  { id: "access-2", lodgeId: "lodge-2", kind: "STAFF", createdAt: new Date("2026-06-02T00:00:00.000Z") },
];
const serializedRows = lodgeAccessRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));

describe("get_member_lodge_access and set_member_lodge_access", () => {
  it("reads the lodge access of the member in the address", async () => {
    h.prisma.member.findUnique.mockResolvedValue({ id: "member-2" });
    h.prisma.memberLodgeAccess.findMany.mockResolvedValue(lodgeAccessRows);

    const { connection } = await expectActionContract({
      actionId: "get_member_lodge_access",
      handler: getLodgeAccess,
      args: { id: "member-2" },
    });

    expect(connection).toEqual({
      lodgeAccess: serializedRows,
      bookingRestrictions: [serializedRows[0]],
      staffGrants: [serializedRows[1]],
    });
    expect(h.prisma.memberLodgeAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { memberId: "member-2" } }),
    );
  });

  it("replaces both lists for the member in the address", async () => {
    h.prisma.member.findUnique.mockResolvedValue({ id: "member-2" });
    h.prisma.lodge.findMany.mockResolvedValue([{ id: "lodge-1" }, { id: "lodge-2" }]);
    h.prisma.memberLodgeAccess.findMany.mockResolvedValue(lodgeAccessRows);

    const { connection } = await expectActionContract({
      actionId: "set_member_lodge_access",
      handler: setLodgeAccess,
      args: { id: "member-2", bookingRestrictionLodgeIds: ["lodge-1"], staffLodgeIds: ["lodge-2"] },
    });

    expect(connection).toMatchObject({ bookingRestrictions: [{ lodgeId: "lodge-1" }], staffGrants: [{ lodgeId: "lodge-2" }] });
    expect(h.prisma.memberLodgeAccess.createMany).toHaveBeenCalledWith({
      data: [{ memberId: "member-2", lodgeId: "lodge-1", kind: "BOOKING_RESTRICTION", createdById: "officer-1" }],
    });
    expect(h.prisma.memberLodgeAccess.createMany).toHaveBeenCalledWith({
      data: [{ memberId: "member-2", lodgeId: "lodge-2", kind: "STAFF", createdById: "officer-1" }],
    });
  });
});

describe("partner links", () => {
  const link = {
    id: "link-1",
    status: "CONFIRMED",
    partner: { id: "member-3", firstName: "Rawiri", lastName: "Hale", canLogin: true },
    initiatedByMe: false,
    assignedByAdmin: true,
    confirmedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-05-01T00:00:00.000Z",
  };
  const linkSent = {
    id: "link-1",
    status: "CONFIRMED",
    partner: { id: "member-3", firstName: "Rawiri", lastName: "Hale" },
    initiatedByMe: false,
    assignedByAdmin: true,
    confirmedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-05-01T00:00:00.000Z",
  };

  it("get_member_partner_links reads the member in the address and leaves out the partner's sign-in flag", async () => {
    h.getPartnerLinkState.mockResolvedValue({
      confirmed: link,
      pendingIncoming: [{ ...link, id: "link-2", status: "PENDING" }],
      pendingOutgoing: [{ ...link, id: "link-3", status: "PENDING", initiatedByMe: true }],
    });

    const { connection, browser } = await expectActionContract({
      actionId: "get_member_partner_links",
      handler: getPartnerLinks,
      args: { id: "member-2" },
    });

    expect(connection).toEqual({
      confirmed: linkSent,
      pendingIncoming: [{ ...linkSent, id: "link-2", status: "PENDING" }],
      pendingOutgoing: [{ ...linkSent, id: "link-3", status: "PENDING", initiatedByMe: true }],
    });
    expect(browser).toMatchObject({ confirmed: { partner: { canLogin: true } } });
    expect(h.getPartnerLinkState).toHaveBeenCalledWith("member-2");
  });

  it("link_member_partner always emails both members, whatever the app sends", async () => {
    h.adminAssignPartnerLink.mockResolvedValue({
      ok: true,
      linkId: "link-1",
      status: "CONFIRMED",
      message: "Ana Hale and Rawiri Hale are now recorded as partners.",
    });

    const { connection } = await expectActionContract({
      actionId: "link_member_partner",
      handler: linkPartner,
      args: { id: "member-2", partnerMemberId: "member-3", notifyMember: false },
    });

    expect(connection).toEqual({ message: "Ana Hale and Rawiri Hale are now recorded as partners.", linkId: "link-1" });
    expect(h.adminAssignPartnerLink).toHaveBeenCalledWith({
      adminMemberId: "officer-1",
      memberOneId: "member-2",
      memberTwoId: "member-3",
      notifyMember: true,
    });
  });

  it("remove_member_partner_link removes the named link only within the member in the address, and always notifies", async () => {
    h.adminRemovePartnerLink.mockResolvedValue({ ok: true, linkId: "link-1", status: "REMOVED", message: "Partner link removed." });

    const { connection } = await expectActionContract({
      actionId: "remove_member_partner_link",
      handler: removePartnerLink,
      args: { id: "member-2", linkId: "link-1", notifyMember: false },
    });

    expect(connection).toEqual({ message: "Partner link removed." });
    expect(h.adminRemovePartnerLink).toHaveBeenCalledWith({
      adminMemberId: "officer-1",
      linkId: "link-1",
      memberScopeId: "member-2",
      notifyMember: true,
    });
  });

  it("the screen's `?id=` removal still works", async () => {
    h.adminRemovePartnerLink.mockResolvedValue({ ok: true, linkId: "link-9", status: "REMOVED", message: "Partner link removed." });
    const request = new NextRequest("https://club.example.test/api/admin/members/member-2/partner-link?id=%20link-9%20", {
      method: "DELETE",
    });

    const response = await removePartnerLink(request, { params: Promise.resolve({ id: "member-2" }) });

    expect(response.status).toBe(200);
    expect(h.adminRemovePartnerLink).toHaveBeenCalledWith(
      expect.objectContaining({ linkId: "link-9", memberScopeId: "member-2", notifyMember: undefined }),
    );
  });
});

describe("dependants", () => {
  const dependantFamilyLink = {
    id: "member-3",
    firstName: "Kai",
    lastName: "Hale",
    email: "kai@example.test",
    ageTier: "CHILD",
    parentMemberId: "parent-1",
    secondaryParentId: null,
    inheritEmailFromId: "parent-1",
  };

  it("link_member_dependant links the named member under the parent in the address and never turns off their sign-in", async () => {
    h.resolveInheritedEmailSourceId.mockResolvedValue({ sourceId: "parent-1" });
    h.prisma.member.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "parent-1"
        ? {
            id: "parent-1",
            role: "USER",
            canLogin: true,
            accessRoles: [],
            active: true,
            email: "parent@example.test",
            deletedAt: null,
            archivedAt: null,
            inheritEmailFromId: null,
            familyGroupMemberships: [{ familyGroupId: "fg-1" }],
          }
        : {
            id: "member-3",
            firstName: "Kai",
            lastName: "Hale",
            email: "kai@example.test",
            ageTier: "CHILD",
            deletedAt: null,
            archivedAt: null,
            parentMemberId: null,
            secondaryParentId: null,
            partnerLinksAsMemberA: [],
            partnerLinksAsMemberB: [],
            inheritEmailFromId: null,
            parent: null,
            secondaryParent: null,
            canLogin: true,
            role: "USER",
            financeAccessLevel: "NONE",
            accessRoles: [],
          },
    );
    h.prisma.member.update.mockResolvedValue({ ...dependantFamilyLink, canLogin: true });

    const { connection, browser } = await expectActionContract({
      actionId: "link_member_dependant",
      handler: linkDependant,
      args: {
        id: "parent-1",
        memberId: "member-3",
        inheritEmail: true,
        addToFamilyGroupIds: ["fg-1"],
        disableLogin: true,
      },
    });

    expect(connection).toEqual({ member: dependantFamilyLink });
    expect(browser).toMatchObject({ member: { canLogin: true } });
    const update = h.prisma.member.update.mock.calls[0]?.[0] as { where: unknown; data: Record<string, unknown> };
    expect(update.where).toEqual({ id: "member-3" });
    expect(update.data).toMatchObject({ parent: { connect: { id: "parent-1" } } });
    expect(update.data).not.toHaveProperty("canLogin");
  });

  it("unlink_member_dependant unlinks the dependant in the address from the parent in the address", async () => {
    h.resolveInheritedEmailSourceId.mockResolvedValue({ sourceId: "parent-2" });
    h.prisma.member.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "parent-1"
        ? { id: "parent-1" }
        : {
            id: "member-3",
            firstName: "Kai",
            lastName: "Hale",
            email: "kai@example.test",
            ageTier: "CHILD",
            active: true,
            canLogin: false,
            parentMemberId: "parent-1",
            secondaryParentId: "parent-2",
            inheritParentEmail: true,
            inheritEmailFromId: "parent-1",
            inheritEmailChoiceId: "parent-1",
            parent: { id: "parent-1" },
            secondaryParent: { id: "parent-2" },
          },
    );
    const unlinked = {
      ...dependantFamilyLink,
      parentMemberId: "parent-2",
      inheritEmailFromId: "parent-2",
      active: true,
      inheritParentEmail: true,
    };
    h.prisma.member.update.mockResolvedValue({ ...unlinked, canLogin: false });

    const { connection, browser } = await expectActionContract({
      actionId: "unlink_member_dependant",
      handler: unlinkDependant,
      args: { id: "parent-1", dependentId: "member-3" },
    });

    expect(connection).toEqual({ member: unlinked, clearedEmailInheritance: true, promotedSecondaryParent: true });
    expect(browser).toMatchObject({ member: { canLogin: false } });
    expect(h.prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "member-3" } }));
  });
});

describe("list_membership_types", () => {
  it("sends each type's id, key, name and whether it is active, never its rules", async () => {
    h.prisma.membershipType.findMany.mockResolvedValue([
      {
        id: "type-1",
        key: "FULL",
        name: "Full",
        description: "Full membership",
        publicDescription: null,
        publiclyListed: true,
        isActive: true,
        isBuiltIn: true,
        bookingBehavior: "STANDARD",
        subscriptionBehavior: "REQUIRED",
        ageGroupsApply: true,
        sortOrder: 1,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        allowedAgeTiers: [{ ageTier: "ADULT" }],
        _count: { assignments: 4 },
      },
    ]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_membership_types",
      handler: listMembershipTypes,
    });

    expect(connection).toEqual({
      membershipTypes: [{ id: "type-1", key: "FULL", name: "Full", isActive: true }],
      currentSeasonYear: expect.any(Number),
    });
    expect(browser).toMatchObject({ membershipTypes: [{ subscriptionBehavior: "REQUIRED" }] });
  });
});
