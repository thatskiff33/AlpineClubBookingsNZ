/**
 * The nightly-rate GRID a season's rates are edited on, and what it means to
 * copy one season's configuration onto a new one (#2938).
 *
 * ## Why this is a module and not eleven helpers inside a form
 *
 * Every function here used to live inside `hut-fees-section.tsx`, where the only
 * way to exercise any of them was to render the whole admin console over a fake
 * API. That was tolerable while they were formatting helpers. It stopped being
 * tolerable when #2933 made one of them carry a money rule: `emptyRateCells`
 * seeds an unset cell to `null` rather than `0`, and that single character is
 * the difference between "this club does not price this membership type on this
 * season" and "this club houses them for free". A rule that decides whether
 * guests are charged deserves a test that names it, and the copy action below
 * needs the same rule a second time — which is the point at which it has to have
 * one home (`INV-SSOT-001`).
 *
 * ## Absence and zero are different amounts, and this module never confuses them
 *
 * A grid cell holds `number | null`:
 *
 * - `null` — **no rate**. No `MembershipTypeSeasonRate` row exists. The pricing
 *   engine refuses a booking that needs it (`findRateForNight` returns `null`
 *   and `calculateBookingPrice` throws), and the Hut Fees screen warns about it
 *   ahead of time.
 * - `0` — **a rate of $0.00**, which somebody set deliberately. A row exists,
 *   the engine reads it, and the guest is charged nothing.
 *
 * Before #2933 the form seeded every blank cell to `0` and sent all of them, so
 * an officer who opened the season the missing-rates panel had just warned them
 * about and pressed Save closed the gap by charging those guests nothing — the
 * warning went away because the rows existed. `rateRowsFromCells` is that fix
 * expressed once: an absent cell is NOT SENT, a zero cell IS.
 *
 * **`copySeasonConfiguration` inherits that rule rather than restating it.** A
 * copy that flattened absence to zero would manufacture exactly the rows the
 * warning exists to prevent, in bulk, across a whole new season — and it would
 * do it on the screen whose whole job is to stop that happening.
 *
 * ## What a copy carries, and what it cannot
 *
 * `SeasonConfigurationCopy` holds the season's **configuration**: its type, its
 * active flag, its flat whole-lodge night rate, and its grid of nightly rates.
 * It has no `id`, no `name` and no dates, and that is a type-level fact rather
 * than a convention somebody has to remember — "make the wrong thing
 * unrepresentable" beats "police it in review" (`AGENTS.md` → Change
 * Discipline). A copied season therefore cannot inherit the source's identity,
 * cannot silently overwrite the source (the form has no `editingId` to PUT to),
 * and still has to be given a name and a window by the officer, which then go
 * through the POST route's ordinary overlap and shape validation.
 *
 * The source is never mutated: every value returned is freshly built, and the
 * rate cells are copied by value out of the source's rows. Integer cents are
 * carried ACROSS as integers — nothing here divides by 100, formats, parses, or
 * otherwise round-trips an amount through a decimal string (`INV-MONEY-001`,
 * `INV-MONEY-003`). `amountFieldValue` renders cents for display only, and the
 * form's stored cents are what a save sends.
 *
 * ## Isomorphic on purpose
 *
 * No Prisma client, no `node:fs`, no zod, no clock: the Hut Fees section is a
 * `"use client"` component. The only `@prisma/client` import is the `AgeTier`
 * type, which erases at compile time.
 */

import type { AgeTier } from "@prisma/client";

import { must } from "@/lib/indexed-access";
import { formatCentsPlain } from "@/lib/utils";

/**
 * The cell key half that stands in for "this type has one rate for all ages".
 *
 * A flat type's row carries `ageTier: null`, and `null` is not a usable object
 * key, so the grid spells it. Kept distinct from every `AgeTier` member —
 * `parseRateCellKey` maps it back to `null` on the way out.
 */
export const FLAT_RATE_CELL_KEY = "FLAT";

/** One cell of the grid: an age tier, or the flat all-ages rate. */
export type RateCell = AgeTier | typeof FLAT_RATE_CELL_KEY;

