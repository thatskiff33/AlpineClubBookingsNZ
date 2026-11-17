import type { AgeTierSettingData } from "@/lib/policies/age-tier";

/**
 * The age-tier editor's row shape and read normaliser.
 *
 * The built-in tiers are NOT defined here: `AGE_TIER_DEFAULTS` in
 * `@/lib/policies/age-tier` is the one hard-coded age-tier safety net, and the
 * editor's empty-database fallback and "Restore default tiers" read it
 * (INV-SSOT-001). A row is that policy shape with its two booleans resolved.
 */
export type AgeTierRow = Required<AgeTierSettingData>;

/** Resolves the optional booleans a stored row may lack, into an editor row. */
export function normalizeAgeTierRows(rows: AgeTierSettingData[]): AgeTierRow[] {
  return rows.map((row) => ({
    ...row,
    subscriptionRequiredForBooking: row.subscriptionRequiredForBooking ?? true,
    familyGroupRequestCreateMemberAllowed:
      row.familyGroupRequestCreateMemberAllowed ?? false,
  }));
}
