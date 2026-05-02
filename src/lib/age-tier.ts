import type { AgeTier } from "@prisma/client";
import { getSeasonYear } from "./utils";

// ---------------------------------------------------------------------------
// Season start date helper
// ---------------------------------------------------------------------------

/**
 * Returns April 1 of the given season year.
 * e.g. getSeasonStartDate(2026) => 2026-04-01
 */
export function getSeasonStartDate(seasonYear: number): Date {
  return new Date(seasonYear, 3, 1); // month 3 = April
}

// ---------------------------------------------------------------------------
// Age calculation
// ---------------------------------------------------------------------------

export function computeAge(dateOfBirth: Date, referenceDate: Date): number {
  let age = referenceDate.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = referenceDate.getMonth() - dateOfBirth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getDate() < dateOfBirth.getDate())) {
    age--;
  }
  return age;
}

// ---------------------------------------------------------------------------
// Hardcoded defaults (used as fallback if DB is unavailable)
// ---------------------------------------------------------------------------

export const AGE_TIER_DEFAULTS = [
  { tier: "INFANT" as AgeTier, minAge: 0, maxAge: 4, label: "Infant (under 5)", xeroContactGroupId: null, xeroContactGroupName: null, xeroAcceptedContactGroups: [], sortOrder: 0 },
  { tier: "CHILD" as AgeTier, minAge: 5, maxAge: 9 as number | null, label: "Child (5-9)", xeroContactGroupId: null, xeroContactGroupName: null, xeroAcceptedContactGroups: [], sortOrder: 1 },
  { tier: "YOUTH" as AgeTier, minAge: 10, maxAge: 17 as number | null, label: "Youth (10-17)", xeroContactGroupId: null, xeroContactGroupName: null, xeroAcceptedContactGroups: [], sortOrder: 2 },
  { tier: "ADULT" as AgeTier, minAge: 18, maxAge: null as number | null, label: "Adult (18+)", xeroContactGroupId: null, xeroContactGroupName: null, xeroAcceptedContactGroups: [], sortOrder: 3 },
];

export type AgeTierSettingData = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  xeroContactGroupId?: string | null;
  xeroContactGroupName?: string | null;
  xeroAcceptedContactGroups?: Array<{
    groupId: string;
    groupName: string | null;
  }>;
  sortOrder: number;
};

const LEGACY_THREE_TIER_SETTINGS = [
  { tier: "CHILD" as AgeTier, minAge: 0, maxAge: 9 as number | null, sortOrder: 1 },
  { tier: "YOUTH" as AgeTier, minAge: 10, maxAge: 17 as number | null, sortOrder: 2 },
  { tier: "ADULT" as AgeTier, minAge: 18, maxAge: null as number | null, sortOrder: 3 },
];

function cloneAgeTierSettings(settings: AgeTierSettingData[]): AgeTierSettingData[] {
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
        xeroAcceptedContactGroups: setting.xeroAcceptedContactGroups ?? [],
      }))
  );
}

// ---------------------------------------------------------------------------
// Pure synchronous core (testable without DB)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// DB-backed cache
// ---------------------------------------------------------------------------

let _cachedSettings: AgeTierSettingData[] | null = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Invalidate the in-memory settings cache (call after PUT /api/admin/age-tier-settings). */
export function invalidateAgeTierCache(): void {
  _cachedSettings = null;
  _cacheExpiry = 0;
}

/**
 * Fetch age tier settings from DB with 5-minute in-memory cache.
 * Falls back to hardcoded defaults if DB is unavailable.
 */
export async function getAgeTierSettings(): Promise<AgeTierSettingData[]> {
  const now = Date.now();
  if (_cachedSettings && now < _cacheExpiry) {
    return _cachedSettings;
  }

  try {
    // Dynamic import to avoid circular deps and allow test mocking
    const { prisma } = await import("./prisma");
    const rows = await prisma.ageTierSetting.findMany({
      orderBy: { sortOrder: "asc" },
      include: {
        xeroAcceptedContactGroups: {
          orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
        },
      },
    });
    const normalized = normalizeAgeTierSettings(
      rows.map((r) => ({
        tier: r.tier,
        minAge: r.minAge,
        maxAge: r.maxAge,
        label: r.label,
        xeroContactGroupId: r.xeroContactGroupId,
        xeroContactGroupName: r.xeroContactGroupName,
        xeroAcceptedContactGroups: Array.isArray(r.xeroAcceptedContactGroups)
          ? r.xeroAcceptedContactGroups.map((group) => ({
              groupId: group.groupId,
              groupName: group.groupName,
            }))
          : [],
        sortOrder: r.sortOrder,
      }))
    );
    if (normalized.length > 0) {
      _cachedSettings = normalized;
      _cacheExpiry = now + CACHE_TTL_MS;
      return _cachedSettings;
    }
  } catch {
    // DB unavailable — fall through to defaults
  }

  return cloneAgeTierSettings(AGE_TIER_DEFAULTS);
}

// ---------------------------------------------------------------------------
// Public async API
// ---------------------------------------------------------------------------

/**
 * Compute age tier for a date of birth.
 *
 * referenceDate defaults to April 1 of the current season year (the TAC
 * reference point for age classification). Reads boundaries from DB with a
 * 5-minute cache; falls back to hardcoded defaults if DB is unavailable.
 */
export async function computeAgeTier(
  dateOfBirth: Date,
  referenceDate?: Date
): Promise<AgeTier> {
  const ref = referenceDate ?? getSeasonStartDate(getSeasonYear());
  const settings = await getAgeTierSettings();
  return computeAgeTierWithSettings(dateOfBirth, ref, settings);
}

// Re-export from canonical location for backwards compatibility
export { getSeasonYear as computeSeasonYear } from "./utils";
