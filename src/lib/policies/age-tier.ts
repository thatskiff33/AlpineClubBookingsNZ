import type { AgeTier } from "@prisma/client";
import { clubConfig } from "@/config/club";

/**
 * Returns April 1 of the given season year.
 * e.g. getSeasonStartDate(2026) => 2026-04-01
 */
export function getSeasonStartDate(seasonYear: number): Date {
  return new Date(seasonYear, 3, 1); // month 3 = April
}

export function computeAge(dateOfBirth: Date, referenceDate: Date): number {
  let age = referenceDate.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = referenceDate.getMonth() - dateOfBirth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getDate() < dateOfBirth.getDate())) {
    age--;
  }
  return age;
}

export type AgeTierSettingData = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking?: boolean;
  xeroContactGroupId?: string | null;
  xeroContactGroupName?: string | null;
  xeroAcceptedContactGroups?: Array<{
    groupId: string;
    groupName: string | null;
  }>;
  sortOrder: number;
};

export const AGE_TIER_DEFAULTS: AgeTierSettingData[] = clubConfig.ageTiers.map(
  (tier, sortOrder) => ({
    tier: tier.id as AgeTier,
    minAge: tier.minAge,
    maxAge: tier.maxAge,
    label: tier.label,
    subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
    xeroContactGroupId: null,
    xeroContactGroupName: null,
    xeroAcceptedContactGroups: [],
    sortOrder,
  }),
);

const LEGACY_THREE_TIER_SETTINGS = [
  { tier: "CHILD" as AgeTier, minAge: 0, maxAge: 9 as number | null, sortOrder: 1 },
  { tier: "YOUTH" as AgeTier, minAge: 10, maxAge: 17 as number | null, sortOrder: 2 },
  { tier: "ADULT" as AgeTier, minAge: 18, maxAge: null as number | null, sortOrder: 3 },
];

export function cloneAgeTierSettings(settings: AgeTierSettingData[]): AgeTierSettingData[] {
  return settings.map((setting) => ({
    ...setting,
    xeroAcceptedContactGroups: (setting.xeroAcceptedContactGroups ?? []).map((group) => ({
      ...group,
    })),
  }));
}

function isLegacyThreeTierSettings(settings: AgeTierSettingData[]): boolean {
  if (settings.length !== LEGACY_THREE_TIER_SETTINGS.length) {
    return false;
  }

  const sorted = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
  return LEGACY_THREE_TIER_SETTINGS.every((legacy, index) => {
    const actual = sorted[index];
    return (
      actual?.tier === legacy.tier &&
      actual.minAge === legacy.minAge &&
      actual.maxAge === legacy.maxAge &&
      actual.sortOrder === legacy.sortOrder
    );
  });
}

export function normalizeAgeTierSettings(
  settings: AgeTierSettingData[]
): AgeTierSettingData[] {
  if (settings.length === 0 || isLegacyThreeTierSettings(settings)) {
    return cloneAgeTierSettings(AGE_TIER_DEFAULTS);
  }

  return cloneAgeTierSettings(
    [...settings]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((setting) => ({
        ...setting,
        subscriptionRequiredForBooking:
          setting.subscriptionRequiredForBooking ?? true,
        xeroAcceptedContactGroups: setting.xeroAcceptedContactGroups ?? [],
      }))
  );
}

/**
 * Compute age tier from explicit settings array.
 * Settings are matched in ascending sortOrder; first match wins.
 * Falls back to ADULT if nothing matches.
 */
export function computeAgeTierWithSettings(
  dateOfBirth: Date,
  referenceDate: Date,
  settings: AgeTierSettingData[]
): AgeTier {
  const age = computeAge(dateOfBirth, referenceDate);
  const sorted = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const s of sorted) {
    if (age >= s.minAge && (s.maxAge === null || age <= s.maxAge)) {
      return s.tier;
    }
  }
  return "ADULT";
}
