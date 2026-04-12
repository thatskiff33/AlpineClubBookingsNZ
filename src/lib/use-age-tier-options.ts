"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState } from "react";

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

export function getAgeTierLabel(
  options: AgeTierOption[],
  tier: AgeTier | string
): string {
  return options.find((option) => option.tier === tier)?.label ?? tier;
}
