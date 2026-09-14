import type { DisplayNameGranularity } from "@prisma/client";

// The four name-detail levels as something a person CHOOSES between: the order
// they are offered in, and the words an administrator reads for each.
//
// WHY THIS IS SEPARATE FROM `display-name-granularity.ts`. That module is the
// pure rule engine — it answers "given this level, what does this name become".
// It says nothing about presentation, and it should not: it is imported by
// server code that never renders anything. What a club officer reads on a
// settings screen, and the order the options appear in, is presentation, and it
// belongs somewhere a client component may import. This module is that place,
// and it is deliberately type-only in its imports so it stays client-safe.
//
// WHY IT EXISTS AT ALL. Two surfaces now let an administrator pick a level: the
// lobby display's per-lodge dial and the member lodge roster's (#2942). Before
// this file each spelled the four values and the four labels itself, so the
// second surface would have been a fourth copy of a list the schema already
// fixes. `INV-SSOT`: a rule a second place needs gets an import, not a copy.
//
// DELIBERATELY NOT CENTRALISED HERE: the bundle-validation list in
// `config-transfer/categories/lodge-config.ts`. That one checks values arriving
// from ANOTHER deployment's export file, so it is pinned to the bundle format
// rather than to whatever this product currently offers; coupling it to a UI
// constant would make a future UI change silently reject or accept old bundles.

/**
 * Every level, in the order a settings screen offers them — most detail first,
 * so reading down the list is reading privacy increasing.
 *
 * `satisfies` rather than an annotation, so the array keeps its literal tuple
 * type (`z.enum` and exhaustive `Record`s need that) while still failing to
 * compile if the schema enum ever gains or renames a value.
 */
export const DISPLAY_NAME_GRANULARITY_VALUES = [
  "FULL_NAME",
  "FIRST_NAME_SURNAME_INITIAL",
  "FIRST_NAME_ONLY",
  "COUNTS_ONLY",
] as const satisfies readonly DisplayNameGranularity[];

/**
 * What each level is called on an admin screen.
 *
 * An exhaustive `Record`, so adding a level to the schema enum fails to compile
 * here rather than rendering a blank option nobody can interpret.
 */
export const DISPLAY_NAME_GRANULARITY_LABELS: Record<
  DisplayNameGranularity,
  string
> = {
  FULL_NAME: "Full names",
  FIRST_NAME_SURNAME_INITIAL: "First name + surname initial",
  FIRST_NAME_ONLY: "First names only",
  COUNTS_ONLY: "Counts only (no names)",
};
