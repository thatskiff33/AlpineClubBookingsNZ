"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState } from "react";
import type { MembershipTypeAgeExemption } from "@/lib/membership-types";

export type AgeTierOption = {
  tier: AgeTier;
  label: string;
  sortOrder: number;
};

type AgeTierSettingsResponse = {
  settings?: Array<{
    tier: AgeTier;
    label: string;
    sortOrder: number;
  }>;
};

const DEFAULT_AGE_TIER_OPTIONS: AgeTierOption[] = [
  { tier: "INFANT", label: "Infant (under 5)", sortOrder: 0 },
  { tier: "CHILD", label: "Child (5-9)", sortOrder: 1 },
  { tier: "YOUTH", label: "Youth (10-17)", sortOrder: 2 },
  { tier: "ADULT", label: "Adult (18+)", sortOrder: 3 },
];

// test seam
export function getAgeTierOptionsFromSettings(
  settings?: AgeTierSettingsResponse["settings"]
): AgeTierOption[] {
  if (!settings || settings.length === 0) {
    return DEFAULT_AGE_TIER_OPTIONS;
  }

  return [...settings]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => ({ tier: s.tier, label: s.label, sortOrder: s.sortOrder }));
}

export function useAgeTierOptions(): AgeTierOption[] {
  const [options, setOptions] = useState<AgeTierOption[]>(DEFAULT_AGE_TIER_OPTIONS);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/age-tier-settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: AgeTierSettingsResponse | null) => {
        if (!cancelled) {
          setOptions(getAgeTierOptionsFromSettings(data?.settings));
        }
      })
      .catch(() => {
        // Keep default labels if the settings lookup fails.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return options;
}

/**
 * Static display name for a tier, independent of the configurable
 * AgeTierSetting labels. NOT_APPLICABLE is the organisation/school tier
 * (#1440); it never has a settings row, so it always renders as "N/A".
 */
export function formatAgeTierName(tier: AgeTier | string): string {
  if (tier === "NOT_APPLICABLE") {
    return "N/A";
  }
  return tier.charAt(0) + tier.slice(1).toLowerCase();
}

export function getAgeTierLabel(
  options: AgeTierOption[],
  tier: AgeTier | string
): string {
  return (
    options.find((option) => option.tier === tier)?.label ??
    formatAgeTierName(tier)
  );
}

// The four real person tiers, always selectable in a member's age-tier picker.
const AGE_TIER_PERSON_TIERS = [
  "INFANT",
  "CHILD",
  "YOUTH",
  "ADULT",
] as const satisfies readonly AgeTier[];

/**
 * The age tiers a member's age-tier <Select> should offer, given the member's
 * current-season membership-type age-exemption (#2106).
 *
 * The four person tiers are always offered. N/A (NOT_APPLICABLE) is added as a
 * hand-pickable option ONLY when the type ALLOWS it and we are editing an
 * existing member — CREATE mode never offers N/A (no assignment exists yet to
 * carry it), and FORCED / DISALLOWED / null are handled by the caller (a
 * read-only N/A readout for FORCED, no N/A otherwise).
 */
export function ageTierSelectOptions(
  exemption: MembershipTypeAgeExemption | null | undefined,
  options?: { isCreate?: boolean }
): AgeTier[] {
  const tiers: AgeTier[] = [...AGE_TIER_PERSON_TIERS];
  if (!options?.isCreate && exemption === "ALLOWED") {
    tiers.push("NOT_APPLICABLE");
  }
  return tiers;
}