/** A stored nightly rate row, as the seasons API returns it. */
export interface SeasonRateRow {
  membershipTypeId: string;
  ageTier: AgeTier | null;
  pricePerNightCents: number;
}

/** The two things about a membership type that decide its cells. */
export interface RateGridType {
  id: string;
  ageGroupsApply: boolean;
}

/** The club's own age tiers, in the order it configured them. */
export interface RateGridTier {
  tier: AgeTier;
}

/**
 * Every grid cell's amount, keyed by {@link rateCellKey}. `null` is no rate.
 *
 * A plain record rather than a Map because it is React form state, read and
 * replaced by value on every keystroke.
 */
export type RateCells = Record<string, number | null>;

/** The grid key for one membership type's cell. */
export function rateCellKey(membershipTypeId: string, cell: RateCell): string {
  return `${membershipTypeId}::${cell}`;
}

/**
 * The membership type and age tier a grid key names.
 *
 * `String.prototype.split` always yields at least one element, so the id half
 * is present for every key {@link rateCellKey} built; `must` says so once here
 * rather than letting a missing membership type id ride into a saved rate row
 * (#2801).
 */
export function parseRateCellKey(key: string): {
  membershipTypeId: string;
  ageTier: AgeTier | null;
} {
  const [membershipTypeId, tierPart] = key.split("::");
  return {
    membershipTypeId: must(
      membershipTypeId,
      `hut fees: rate key "${key}" carries no membership type id`,
    ),
    ageTier: tierPart === FLAT_RATE_CELL_KEY ? null : (tierPart as AgeTier),
  };
}

/** Which cells a membership type is priced by: one per tier, or one flat. */
export function cellsForRateType(
  type: RateGridType,
  tiers: readonly RateGridTier[],
): RateCell[] {
  return type.ageGroupsApply
    ? tiers.map((tier) => tier.tier)
    : [FLAT_RATE_CELL_KEY];
}

/**
 * Every cell this season could hold a rate for, all of them ABSENT.
 *
 * `null`, not `0` — see the module doc. The flat whole-lodge field has always
 * held absence as `null` for the same reason: never charge nothing for the
 * building.
 */
export function emptyRateCells(
  types: readonly RateGridType[],
  tiers: readonly RateGridTier[],
): RateCells {
  const cells: RateCells = {};
  for (const type of types) {
    for (const cell of cellsForRateType(type, tiers)) {
      cells[rateCellKey(type.id, cell)] = null;
    }
  }
  return cells;
}

/**
 * A season's stored rows read onto the grid, with every cell it has no row for
 * left absent.
 *
 * A row for a cell this grid has NO BOX for — a tier the club has since
 * retired, a membership type that no longer carries its own rates — still takes
 * a key, so it survives an edit and a copy untouched. Dropping it would read as
 * tidier and would in fact make saving the form delete stored rate rows the
 * officer was never shown and never asked about. Between silently keeping
 * configuration nobody can see and silently destroying it, keeping is the one
 * that is recoverable.
 */
export function rateCellsFromSeason(
  rows: readonly SeasonRateRow[],
  types: readonly RateGridType[],
  tiers: readonly RateGridTier[],
): RateCells {
  const cells = emptyRateCells(types, tiers);
  for (const row of rows) {
    const key = rateCellKey(
      row.membershipTypeId,
      row.ageTier ?? FLAT_RATE_CELL_KEY,
    );
    cells[key] = row.pricePerNightCents;
  }
  return cells;
}

/**
 * The rows a save sends for a grid.
 *
 * A cell with NO rate is not sent. `membershipTypeRates` is a replace-all
 * payload, so an unsent cell is a cell with no row — which is exactly the state
 * the missing-rates panel warns about, and the state the pricing engine refuses
 * on rather than guesses at. Sending a zero for it would silence the warning by
 * charging those guests nothing.
 *
 * A cell holding `0` IS sent: a rate somebody typed as 0.00 is real
 * configuration, and the club that means it keeps it.
 */
export function rateRowsFromCells(cells: RateCells): SeasonRateRow[] {
  return Object.entries(cells)
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .map(([key, pricePerNightCents]) => ({
      ...parseRateCellKey(key),
      pricePerNightCents,
    }));
}

