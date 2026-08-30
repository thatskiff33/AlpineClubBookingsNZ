import {
  getExplicitGuestBedNightKeys,
} from "@/lib/booking-guest-stay-ranges";
import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";

/**
 * #3166 (epic #2797): WHAT MAY BE WRITTEN INTO `BookingGuestNight.priceCents`.
 *
 * The write-side twin of `stored-sold-price-evidence.ts`, which answers the
 * READ-side question — can this strand's stored history price an edit exactly?
 * This file answers the three that follow from it, and every one of them exists
 * because a second copy of it caused a defect:
 *
 *  - `preservedNightPrices` — the per-night vector a parked edit writes, in
 *    which every night the booking can still account for keeps its stored
 *    integer byte for byte and every other night is `null`;
 *  - `carriesUnvaluedStoredNight` — the predicate a WHOLESALE night-row
 *    rewriter asks before it overwrites a blank, because `INV-MOD-028` says a
 *    blank is cleared only by a person supplying the amount;
 *  - `classifyNightPriceToWrite` — the three-way amount / not-known / unstated
 *    rule, which two writers narrow and neither restates.
 *
 * Nothing here consults a rate table, and nothing here computes an amount. Every
 * number that can leave this file was already in the database.
 */
/**
 * The per-night vector a PARKED pre-check-in edit writes for one existing
 * strand (#3166).
 *
 * A night whose stored row carried usable money keeps that integer BYTE FOR
 * BYTE; every other night — one whose row could not be read, and one this edit
 * newly puts the strand on while its stored total is frozen — is `null`, which
 * `syncGuestNights` writes as `NULL`: not known. There is deliberately no
 * arithmetic here and no rate table in sight, so the only numbers that can
 * reach the column are ones already in it.
 *
 * The night key is derived through the SAME canonical helper the sold-price map
 * was keyed with. A key spelled even slightly differently would match nothing,
 * every night would come back `null`, and a parked edit would silently blank
 * price history it could have preserved — the failure would be invisible
 * (INV-DATE-020).
 */
export function preservedNightPrices(
  soldNightPrices: ReadonlyMap<CalendarDate, number> | undefined,
  nightDates: readonly Date[],
): (number | null)[] {
  return nightDates.map((night) => {
    const [key] = getExplicitGuestBedNightKeys({ nights: [night] }) ?? [];
    const cents = key === undefined ? undefined : soldNightPrices?.get(
      requireCalendarDate(key),
    );
    return cents === undefined ? null : cents;
  });
}

/**
 * Does this booking carry a night whose sold price is NOT KNOWN? (#3166,
 * `INV-MOD-028`.)
 *
 * A `NULL` in `BookingGuestNight.priceCents` is the column's own statement that
 * nobody knows what the night was sold for (#3170), and the rule it comes with
 * is absolute: **a blank is cleared only by a person supplying the amount, never
 * by a reprice.** A writer that re-prices a whole stay and rewrites every night
 * row would otherwise convert "not known" into a figure nobody decided, and the
 * next edit reads that column back as evidence of what the member paid.
 *
 * This is the predicate a wholesale night-row rewriter asks BEFORE it rewrites,
 * and it lives here rather than in each of them so that "what a blank is" has
 * one definition (`INV-SSOT`).
 *
 * ## Exactly a `NULL`, and deliberately not the wider class
 *
 * `storedSoldPriceEvidenceForGuest` treats a negative or non-integer row as an
 * ABSENCE of usable evidence too, and this does not. Those are damage from
 * pre-#2744 arithmetic, what to do about them is #2745's audited decision, and
 * this repository's standing answer is forward-only: nothing here repairs one
 * and nothing here refuses on account of one. A `NULL` is different in kind — it
 * was written deliberately, by a parked edit, to say that an amount is owed and
 * unknown.
 *
 * A row loaded WITHOUT its price is indistinguishable from a null one here, so
 * callers must load `priceCents`; every current caller loads whole night rows.
 */
export function carriesUnvaluedStoredNight(
  guests: ReadonlyArray<{
    nights?: ReadonlyArray<{ priceCents?: number | null }> | null;
  }>,
): boolean {
  return guests.some((guest) =>
    (guest.nights ?? []).some(
      (night) => night.priceCents === null || night.priceCents === undefined,
    ),
  );
}

/**
 * What a per-night vector position MEANS at the moment a night row is written —
 * the one statement of the three-way rule (#3031, #3170, #3166, `INV-SSOT`).
 *
 * Two writers ask it: `nightPriceCentsToWrite` in `booking-modify-plan.ts` (used
 * by `syncGuestNights`) and the `createMany` inside
 * `applyBookingDateModification`. Before this they each spelled the rule out,
 * and the second copy arrived with #3166 — so the decision that decides whether
 * a night's price is a number, a recorded blank, or a refusal had two homes
 * within one release of having one.
 *
 * The three answers, and why the last two are not the same absence:
 *
 *  - **a number** — the amount this night is being sold at, written as-is. There
 *    is no `?? 0` here and there never may be: a zero is a real financial number
 *    (a comped night), and writing one for a night nobody priced is the
 *    magic-zero defect under another name.
 *  - **`not-known`** — an explicit `null`, which is a DECISION. Only a parked
 *    composer produces one: the strand's stored total is frozen and this night's
 *    price genuinely is not known, so `NULL` is written and `INV-MOD-028`'s
 *    blank clause takes over. `buildIdentityOnlyPricing` also echoes stored
 *    blanks back byte for byte on a name-only correction — it creates no new
 *    blank, it declines to repair one.
 *  - **`unstated`** — `undefined`, because the vector is SHORTER than the night
 *    list or has a hole. Nobody decided anything; the breakdown is malformed,
 *    which is a wiring defect in whoever built it. It must REFUSE.
 *
 * Letting `unstated` fall through to `NULL` would turn every wiring defect into
 * an unpriced night, which is exactly the silent damage epic #2797 exists to
 * remove — so the unknown has to be SAID, never inferred from an absence.
 *
 * WHAT THIS DOES NOT DO IS THROW, and that is deliberate. The two call sites
 * owe their operators different failures: the modify plan raises an internal
 * `Error`, and the date path raises an `ApiError(400)` whose sentence
 * ("The new dates could not be priced night by night") is member-visible and
 * pinned by `phase8b-booking-mods.test.ts`. Those are a legitimate second
 * derivation; the DECISION they narrow is not, and it lives here.
 */
export type NightPriceToWrite =
  | { kind: "amount"; priceCents: number }
  | { kind: "not-known" }
  | { kind: "unstated" };

export function classifyNightPriceToWrite(
  cents: number | null | undefined,
): NightPriceToWrite {
  if (cents === null) return { kind: "not-known" };
  if (typeof cents !== "number") return { kind: "unstated" };
  return { kind: "amount", priceCents: cents };
}