import type { AgeTier } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const CONTACT_GROUP_CACHE_CURSOR_RESOURCE = "CONTACT_GROUP_CACHE";
const DEFAULT_XERO_SYNC_SCOPE = "default";

export interface AgeTierXeroContactGroupMapping {
  tier: AgeTier;
  label: string;
  sortOrder: number;
  groupId: string;
  groupName: string | null;
}

export interface XeroContactGroupMismatchEntry {
  memberId: string;
  memberName: string;
  memberEmail: string;
  ageTier: AgeTier;
  xeroContactId: string;
  expectedGroup: {
    id: string;
    name: string | null;
  };
  actualGroups: Array<{
    id: string;
    name: string;
  }>;
  unexpectedManagedGroups: Array<{
    id: string;
    name: string;
    tier: AgeTier | null;
  }>;
  missingExpectedGroup: boolean;
}

export interface XeroContactGroupMismatchSnapshot {
  cacheReady: boolean;
  lastRefreshedAt: string | null;
  configuredMappings: AgeTierXeroContactGroupMapping[];
  count: number;
  mismatches: XeroContactGroupMismatchEntry[];
}

export async function getAgeTierXeroContactGroupMappings(): Promise<
  AgeTierXeroContactGroupMapping[]
> {
  const rows = await prisma.ageTierSetting.findMany({
    where: {
      xeroContactGroupId: {
        not: null,
      },
    },
    orderBy: {
      sortOrder: "asc",
    },
    select: {
      tier: true,
      label: true,
      sortOrder: true,
      xeroContactGroupId: true,
      xeroContactGroupName: true,
    },
  });

  return rows.flatMap((row) =>
    row.xeroContactGroupId
      ? [
          {
            tier: row.tier,
            label: row.label,
            sortOrder: row.sortOrder,
            groupId: row.xeroContactGroupId,
            groupName: row.xeroContactGroupName,
          } satisfies AgeTierXeroContactGroupMapping,
        ]
      : []
  );
}

export async function getXeroContactGroupMismatchSnapshot(options?: {
  limit?: number;
}): Promise<XeroContactGroupMismatchSnapshot> {
  const [configuredMappings, cursor] = await Promise.all([
    getAgeTierXeroContactGroupMappings(),
    prisma.xeroSyncCursor.findUnique({
      where: {
        resourceType_scope: {
          resourceType: CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
          scope: DEFAULT_XERO_SYNC_SCOPE,
        },
      },
      select: {
        lastSuccessfulSyncAt: true,
      },
    }),
  ]);

  if (!cursor?.lastSuccessfulSyncAt) {
    return {
      cacheReady: false,
      lastRefreshedAt: null,
      configuredMappings,
      count: 0,
      mismatches: [],
    };
  }

  if (configuredMappings.length === 0) {
    return {
      cacheReady: true,
      lastRefreshedAt: cursor.lastSuccessfulSyncAt.toISOString(),
      configuredMappings,
      count: 0,
      mismatches: [],
    };
  }

  const members = await prisma.member.findMany({
    where: {
      active: true,
      xeroContactId: {
        not: null,
      },
    },
    orderBy: [{ ageTier: "asc" }, { lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
      xeroContactId: true,
    },
  });

  const contactIds = members
    .map((member) => member.xeroContactId)
    .filter((contactId): contactId is string => Boolean(contactId));

  const memberships = contactIds.length
    ? await prisma.xeroContactGroupMembershipCache.findMany({
        where: {
          contactId: {
            in: contactIds,
          },
        },
        select: {
          contactId: true,
          contactGroupId: true,
          group: {
            select: {
              name: true,
            },
          },
        },
      })
    : [];

  const groupsByContactId = new Map<
    string,
    Array<{
      id: string;
      name: string;
    }>
  >();
  for (const membership of memberships) {
    const existing = groupsByContactId.get(membership.contactId) ?? [];
    existing.push({
      id: membership.contactGroupId,
      name: membership.group.name,
    });
    groupsByContactId.set(membership.contactId, existing);
  }

  const mappingByTier = new Map(
    configuredMappings.map((mapping) => [mapping.tier, mapping] as const)
  );
  const tierByManagedGroupId = new Map(
    configuredMappings.map((mapping) => [mapping.groupId, mapping.tier] as const)
  );
  const managedGroupIds = new Set(
    configuredMappings.map((mapping) => mapping.groupId)
  );

  const mismatches = members.flatMap((member) => {
    if (!member.xeroContactId) {
      return [];
    }

    const expectedGroup = mappingByTier.get(member.ageTier);
    if (!expectedGroup) {
      return [];
    }

    const actualGroups = groupsByContactId.get(member.xeroContactId) ?? [];
    const unexpectedManagedGroups = actualGroups
      .filter((group) => managedGroupIds.has(group.id) && group.id !== expectedGroup.groupId)
      .map((group) => ({
        ...group,
        tier: tierByManagedGroupId.get(group.id) ?? null,
      }));
    const missingExpectedGroup = !actualGroups.some(
      (group) => group.id === expectedGroup.groupId
    );

    if (!missingExpectedGroup && unexpectedManagedGroups.length === 0) {
      return [];
    }

    return [
      {
        memberId: member.id,
        memberName: `${member.firstName} ${member.lastName}`,
        memberEmail: member.email,
        ageTier: member.ageTier,
        xeroContactId: member.xeroContactId,
        expectedGroup: {
          id: expectedGroup.groupId,
          name: expectedGroup.groupName,
        },
        actualGroups,
        unexpectedManagedGroups,
        missingExpectedGroup,
      } satisfies XeroContactGroupMismatchEntry,
    ];
  });

  return {
    cacheReady: true,
    lastRefreshedAt: cursor.lastSuccessfulSyncAt.toISOString(),
    configuredMappings,
    count: mismatches.length,
    mismatches:
      typeof options?.limit === "number"
        ? mismatches.slice(0, Math.max(1, options.limit))
        : mismatches,
  };
}
