/**
 * The setup checklist's steps, in order: what the readiness report checks
 * (`setup-readiness.ts`) and what the progress save may mark (`PATCH
 * /api/admin/setup/progress`). Its own pure module so the progress schema,
 * which the AI app catalogue loads, does not pull in the readiness report's
 * file-system and provider reads.
 */
export const SETUP_STEP_IDS = [
  "club-config",
  "club-time-zone",
  "environment-role",
  "runtime-env",
  "auth-secret-strength",
  "data-encryption-keys",
  "database-role",
  "seed-admin",
  "feature-flags",
  "booking-policies",
  "membership-cancellation",
  "age-tiers",
  "seasons-rates",
  "key-rate-holders",
  "stripe",
  "email-ses",
  "sentry",
  "address-autocomplete",
  "xero-operational",
  "finance-dashboard",
  "xero-mappings",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
