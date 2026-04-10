"use client";

import { useEffect, useState } from "react";

export type AgeTierOption = {
  tier: "ADULT" | "YOUTH" | "CHILD";
  label: string;
};

type AgeTierSettingsResponse = {
  settings?: Array<{
    tier: "ADULT" | "YOUTH" | "CHILD";
    label: string;
    sortOrder?: number;
  }>;
};

const DEFAULT_AGE_TIER_OPTIONS: AgeTierOption[] = [
  { tier: "ADULT", label: "Adult (18+)" },
  { tier: "YOUTH", label: "Youth (10-17)" },
  { tier: "CHILD", label: "Child (under 10)" },
];

const DISPLAY_ORDER: AgeTierOption["tier"][] = ["ADULT", "YOUTH", "CHILD"];

export function getAgeTierOptionsFromSettings(
  settings?: AgeTierSettingsResponse["settings"]
): AgeTierOption[] {
  if (!settings || settings.length === 0) {
    return DEFAULT_AGE_TIER_OPTIONS;
  }

  const labelByTier = new Map(settings.map((setting) => [setting.tier, setting.label]));

  return DISPLAY_ORDER.map((tier) => ({
    tier,
    label: labelByTier.get(tier) ?? DEFAULT_AGE_TIER_OPTIONS.find((option) => option.tier === tier)!.label,
  }));
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
  tier: AgeTierOption["tier"] | string
): string {
  return options.find((option) => option.tier === tier)?.label ?? tier;
}
