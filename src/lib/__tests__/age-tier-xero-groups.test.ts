import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ageTierSetting: {
      findMany: vi.fn(),
    },
    xeroSyncCursor: {
      findUnique: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    xeroContactGroupMembershipCache: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { getXeroContactGroupMismatchSnapshot } from "@/lib/age-tier-xero-groups";

describe("age-tier Xero contact group mismatch snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports cache-not-ready when the contact group cache has never been refreshed", async () => {
    vi.mocked(prisma.ageTierSetting.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroSyncCursor.findUnique).mockResolvedValue(null as any);

    const snapshot = await getXeroContactGroupMismatchSnapshot();

    expect(snapshot).toEqual({
      cacheReady: false,
      lastRefreshedAt: null,
      configuredMappings: [],
      count: 0,
      mismatches: [],
    });
  });

  it("flags linked members missing the expected managed group or carrying the wrong managed group", async () => {
    vi.mocked(prisma.ageTierSetting.findMany).mockResolvedValue([
      {
        tier: "CHILD",
        label: "Child",
        sortOrder: 1,
        xeroContactGroupId: "group-child",
        xeroContactGroupName: "Child Members",
      },
      {
        tier: "YOUTH",
        label: "Youth",
        sortOrder: 2,
        xeroContactGroupId: "group-youth",
        xeroContactGroupName: "Youth Members",
      },
    ] as any);
    vi.mocked(prisma.xeroSyncCursor.findUnique).mockResolvedValue({
      lastSuccessfulSyncAt: new Date("2026-04-26T00:00:00.000Z"),
    } as any);
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        id: "m-child",
        firstName: "Casey",
        lastName: "Child",
        email: "casey@example.com",
        ageTier: "CHILD",
        xeroContactId: "xc-child",
      },
      {
        id: "m-youth",
        firstName: "Yara",
        lastName: "Youth",
        email: "yara@example.com",
        ageTier: "YOUTH",
        xeroContactId: "xc-youth",
      },
    ] as any);
    vi.mocked(prisma.xeroContactGroupMembershipCache.findMany).mockResolvedValue([
      {
        contactId: "xc-child",
        contactGroupId: "group-youth",
        group: {
          name: "Youth Members",
        },
      },
      {
        contactId: "xc-youth",
        contactGroupId: "group-youth",
        group: {
          name: "Youth Members",
        },
      },
    ] as any);

    const snapshot = await getXeroContactGroupMismatchSnapshot();

    expect(snapshot.cacheReady).toBe(true);
    expect(snapshot.count).toBe(1);
    expect(snapshot.mismatches).toEqual([
      expect.objectContaining({
        memberId: "m-child",
        ageTier: "CHILD",
        expectedGroup: {
          id: "group-child",
          name: "Child Members",
        },
        missingExpectedGroup: true,
        unexpectedManagedGroups: [
          {
            id: "group-youth",
            name: "Youth Members",
            tier: "YOUTH",
          },
        ],
      }),
    ]);
  });
});
