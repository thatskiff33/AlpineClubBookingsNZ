// #5248: the members list can be filtered by subscription category, including
// "no category", and the CSV export applies the same filter so the exported
// roster matches the screen. Drives the real list and export routes against a
// mocked Prisma and checks the where-clause each one sends.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: vi.fn(), count: vi.fn() },
    clubTimeSettings: { findUnique: vi.fn() },
    clubIdentitySettings: { findUnique: vi.fn() },
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/member-fields-settings", () => ({
  loadMemberFieldsFlags: vi.fn().mockResolvedValue({
    showTitle: false,
    showGender: false,
    showOccupation: false,
  }),
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
  getAgeTierSettings: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/xero-contact-groups", () => ({
  getXeroContactGroupMemberships: vi.fn().mockResolvedValue({}),
  syncManagedXeroContactGroupForMember: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { GET as listMembers } from "@/app/api/admin/members/route";
import { GET as exportMembers } from "@/app/api/admin/members/export/route";
import { NO_SUBSCRIPTION_CATEGORY_VALUE } from "@/lib/subscription-category-filter";

const adminGuard = {
  ok: true,
  session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

// The frozen test clock (2026-07-01) is in the club's 2026 season.
const CURRENT_SEASON = 2026;

async function listWhere(query: string) {
  const res = await listMembers(
    new NextRequest(`http://localhost/api/admin/members?${query}`),
  );
  expect(res.status).toBe(200);
  return vi.mocked(prisma.member.findMany).mock.calls[0][0]!.where as {
    AND?: unknown[];
  };
}

async function exportWhere(query: string) {
  const res = await exportMembers(
    new NextRequest(`http://localhost/api/admin/members/export?${query}`),
  );
  expect(res.status).toBe(200);
  return vi.mocked(prisma.member.findMany).mock.calls[0][0]!.where as {
    AND?: unknown[];
  };
}

const categoryClause = {
  seasonalMembershipAssignments: {
    some: { seasonYear: CURRENT_SEASON, subscriptionCategoryId: "cat-couple" },
  },
};
// "No category" must still match a member with no assignment at all, so it is
// "no current-season assignment WITH a category", never "an assignment whose
// category is null".
const noCategoryClause = {
  seasonalMembershipAssignments: {
    none: {
      seasonYear: CURRENT_SEASON,
      subscriptionCategoryId: { not: null },
    },
  },
};

function mentionsCategory(where: unknown) {
  return JSON.stringify(where).includes("subscriptionCategoryId");
}

describe("members list and export — subscription category filter (#5248)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminGuard);
    vi.mocked(prisma.member.findMany).mockResolvedValue([]);
    vi.mocked(prisma.member.count).mockResolvedValue(0);
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue({
      timeZone: "Pacific/Auckland",
      updatedByMemberId: null,
      updatedAt: new Date(0),
    } as never);
  });

  it.each([
    ["the list", listWhere],
    ["the CSV export", exportWhere],
  ])("%s filters to one category's current-season members", async (_label, whereFor) => {
    const where = await whereFor("subscriptionCategory=cat-couple");
    expect(where.AND).toEqual(expect.arrayContaining([categoryClause]));
  });

  it.each([
    ["the list", listWhere],
    ["the CSV export", exportWhere],
  ])("%s filters an archived category by id like any other", async (_label, whereFor) => {
    // An archived category still has members until someone moves them; the
    // filter is how an officer finds them, so it is not limited to active ids.
    const where = await whereFor("subscriptionCategory=cat-archived");
    expect(where.AND).toEqual(
      expect.arrayContaining([
        {
          seasonalMembershipAssignments: {
            some: {
              seasonYear: CURRENT_SEASON,
              subscriptionCategoryId: "cat-archived",
            },
          },
        },
      ]),
    );
  });

  it.each([
    ["the list", listWhere],
    ["the CSV export", exportWhere],
  ])("%s filters 'no category' including members with no assignment", async (_label, whereFor) => {
    const where = await whereFor(`subscriptionCategory=${NO_SUBSCRIPTION_CATEGORY_VALUE}`);
    expect(where.AND).toEqual(expect.arrayContaining([noCategoryClause]));
  });

  it.each([
    ["the list", listWhere],
    ["the CSV export", exportWhere],
  ])("%s applies no category clause when the filter is unset", async (_label, whereFor) => {
    const where = await whereFor("");
    expect(mentionsCategory(where)).toBe(false);
  });

  it("returns each row's current-season category, null for Individual", async () => {
    const baseRow = {
      firstName: "Ann",
      lastName: "Member",
      email: "ann@example.com",
      role: "USER",
      ageTier: "ADULT",
      active: true,
      canLogin: true,
      xeroContactId: null,
      createdAt: new Date("2025-01-01"),
      accessRoles: [{ role: "USER" }],
      familyGroupMemberships: [],
      subscriptions: [],
      passwordResetTokens: [],
    };
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        ...baseRow,
        id: "m-couple",
        seasonalMembershipAssignments: [
          {
            membershipType: null,
            subscriptionCategory: {
              id: "cat-couple",
              key: "couple",
              name: "Couple",
              isActive: false,
              isBuiltIn: false,
            },
          },
        ],
      },
      { ...baseRow, id: "m-individual", seasonalMembershipAssignments: [] },
    ] as never);
    vi.mocked(prisma.member.count).mockResolvedValue(2);

    const res = await listMembers(new NextRequest("http://localhost/api/admin/members"));
    const body = await res.json();
    expect(body.members.map((m: { currentSubscriptionCategory: unknown }) => m.currentSubscriptionCategory)).toEqual([
      { id: "cat-couple", key: "couple", name: "Couple", isActive: false },
      null,
    ]);
  });
});
