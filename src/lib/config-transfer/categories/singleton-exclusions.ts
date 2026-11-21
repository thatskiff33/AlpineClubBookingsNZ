import type { SingletonSpec } from "./club-settings";

/**
 * The singletons whose `defaults()` legitimately covers none (or only some) of
 * their fields. Both are made entirely of nullable OVERRIDE columns resolved
 * through the deployment's `config/club.json` / environment fallback chain, so
 * "never saved" means "no override" — exactly what their admin GETs synthesise
 * — and the fallback values belong to the install rather than to the club's
 * portable configuration. Guarded by a test so a genuinely under-specified new
 * singleton cannot join them silently.
 */
export const DEFAULTS_INTENTIONALLY_PARTIAL = new Set([
  "club-identity-settings",
  "email-message-setting",
]);

/**
 * Columns present on (most) singletons that are never portable club
 * configuration: the fixed singleton primary key, the audit FK to the member
 * who last saved on the SOURCE install (that id need not exist on the target),
 * and the row timestamps. They are excluded from every export by omission from
 * `fields`; enumerated here so the reverse drift guard (#2178) treats the
 * omission as a deliberate decision rather than an oversight. Kept as one shared
 * set so the exclusion mechanism stays uniform across all 12 singletons. A model
 * that lacks one of these columns (e.g. BookingDefaults has no timestamps) is
 * unaffected: the guard only requires columns ⊆ fields ∪ excluded, never the
 * reverse, so this can be a tolerant superset.
 */
export const COMMON_EXCLUDED_COLUMNS: Record<string, string> = {
  id: 'singleton primary key (always "default") — identity, not configuration',
  updatedByMemberId:
    "audit FK to the source install's member; the id need not exist on the target",
  createdAt: "row creation timestamp — instance-local bookkeeping",
  updatedAt: "row mutation timestamp — instance-local bookkeeping",
};

/** Full column-exclusion set for a singleton: the shared columns plus its own. */
export function excludedColumnsFor(spec: SingletonSpec): Record<string, string> {
  return { ...COMMON_EXCLUDED_COLUMNS, ...spec.excluded };
}
