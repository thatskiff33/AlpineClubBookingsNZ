/**
 * The effective-capacity rule, in one place (`INV-CAP-003`, `INV-SSOT-001`).
 *
 * A lodge has two distinct quantities (docs/CAPACITY_MODEL.md): the physical
 * bed inventory it can place guests into, and the maximum sleeping capacity an
 * admin configures. What is bookable is the LOWER of the two — a lodge may
 * have more beds installed than it is licensed to sleep (#1653), and an admin
 * may deliberately configure a capacity ABOVE the beds installed so far,
 * intending to install the rest later (#2724).
 *
 * This module is the one definition of that arithmetic. It is deliberately
 * pure and dependency-free so BOTH sides can read it:
 *
 * - `getLodgeCapacityStatus` (`src/lib/lodge-capacity.ts`) resolves the real
 *   figure from the database and is what every booking, availability, finance
 *   and cron path reads, and `getLodgePartnerSharedCapacityStatus` beside it
 *   resolves the partner-shared headroom through the same relationship;
 * - the admin lodge configuration screen previews both against a capacity the
 *   admin has typed but not yet saved, so the explanation on screen can never
 *   drift from what the server will do;
 * - `/api/admin/lodge-settings` reads the save bounds below, so a figure the
 *   screen calls acceptable is exactly a figure the schema accepts.
 *
 * Keep it free of Prisma, config and React imports: the client bundle imports
 * it directly.
 */

export type LodgeCapacitySource =
  | "configured_beds"
  | "capped_beds"
  | "capacity_override"
  | "unconfigured_lodge";

export interface EffectiveLodgeCapacityInput {
  /**
   * The admin-set maximum sleeping capacity for this lodge
   * (`LodgeSettings.capacity`), or null/undefined when none is set.
   */
  configuredCapacity: number | null | undefined;
  /**
   * Active `LodgeBed` rows in this lodge's rooms. Pass 0 when the Bed
   * Allocation module is off — with no bed inventory the configured capacity
   * is the whole answer, which is exactly the module-off behaviour.
   */
  activeBedCount: number;
}

export interface EffectiveLodgeCapacity {
  /**
   * What is bookable. With active beds present it is the LOWER of the two
   * quantities and therefore never above the beds; with no bed inventory at
   * all it is the configured capacity itself, which is exactly what the
   * module-off and no-beds fallback means. The unconditional reading —
   * "never above beds" — is false on that second branch, where there are no
   * beds to be below.
   */
  capacity: number;
  source: LodgeCapacitySource;
}

/**
 * The bounds a configured lodge capacity must satisfy to be saved
 * (`INV-SSOT-001`). One definition, read by all three places that decide
 * whether a typed figure is acceptable: the API schema
 * (`/api/admin/lodge-settings`), the lodge configuration screen's save, and
 * the guidance beside the field, which must not predict a save for a value
 * the server will refuse.
 */
export const MIN_CONFIGURED_LODGE_CAPACITY = 1;
export const MAX_CONFIGURED_LODGE_CAPACITY = 100_000;

/**
 * What to tell an officer whose typed capacity is outside those bounds.
 *
 * The thousands separator is inserted inline rather than with
 * `toLocaleString` or a shared formatter: this module must stay import-free so
 * the client bundle can read it (see the header), and a bare `toLocaleString`
 * is lint-restricted here (`INV-DATE-015`). The bound itself still comes from
 * the constant above, so there is one figure, not two.
 */
export const CONFIGURED_LODGE_CAPACITY_RANGE_MESSAGE = `Enter a whole number from ${MIN_CONFIGURED_LODGE_CAPACITY} to ${String(
  MAX_CONFIGURED_LODGE_CAPACITY,
).replace(/\B(?=(\d{3})+$)/g, ",")}, or clear it to fall back.`;

export type ParsedConfiguredLodgeCapacity =
  /** Field cleared: the lodge falls back (club default, or 0). */
  | { readonly kind: "cleared" }
  /** A figure the server will accept. */
  | { readonly kind: "valid"; readonly capacity: number }
  /** A figure the server will refuse, with the message to show. */
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Parse the raw contents of the capacity field into what the save will do with
 * it. Bounds live above, so the screen's prediction, the screen's save and the
 * API schema cannot fall out of step — a value this calls `valid` is exactly a
 * value `settingsSchema` accepts.
 */
