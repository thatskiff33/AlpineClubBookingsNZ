import type { AgeTier } from "@prisma/client";
import { getSeasonYear } from "./utils";
import {
  AGE_TIER_DEFAULTS,
  cloneAgeTierSettings,
  computeAgeTierWithSettings,
  getSeasonStartDate,
  normalizeAgeTierSettings,
  type AgeTierSettingData,
} from "./policies/age-tier";

export {
  AGE_TIER_DEFAULTS,
  computeAge,
  computeAgeTierWithSettings,
  getSeasonStartDate,
  normalizeAgeTierSettings,
} from "./policies/age-tier";
export type { AgeTierSettingData } from "./policies/age-tier";

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
        subscriptionRequiredForBooking: r.subscriptionRequiredForBooking ?? true,
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
    // DB unavailable - fall through to defaults
  }

  return cloneAgeTierSettings(AGE_TIER_DEFAULTS);
}

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
