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
  isDefault: boolean;
}

export interface AgeTierXeroContactGroupConfig {
  tier: AgeTier;
  label: string;
  sortOrder: number;
  defaultGroup: {
    id: string;
    name: string | null;
  } | null;
  acceptedGroups: Array<{
    id: string;
    name: string | null;
    isDefault: boolean;
  }>;
}

export interface XeroContactGroupMismatchEntry {
  memberId: string;
  memberName: string;
  memberEmail: string;
  ageTier: AgeTier;
  xeroContactId: string;
  defaultGroup: {
    id: string;
    name: string | null;
  } | null;
  acceptedGroups: Array<{
    id: string;
    name: string | null;
    isDefault: boolean;
  }>;
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

export function buildAgeTierXeroContactGroupConfigs(
  mappings: AgeTierXeroContactGroupMapping[]
): AgeTierXeroContactGroupConfig[] {
  const configs = new Map<AgeTier, AgeTierXeroContactGroupConfig>();

  for (const mapping of mappings) {
    const existing = configs.get(mapping.tier) ?? {
      tier: mapping.tier,
      label: mapping.label,
      sortOrder: mapping.sortOrder,
      defaultGroup: null,
      acceptedGroups: [],
    };

    const group = {
      id: mapping.groupId,
      name: mapping.groupName,
      isDefault: mapping.isDefault,
    };

    existing.acceptedGroups.push(group);
    if (mapping.isDefault) {
      existing.defaultGroup = {
        id: mapping.groupId,
        name: mapping.groupName,
      };
    }

    configs.set(mapping.tier, existing);
  }

  return [...configs.values()]
    .map((config) => ({
      ...config,
      acceptedGroups: config.acceptedGroups.sort((left, right) => {
        if (left.isDefault !== right.isDefault) {
          return left.isDefault ? -1 : 1;
        }

        return (left.name ?? left.id).localeCompare(right.name ?? right.id);
      }),
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

export function buildAgeTierXeroContactGroupConfigMap(
  mappings: AgeTierXeroContactGroupMapping[]
): Map<AgeTier, AgeTierXeroContactGroupConfig> {
  return new Map(
    buildAgeTierXeroContactGroupConfigs(mappings).map((config) => [config.tier, config] as const)
  );
}

export async function getAgeTierXeroContactGroupMappings(): Promise<
  AgeTierXeroContactGroupMapping[]
> {
  const rows = await prisma.ageTierSetting.findMany({
    orderBy: {
      sortOrder: "asc",
    },
    select: {
      tier: true,
      label: true,
      sortOrder: true,
      xeroContactGroupId: true,
      xeroContactGroupName: true,
      xeroAcceptedContactGroups: {
        orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
        select: {
          groupId: true,
          groupName: true,
        },
      },
    },
  });

  return rows.flatMap((row) => {
    const mappings: AgeTierXeroContactGroupMapping[] = [];

    if (row.xeroContactGroupId) {
      mappings.push({
        tier: row.tier,
        label: row.label,
        sortOrder: row.sortOrder,
        groupId: row.xeroContactGroupId,
        groupName: row.xeroContactGroupName,
        isDefault: true,
      });
    }

    for (const group of row.xeroAcceptedContactGroups ?? []) {
      mappings.push({
        tier: row.tier,
        label: row.label,
        sortOrder: row.sortOrder,
        groupId: group.groupId,
        groupName: group.groupName,
        isDefault: false,
      });
    }

    return mappings;
  });
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

  const configByTier = buildAgeTierXeroContactGroupConfigMap(configuredMappings);
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

    const expectedConfig = configByTier.get(member.ageTier);
    if (!expectedConfig || expectedConfig.acceptedGroups.length === 0) {
      return [];
    }

    const actualGroups = groupsByContactId.get(member.xeroContactId) ?? [];
    const acceptedGroupIds = new Set(
      expectedConfig.acceptedGroups.map((group) => group.id)
    );
    const unexpectedManagedGroups = actualGroups
      .filter((group) => managedGroupIds.has(group.id) && !acceptedGroupIds.has(group.id))
      .map((group) => ({
        ...group,
        tier: tierByManagedGroupId.get(group.id) ?? null,
      }));
    const missingExpectedGroup = !actualGroups.some(
      (group) => acceptedGroupIds.has(group.id)
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
        defaultGroup: expectedConfig.defaultGroup,
        acceptedGroups: expectedConfig.acceptedGroups,
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