export function parseConfiguredLodgeCapacity(
  raw: string,
): ParsedConfiguredLodgeCapacity {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "cleared" };

  const parsed = Number(trimmed);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_CONFIGURED_LODGE_CAPACITY ||
    parsed > MAX_CONFIGURED_LODGE_CAPACITY
  ) {
    return { kind: "invalid", message: CONFIGURED_LODGE_CAPACITY_RANGE_MESSAGE };
  }
  return { kind: "valid", capacity: parsed };
}

/**
 * Effective capacity for one lodge, and where the figure came from.
 *
 * With active beds present the beds are the inventory and an explicit
 * configured capacity is a ceiling on top of them, so the answer is the lower
 * of the two: a capacity at or above the bed count leaves the bed count
 * standing (`configured_beds`), and one below it caps the lodge
 * (`capped_beds`). Only an EXPLICIT capacity caps — an absent one never does.
 *
 * With no active beds the configured capacity is the answer
 * (`capacity_override`); with neither, the lodge resolves to 0
 * (`unconfigured_lodge`) so it is unbookable rather than overbookable until it
 * is set up (#1982). That deliberate zero is a known rough edge for a lodge
 * whose capacity is simply not configured yet, tracked on #3407 — it is
 * preserved here exactly, not worked around.
 */
export function resolveEffectiveLodgeCapacity(
  input: EffectiveLodgeCapacityInput,
): EffectiveLodgeCapacity {
  const configured =
    input.configuredCapacity === null || input.configuredCapacity === undefined
      ? null
      : input.configuredCapacity;

  if (input.activeBedCount <= 0) {
    return configured === null
      ? { capacity: 0, source: "unconfigured_lodge" }
      : { capacity: configured, source: "capacity_override" };
  }

  return configured !== null && configured < input.activeBedCount
    ? { capacity: configured, source: "capped_beds" }
    : { capacity: input.activeBedCount, source: "configured_beds" };
}

/**
 * True when an explicit configured capacity sits ABOVE the lodge's active bed
 * inventory, so the beds — not the configured value — are what currently
 * binds. Allowed and deliberate (#2724): the admin screen explains the
 * consequence instead of refusing the save.
 */
export function configuredCapacityExceedsActiveBeds(
  input: EffectiveLodgeCapacityInput,
): boolean {
  return (
    input.activeBedCount > 0 &&
    input.configuredCapacity !== null &&
    input.configuredCapacity !== undefined &&
    input.configuredCapacity > input.activeBedCount
  );
}

export interface PartnerSharedHeadroomInput extends EffectiveLodgeCapacityInput {
  /** Active `LodgeBed` rows in this lodge whose `bedType` is `DOUBLE`. */
  activeDoubleBedCount: number;
}

/**
 * Partner-shared double-bed headroom (#1745, `INV-CAP-031`): how many guests
 * beyond the base capacity may be admitted as second occupants of shared
 * DOUBLE beds.
 *
 * This is the SAME capacity-versus-beds relationship as above, and it lives
 * here for that reason. A configured capacity is a maximum *sleeping* capacity
 * (fire/consent/licence, #1653) and a sharer sleeps in the lodge like anyone
 * else, so the headroom is one slot per active DOUBLE, bounded by the gap
 * between that ceiling and the beds already counted. An absent capacity
 * bounds nothing, so every double contributes.
 *
 * The consequence the admin screen must not hide: the surplus of a configured
 * capacity over the active beds is NOT inert while more beds are awaited — it
 * is exactly what this headroom is measured against, so a lodge configured at
 * its bed count gets none at all (docs/CAPACITY_MODEL.md).
 */
export function resolvePartnerSharedHeadroom(
  input: PartnerSharedHeadroomInput,
): number {
  // Shared slots exist only where beds are the bookable inventory: with no
  // active beds there are no DOUBLE rows admitting a second occupant, and a
  // capacity below the bed count is an explicit people ceiling that already
  // binds.
  if (resolveEffectiveLodgeCapacity(input).source !== "configured_beds") {
    return 0;
  }

  const ceiling =
    input.configuredCapacity === null || input.configuredCapacity === undefined
      ? Number.POSITIVE_INFINITY
      : input.configuredCapacity;

  return Math.max(
    0,
    Math.min(input.activeDoubleBedCount, ceiling - input.activeBedCount),
  );
}
