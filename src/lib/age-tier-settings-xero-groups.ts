import type { AgeTier } from "@prisma/client";

type AgeTierXeroGroupSelection = {
  tier: AgeTier;
  xeroContactGroupId: string | null;
  xeroContactGroupName: string | null;
  xeroAcceptedContactGroups: Array<{
    groupId: string;
    groupName: string | null;
  }>;
};

type XeroContactGroupOption = {
  id: string;
  name: string;
  contactCount: number;
};

type PrimaryXeroContactGroup = {
  id: string;
  name: string;
} | null;

export function getPrimaryXeroContactGroupIds(
  settings: AgeTierXeroGroupSelection[]
): Set<string> {
  return new Set(
    settings
      .map((setting) => setting.xeroContactGroupId)
      .filter((groupId): groupId is string => Boolean(groupId))
  );
}

export function buildAvailableAcceptedXeroContactGroups(
  settings: AgeTierXeroGroupSelection[],
  tier: AgeTier,
  xeroGroups: XeroContactGroupOption[]
): XeroContactGroupOption[] {
  const currentSetting = settings.find((setting) => setting.tier === tier);
  if (!currentSetting) {
    return [];
  }

  const primaryGroupIds = getPrimaryXeroContactGroupIds(settings);
  const optionsById = new Map<string, XeroContactGroupOption>();

  for (const group of currentSetting.xeroAcceptedContactGroups) {
    if (primaryGroupIds.has(group.groupId)) {
      continue;
    }
    if (xeroGroups.some((candidate) => candidate.id === group.groupId)) {
      continue;
    }

    optionsById.set(group.groupId, {
      id: group.groupId,
      name: group.groupName ?? group.groupId,
      contactCount: 0,
    });
  }

  for (const group of xeroGroups) {
    if (primaryGroupIds.has(group.id)) {
      continue;
    }

    optionsById.set(group.id, group);
  }

  return [...optionsById.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  );
}

export function applyPrimaryXeroContactGroupSelection<
  T extends AgeTierXeroGroupSelection,
>(settings: T[], tier: AgeTier, selectedGroup: PrimaryXeroContactGroup): T[] {
  return settings.map((setting) => {
    const nextAcceptedGroups = selectedGroup?.id
      ? setting.xeroAcceptedContactGroups.filter(
          (group) => group.groupId !== selectedGroup.id
        )
      : setting.tier === tier
        ? []
        : setting.xeroAcceptedContactGroups;

    if (setting.tier !== tier) {
      return nextAcceptedGroups === setting.xeroAcceptedContactGroups
        ? setting
        : {
            ...setting,
            xeroAcceptedContactGroups: nextAcceptedGroups,
          };
    }

    return {
      ...setting,
      xeroContactGroupId: selectedGroup?.id ?? null,
      xeroContactGroupName: selectedGroup?.name ?? null,
      xeroAcceptedContactGroups: nextAcceptedGroups,
    };
  });
}
