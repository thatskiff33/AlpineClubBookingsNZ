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
 *   and cron path reads;
 * - the admin lodge configuration screen previews the same rule against a
 *   capacity the admin has typed but not yet saved, so the explanation on
 *   screen can never drift from what the server will do.
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
  /** What is bookable: the lower of the two quantities, never above beds. */
  capacity: number;
  source: LodgeCapacitySource;
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