/**
 * The text an amount box shows: what was typed, else the stored cents.
 *
 * `null` cents means the cell HAS NO RATE and the box is empty; a stored `0`
 * means somebody set this rate to $0.00 and the box says `0.00`. Those used to
 * be the same empty box (`cents ? … : ""`), which is what made "never had a
 * row" indistinguishable from "typed zero" — and an indistinguishable pair is
 * why the form could not tell which cells it was safe to leave out of a save
 * (#2933 review).
 *
 * The cents are rendered by `formatCentsPlain` — a bare two-decimal string with
 * no symbol and no grouping, which is what an editable amount box needs and
 * what its one home exists for (`INV-SSOT-001`, #3264/#3302). This used to
 * spell `(cents / 100).toFixed(2)` by hand, which survived inside the form only
 * because that file carries a lint exemption.
 */
export function amountFieldValue(
  draft: string | undefined,
  cents: number | null | undefined,
): string {
  if (draft !== undefined) return draft;
  return cents == null ? "" : formatCentsPlain(cents);
}

/**
 * What a guest of `tier` is actually charged for this type on this season, and
 * whether the amount came from the type's flat all-ages row.
 *
 * The engine prefers an exact tier row and falls back to the flat row
 * (`INV-MOD-007`), and the rates table used to read the exact row alone — so a
 * type priced entirely by one flat rate was shown as "Not set" on every tier,
 * which is the same misreading as a missing rate nobody is warned about,
 * pointing the other way (#2933).
 */
export function resolvedTierRate(
  rows: readonly SeasonRateRow[],
  membershipTypeId: string,
  tier: AgeTier,
): { pricePerNightCents: number; fromFlatRate: boolean } | null {
  const exact = rows.find(
    (row) => row.membershipTypeId === membershipTypeId && row.ageTier === tier,
  );
  if (exact) {
    return { pricePerNightCents: exact.pricePerNightCents, fromFlatRate: false };
  }
  const flat = rows.find(
    (row) => row.membershipTypeId === membershipTypeId && row.ageTier === null,
  );
  return flat
    ? { pricePerNightCents: flat.pricePerNightCents, fromFlatRate: true }
    : null;
}

/** The season a copy reads from — configuration only, and read-only. */
export interface SeasonConfigurationSource {
  type: "WINTER" | "SUMMER";
  active: boolean;
  flatWholeLodgeNightCents: number | null;
  membershipTypeRates: readonly SeasonRateRow[];
}

/**
 * One season's configuration, ready to seed a NEW season's form.
 *
 * Deliberately carries no `id`, no `name` and no dates. That is what makes
 * "copy the configuration, never the identity" a fact about the type rather
 * than a rule somebody has to remember: there is no field for the officer's new
 * season to accidentally inherit the source's name, window, or database id
 * through, and no `editingId` for the form to PUT back over the source with.
 */
export interface SeasonConfigurationCopy {
  type: "WINTER" | "SUMMER";
  active: boolean;
  flatWholeLodgeNightCents: number | null;
  rateCells: RateCells;
}

/**
 * Copy a season's configuration exactly, for a new season the officer still has
 * to name and date.
 *
 * Every amount crosses as the integer cents the source holds — no division, no
 * formatting, no parse back (`INV-MONEY-001`). Absence crosses as absence: a
 * cell the source has no row for arrives `null`, so the new season starts with
 * the same hole and the same warning rather than with a manufactured $0.00 row
 * (see the module doc).
 *
 * The source is read and never written: `rateCellsFromSeason` builds a fresh
 * record and copies each amount out by value.
 */
export function copySeasonConfiguration(
  source: SeasonConfigurationSource,
  types: readonly RateGridType[],
  tiers: readonly RateGridTier[],
): SeasonConfigurationCopy {
  return {
    type: source.type,
    active: source.active,
    flatWholeLodgeNightCents: source.flatWholeLodgeNightCents,
    rateCells: rateCellsFromSeason(source.membershipTypeRates, types, tiers),
  };
}
