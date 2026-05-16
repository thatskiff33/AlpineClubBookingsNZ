import { featureFlagsSchema, type FeatureFlags } from "./schema";

/** Maps each feature flag to the env var that toggles it on. */
const FEATURE_ENV_VARS = {
  kiosk: "FEATURE_KIOSK",
  chores: "FEATURE_CHORES",
  financeDashboard: "FEATURE_FINANCE_DASHBOARD",
  waitlist: "FEATURE_WAITLIST",
  xeroIntegration: "FEATURE_XERO_INTEGRATION",
} as const satisfies Record<keyof FeatureFlags, string>;

/**
 * Parse a feature flag env var. Only the literal "true" (case-insensitive, trimmed)
 * enables a flag. Anything else — unset, "false", "1", "yes", garbage — disables it.
 * This is intentionally strict so accidental values default to "off" rather than "on".
 */
function parseFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return raw.trim().toLowerCase() === "true";
}

export function loadFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const flags = {
    kiosk: parseFlag(env[FEATURE_ENV_VARS.kiosk]),
    chores: parseFlag(env[FEATURE_ENV_VARS.chores]),
    financeDashboard: parseFlag(env[FEATURE_ENV_VARS.financeDashboard]),
    waitlist: parseFlag(env[FEATURE_ENV_VARS.waitlist]),
    xeroIntegration: parseFlag(env[FEATURE_ENV_VARS.xeroIntegration]),
  };
  return featureFlagsSchema.parse(flags);
}

/** Eagerly loaded singleton — Phase 4 will wire call sites to this. */
export const featureFlags: FeatureFlags = loadFeatureFlags();
