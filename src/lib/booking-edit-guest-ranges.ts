import type { AgeTier } from "@prisma/client";
import {
  calculateBookingPrice,
  type GroupDiscountConfig,
  type RateSource,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  addDaysDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import {
  calendarDateOfDateOnlyInstant,
  requireStoredCalendarDay,
  type CalendarDate,
} from "@/lib/club-time";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import {
  expandStayEnvelopeToNightKeys,
  getExplicitGuestBedNightKeys,
  type GuestNightInput,
} from "@/lib/booking-guest-stay-ranges";
import type { MemberGuestConsentGuestFields } from "@/lib/member-guest-add-policy";

interface ExistingBookingEditGuest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  // Resolved rate membership type (#1930, E4); replaces the old
  // forceNonMemberRate boolean. `rateSource` decides whether a qualifying group
  // discount may substitute a rate for this guest — only a NON_MEMBER_DEFAULT
  // guest's is substituted (INV-MOD-007) — so since #2756 it is load-bearing
  // here rather than carried for shape parity.
  rateMembershipTypeId: string;
  rateSource?: RateSource;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // The guest's CANONICAL night set — their `BookingGuestNight` rows (#2736),
  // each carrying what that night was SOLD for (#2744).
  //
  // `stayStart`/`stayEnd` above is the DERIVED half-open envelope whose
  // `stayEnd` is the morning after the last night (INV-DATE-012), and for a
  // SPARSE stay the envelope silently fills the internal gaps. This plan used
  // to carry no night list at all, so an edit to a booking already under way
  // priced, persisted and reserved a bed for every gap night the guest is not
  // there for (INV-MOD-025). Every caller already loads these rows —
  // `LoadedBookingForModify` includes them — so before #2736 they were present
  // at runtime and invisible to the type system, which is exactly how the plan
  // came to be the one edit path that flattens a sparse stay.
  //
  // `priceCents` was the same story a second time (#2744). The loaded rows carry
  // it — `LoadedBookingForModify` types it, and `lockedNightPricesForGuest`
  // reads exactly this column on every other edit path — but this plan's type
  // stopped at `GuestNightInput`, so the one thing that says what the member
  // actually paid for a night was invisible here and every night was valued at
  // today's rate instead.
  nights?: ReadonlyArray<StoredGuestNight> | null;
  priceCents: number;
}

/**
 * One loaded `BookingGuestNight` row as this plan reads it: the night, and what
 * the member was charged for it (#2744).
 *
 * `GuestNightInput` (a bare `Date`, a `yyyy-MM-dd` string, or `{ stayDate }`) is
 * what the canonical stay-range helpers accept and is kept in the union so a
 * caller holding any of those shapes still type-checks. The extra member is
 * assignable to `{ stayDate }`, so the night set still flows into
 * `getExplicitGuestBedNightKeys` unchanged; the price is simply no longer
 * dropped on the floor on the way in.
 */
type StoredGuestNight =
  | GuestNightInput
  | { stayDate: Date | string; priceCents?: number | null };

// Extends MemberGuestConsentGuestFields ("+ Add Member Guest", epic #2305, MG2
// #2307) so a cross-family guest added to an IN-PROGRESS stay carries its consent
// columns and its D-8 marker through this plan to the row writer. Without the
// declaration the fields would still be present at runtime and invisible to the
// type system, which is how an in-progress add would quietly become the one path
// that writes a consent-free cross-family guest row. Type-only import: nothing is
// pulled into this module at runtime.
// Deliberately declares NO stay range and NO night set. A guest added to a stay
// already under way is admitted for the booking's remaining future nights,
// `[editableFrom, newCheckOut)`, and this plan overrides whatever per-guest
// range or `nights` the request carried — which callers DO pass at runtime, from
// the shared stay-range resolver. That is unchanged by #2736 and is why the
// added-guest window is contiguous by construction: honouring a narrower or
// sparser requested set here would move the price of edits that have nothing to
// do with a gap. Leaving the fields undeclared keeps the override deliberate
// rather than accidental; see INV-MOD-025.
interface AddedBookingEditGuest extends MemberGuestConsentGuestFields {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  rateMembershipTypeId: string;
  rateSource?: RateSource;
}

interface ProposedExistingGuestRange {
  guest: ExistingBookingEditGuest;
  stayStart: Date;
  stayEnd: Date;
  // #2736: the nights this guest actually holds after the edit, sorted — the
  // guest's own canonical nights that survive the edit, plus the genuinely-new
  // nights a check-out extension adds after their last one AND after the
  // booking's old check-out (#2743). This, NOT `[stayStart, stayEnd)`, is what
  // gets priced, quoted per night and written back as `BookingGuestNight` rows,
  // so an internal gap stays a gap (INV-MOD-025). For a contiguous guest who
  // holds the booking's last night it IS `[stayStart, stayEnd)`, night for
  // night, which is what makes the change a no-op for every ordinary stay.
  nights: Date[];
  // #2744: what each of `nights` is worth, in the same order and in integer
  // cents, summing EXACTLY to `priceCents`. This is what gets written to
  // `BookingGuestNight.priceCents`, and therefore what the NEXT edit is told the
  // member paid — so it is each night's real rate (the price it was sold at for
  // a night the guest already held, the current season rate for a night this
  // edit newly buys), not the guest's total divided by their night count. See
  // `composeProposedNightPrices` for the one case that still has to average.
  perNightCents: number[];
  // The subset of `nights` from `futureStart` onwards — the nights this edit
  // actually prices and capacity-checks. Empty means the guest holds no future
  // night at all, which is how a sparse guest whose remaining nights are all
  // behind the edit window stops counting as future-active.
  futureNights: Date[];
  priceCents: number;
  oldFuturePriceCents: number;
  newFuturePriceCents: number;
  futureDeltaCents: number;
  removedFromFuture: boolean;
  // #2029: the earliest night this edit newly prices/occupies for the guest —
  // `maxDate(stayStart, minDate(editableFrom, originalStayEnd))`. Equals
  // editableFrom for the mid-stay/last-night cases, but drops back to the
  // guest's own (original) stay end for a check-out-day extension so the
  // genuinely-new [stayEnd, editableFrom) night is both charged and
  // capacity-checked. Both the pricing delta and the capacity range key off it.
  futureStart: Date;
}

interface ProposedAddedGuestRange {
  guest: AddedBookingEditGuest;
  stayStart: Date;
  stayEnd: Date;
  // #2736: the nights the added guest holds. A guest added to a stay already
  // under way is admitted for the booking's remaining future nights and nothing
  // else — this plan deliberately overrides whatever per-guest range or night
  // set the request carried (see `proposedAddedGuests` below) — so this window
  // is CONTIGUOUS BY CONSTRUCTION and equals `[stayStart, stayEnd)` exactly.
  // It is materialised anyway so the write path, the capacity check and the
  // per-night quote all read one night list whichever kind of guest they hold.
  nights: Date[];
  // #2744: what each of `nights` costs, in order, summing exactly to
  // `priceCents`. Every night here is newly bought, so each is its own current
  // season rate straight from `calculateBookingPrice` — a guest added across a
  // season boundary now stores 50/50/90/90 rather than four averaged 70s.
  perNightCents: number[];
  priceCents: number;
}

export interface BookingEditGuestRangePlan {
  proposedExistingGuests: ProposedExistingGuestRange[];
  proposedAddedGuests: ProposedAddedGuestRange[];
  remainingGuests: ExistingBookingEditGuest[];
  removedGuests: ExistingBookingEditGuest[];
  newTotalPriceCents: number;
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  newFinalPriceCents: number;
  priceDiffCents: number;
  futureExistingDeltaCents: number;
  futureActiveGuestCount: number;
  capacityGuestRanges: Array<{
    stayStart: Date;
    stayEnd: Date;
    // #2736: the exact nights this range occupies a bed on. `countActiveGuestsForNight`
    // reads an explicit night set in preference to the envelope, so a sparse
    // guest no longer claims a bed on a gap night they are not in the lodge for.
    // Identical to expanding `[stayStart, stayEnd)` for every contiguous guest
    // and for every added guest.
    nights: Date[];
    // Carried so the partner-shared admission check (#1746) can tell a
    // flagged sharer's range from the ordinary ones; null for non-members.
    memberId?: string | null;
  }>;
  // #2029: the earliest night the capacity check must cover for this edit —
  // never later than editableFrom. The capacity call sites use this (not
  // editableFrom) as the window start so a check-out-day extension's new night
  // is inside the checked window; for mid-stay/last-night edits it equals
  // editableFrom (unchanged). #2743: it is the earliest night any included range
  // actually OCCUPIES, not the minimum `futureStart` — see the derivation below.
  capacityRangeStart: Date;
}

export interface BuildInProgressGuestRangePlanInput {
  booking: {
    checkIn: Date;
    checkOut: Date;
    totalPriceCents: number;
    discountCents: number;
    promoAdjustmentCents: number;
    finalPriceCents: number;
    guests: ExistingBookingEditGuest[];
  };
  editableFrom: Date;
  newCheckOut: Date;
  addGuests?: AddedBookingEditGuest[];
  removeGuestIds?: string[];
  seasons: SeasonRateData[];
  // #2756: the club's default group-discount config, or absent when the club has
  // not switched one on — in which case every number this plan produces is what
  // it produced before, because `isGroupDiscountApplicable` returns false with no
  // config and no rate can be substituted. Every other edit path already passes
  // it (INV-MOD-006); this plan was the sole exception, so nights an in-progress
  // edit newly bought were charged undiscounted while the same nights bought a
  // day earlier were not. Callers pass the value the EDIT-time mapper resolves
  // (`toEditTimeGroupDiscountConfig`, #2770/INV-MOD-026) — the same one they
  // hand their ordinary pricing pass, so the two branches cannot disagree — and
  // it is absent when the club has switched the discount off for later edits.
  //
  // It reaches the POST-EDIT pass only — the nights this edit buys. The pre-edit
  // window, which values a night the edit takes away, is deliberately priced
  // without it; the reasoning is at that pass.
  //
  // A qualifying night SUBSTITUTES `rateMembershipTypeId`'s rate rows for a
  // NON_MEMBER_DEFAULT guest (INV-MOD-007), so two consequences that hold on every
  // other pricing path now hold here too, and neither is new behaviour anywhere
  // else: a substituted type whose rows are DEARER than NON_MEMBER's charges more,
  // and a substituted type with no row for some age tier in some season throws
  // where the guest's own type would have resolved. The admin group-discount route
  // validates neither. Members are unaffected either way (OWN_TYPE and
  // TYPE_POLICY_FORCED are never substituted).
  groupDiscount?: GroupDiscountConfig;
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}

/**
 * The lodge-night key of a stored calendar day - the scheme every night set uses.
 *
 * DECODES, DOES NOT PROJECT (#3107, INV-DATE-013). The keys this is compared
 * against come from `getExplicitGuestBedNightKeys`, whose `BookingGuestNight`
 * rows were never projected, so behind Greenwich a night's price never matched
 * the night it was the price OF and that night silently repriced at today's rate
 * - the failure `storedNightPricesByKey` below warns about under INV-DATE-020.
 *
 * A second copy of `booking-guest-stay-ranges.ts`'s own derivation, kept only
 * because that one is module-private behind bodies its contract test freezes
 * byte-for-byte. The two key the same night sets and must move together.
 */
function dateOnlyKey(value: Date): CalendarDate {
  return calendarDateOfDateOnlyInstant(
    requireStoredCalendarDay(value, {
      subject: "A lodge-night key",
      instead:
        "Pass the stored calendar day the night is, or resolve a real timestamp's club " +
        "day with clubCalendarDateOf first and pass that.",
    })
  );
}

/**
 * What the guest was CHARGED for each night they already hold, by NZ date-only
 * key (#2744) — read straight off their loaded `BookingGuestNight` rows, which
 * is the same column `lockedNightPricesForGuest` hands every other edit path.
 *
 * A night with no row, or a row loaded without its price, is simply absent: that
 * night has no recoverable sold price and prices at the current season rate,
 * which is exactly what INV-MOD-005 already says happens to a legacy guest
 * carrying no night rows. Absence is therefore a documented, pre-existing
 * degradation rather than a new silent fallback — but it IS a degradation, and
 * for a booking that predates `BookingGuestNight` it means the old behaviour:
 * the night is credited back at today's rate. The `refundCeilingCents` clamp
 * below is what stops that degradation handing back more than the member paid.
 *
 * A NEGATIVE stored price is treated the same way — as no recoverable price at
 * all — and that is a deliberate refusal, not tidiness. `BookingGuestNight.
 * priceCents` is a bare `Int` with no non-negative constraint, and the very
 * arithmetic this change replaces could write negative rows: the old even split
 * of a guest whose total had been driven below zero by a today's-rate refund
 * spread that negative total across their nights. Trusting such a row as a
 * "sold price" would invert the whole edit — the old-price window would come out
 * negative, so GIVING A NIGHT BACK would CHARGE the member — on a booking the
 * pre-fix bug had already damaged. Skipping it drops that night into the
 * documented "nothing to recover" degradation instead, where the clamp holds it.
 * Nothing already stored is rewritten: what those rows should become is a
 * separate, audited decision on #2745.
 */
function storedNightPricesByKey(
  guest: Pick<ExistingBookingEditGuest, "nights">
): Map<string, number> {
  const byKey = new Map<string, number>();
  for (const entry of guest.nights ?? []) {
    if (entry instanceof Date || typeof entry === "string") {
      continue;
    }
    const priceCents = "priceCents" in entry ? entry.priceCents : undefined;
    if (
      typeof priceCents !== "number" ||
      !Number.isFinite(priceCents) ||
      priceCents < 0
    ) {
      continue;
    }
    // Keyed through the SAME canonical helper that builds `heldNightKeys`, one
    // entry at a time, rather than by re-deriving the key here. A price keyed
    // even slightly differently from its night would never match it, and the
    // failure would be silent — the night would just quietly price at today's
    // rate again, which is the whole defect (INV-DATE-020).
    const [key] = getExplicitGuestBedNightKeys({ nights: [entry] }) ?? [];
    if (key !== undefined) {
      byKey.set(key, priceCents);
    }
  }
  return byKey;
}

/** One guest, the nights to price for them, and what they already paid. */
interface PartyPricingParticipant {
  guest: Pick<
    ExistingBookingEditGuest,
    "ageTier" | "isMember" | "rateMembershipTypeId" | "rateSource"
  >;
  nightKeys: readonly string[];
  // Absent for an ADDED guest, who has bought nothing yet and whose every night
  // is therefore a fresh season lookup.
  lockedNightPricesByKey?: ReadonlyMap<string, number>;
}

/**
 * Price EXACTLY these nights, for EVERY guest in the party, in ONE pass — and
 * say what each night costs each of them, by night key.
 *
 * **One pass, because the group discount is a property of the party and not of a
 * guest (#2756).** This used to be one `calculateBookingPrice` call per guest,
 * with no group-discount config, so `countActiveGuestsForNight` was always
 * looking at a one-element list and the party size the discount rule saw was
 * always 1. Two things followed and the second was the defect: no config was
 * passed at all, so `isGroupDiscountApplicable` refused immediately, and even
 * with one it could never have qualified. Nights an in-progress edit newly BOUGHT
 * were therefore charged undiscounted while the same nights bought before the
 * stay began were not — a member adding a sixth person to a party of eight paid
 * one price if the stay started tomorrow and another if it started yesterday
 * (INV-MOD-006). Handing the whole party to one call is what the guest-add route
 * already does for the same reason, and the per-guest slices of the combined
 * breakdown are read straight back out of it here.
 *
 * #2736 replaced the older `priceGuestRangeCents(start, end, …)`, which handed
 * `calculateBookingPrice` a bare `[start, end)` envelope and let it expand the
 * range itself. Passing the night list instead takes the *same* per-night code
 * path — `calculateBookingPrice` prefers a guest's explicit `nights` over the
 * envelope (issue #713) and looks the season rate up once per night — so
 * seasonal, age-tier and member/non-member differentiation still apply night by
 * night and nothing is ever a rate multiplied by a night count. For a
 * contiguous night list the two forms price the identical set of nights in the
 * identical order, which is why every ordinary stay is unchanged to the cent.
 *
 * Integer cents throughout: every term is either a stored `priceCents` or a
 * `pricePerNightCents` integer, summed by `calculateBookingPrice`
 * (INV-MONEY-001, INV-MONEY-003). No float, no parse, no rounding.
 *
 * #2744: `lockedNightPrices` is passed, which is what brings this plan into
 * line with INV-MOD-005 — "a night a guest already bought keeps the price stored
 * on its `BookingGuestNight` row … removing one returns exactly theirs". Every
 * other edit path already did this; the in-progress plan was the sole exception,
 * so a night given back after a rate rise was credited at TODAY's rate and the
 * club refunded more than it had ever charged. A locked night short-circuits the
 * season lookup, so it also short-circuits the group discount: a night the guest
 * already bought keeps its booked, discount-inclusive price and is never
 * re-rated because the party grew or shrank (INV-MOD-005, INV-MOD-006).
 *
 * The `[checkIn, checkOut)` range is the envelope of every night handed in, and
 * it is inert: every participant carries an explicit night list, so it is never
 * expanded into anybody's nights and `isGuestActiveOnNight` ignores it for a
 * guest with a night set (INV-DATE-005). A participant with NO nights is left
 * out of the call entirely and gets an empty map — passing an empty `nights`
 * array would make `calculateBookingPrice` fall back to that envelope and price
 * them for the whole range, and it would add them to the party count on every
 * night of it.
 *
 * The returned map is keyed by night rather than positional, because the callers
 * sum different subsets of it (a guest's old window, their future window) and a
 * positional slice would have to be re-derived for each. Alignment inside the
 * pass is still structural: `calculateBookingPrice` returns `nightDates`
 * alongside `perNightCents`, so each amount is attached to the night the engine
 * actually priced rather than to the night this function hoped it priced. It
 * matters because these amounts are written per night — a misalignment would put
 * one night's price on another night's row — so the contiguous matrix in
 * `booking-edit-guest-ranges-sparse.test.ts` re-asserts length and sum on every
 * one of its cases against the real pricing function.
 */
function pricePartyNights(
  participants: readonly PartyPricingParticipant[],
  seasons: SeasonRateData[],
  groupDiscount?: GroupDiscountConfig
): Array<Map<string, number>> {
  const pricedByParticipant = participants.map(() => new Map<string, number>());
  const occupied = participants
    .map((participant, index) => ({ participant, index }))
    .filter(({ participant }) => participant.nightKeys.length > 0);
  if (occupied.length === 0) {
    return pricedByParticipant;
  }

  const allNightKeys = occupied
    .flatMap(({ participant }) => [...participant.nightKeys])
    .sort();
  const firstNight = parseDateOnly(allNightKeys[0]);
  const lastNight = parseDateOnly(allNightKeys[allNightKeys.length - 1]);

  const breakdown = calculateBookingPrice(
    firstNight,
    addDaysDateOnly(lastNight, 1),
    occupied.map(({ participant }) => ({
      ageTier: participant.guest.ageTier,
      isMember: participant.guest.isMember,
      rateMembershipTypeId: participant.guest.rateMembershipTypeId,
      rateSource: participant.guest.rateSource,
      nights: participant.nightKeys.map((key) => parseDateOnly(key)),
      // Keyed by night, so an entry for a night outside this pass simply never
      // matches; `calculateBookingPrice` looks a lock up per priced night.
      lockedNightPrices: [...(participant.lockedNightPricesByKey ?? [])].map(
        ([stayDate, priceCents]) => ({ stayDate, priceCents })
      ),
    })),
    seasons,
    groupDiscount
  );

  occupied.forEach(({ index }, position) => {
    const guestBreakdown = breakdown.guests[position];
    const priced = pricedByParticipant[index];
    guestBreakdown.nightDates.forEach((night, nightIndex) => {
      priced.set(dateOnlyKey(night), guestBreakdown.perNightCents[nightIndex]);
    });
  });
  return pricedByParticipant;
}

/**
 * What this pass charged one guest for one night.
 *
 * A night the pass did not price is a wiring defect, not a free night, so it
 * throws rather than defaulting to zero: every caller below asks only for nights
 * it put into the pass, and a silent zero would hand a night out for nothing —
 * or, on the old-price window, credit one back at nothing. The message is a log
 * line; both routes replace it before an operator sees it (#1888).
 */
function nightPriceFrom(
  priced: ReadonlyMap<string, number>,
  nightKey: string
): number {
  const cents = priced.get(nightKey);
  if (cents === undefined) {
    throw new Error(
      `Priced night ${nightKey} missing from the party pricing pass (INV-MOD-025)`
    );
  }
  return cents;
}

/** The same, for each of `nightKeys`, in that order. */
function nightPricesFrom(
  priced: ReadonlyMap<string, number>,
  nightKeys: readonly string[]
): number[] {
  return nightKeys.map((key) => nightPriceFrom(priced, key));
}

/** Sum integer cents. No float, no rounding (INV-MONEY-001). */
function sumCents(values: readonly number[]): number {
  return values.reduce((sum, cents) => sum + cents, 0);
}

/**
 * Which of one guest's proposed nights go into the POST-EDIT pass (#2756).
 *
 * Two kinds of night, and only the first is ever read back out:
 *
 *  - **PRICED** — from the guest's own first future night on. These are the nights
 *    this edit reprices for them, and every amount either window sums comes from
 *    here: the new-price leg sums `futureNightKeys`, and the old-price leg's KEPT
 *    nights are a subset of them, because `oldFutureStart` is never earlier than
 *    `newFutureStart`.
 *  - **COUNT-ONLY** — their own earlier nights that ANOTHER guest's window reaches
 *    back over, i.e. at or after the party-wide `pricingFloorKey` but before their
 *    own first priced night. Nobody reads their prices. They are in the pass so
 *    that `countActiveGuestsForNight` sees them on a night the edit really is
 *    buying, which needs a night before `editableFrom` to be priced at all —
 *    #2029's check-out-day extension — plus a second guest whose stored nights
 *    claim that same night, which takes drifted data (INV-DATE-012).
 *
 * **A count-only night is included only when its price is LOCKED**, and that is
 * the fix for the one direction the floor got wrong. `calculateBookingPrice` looks
 * a lock up before it looks a season rate up, so a locked night joins the party
 * count and can never fail. An UNLOCKED count-only night would instead demand a
 * season rate for a night nobody is repricing, and on a drifted booking whose past
 * night sits outside every active season — or whose tier/rate-type row has since
 * been removed — that turned an edit which previously succeeded into a thrown
 * "No rate found": a hard refusal, arriving as a 400 on the quote and, before the
 * guard added alongside this, an unmapped failure on the apply.
 *
 * Dropping such a night costs at most the party count on it, which is the
 * pre-#2756 answer for that night (every count was 1 then) and can only withhold
 * a discount, never invent one. Refusing the edit outright is worse than pricing
 * one rare drifted night as the old code priced it.
 */
function proposedPassNightKeys(
  entry: {
    proposedNightKeys: readonly string[];
    futureNightKeys: readonly string[];
    storedNightPriceByKey: ReadonlyMap<string, number>;
  },
  pricingFloorKey: string
): string[] {
  const firstPricedKey = entry.futureNightKeys[0];
  return entry.proposedNightKeys.filter((key) => {
    if (key < pricingFloorKey) return false;
    if (firstPricedKey !== undefined && key >= firstPricedKey) return true;
    return entry.storedNightPriceByKey.has(key);
  });
}

/**
 * Split `totalCents` evenly across `count` nights in integer cents, the
 * remainder spread one cent at a time over the earliest nights so the parts sum
 * back to the total EXACTLY — for a negative total too, where `Math.floor`
 * rounds away from zero and the remainder is added back cent by cent
 * (INV-MONEY-001, INV-MONEY-003).
 *
 * This is the fallback, not the rule: see `composeProposedNightPrices`.
 */
function distributeEvenlyCents(totalCents: number, count: number): number[] {
  if (count <= 0) {
    return [];
  }
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  const parts: number[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(base + (i < remainder ? 1 : 0));
  }
  return parts;
}

/**
 * What to write on each of a guest's proposed night rows (#2744).
 *
 * The rows this returns become `BookingGuestNight.priceCents`, which is the only
 * record of what a night was sold for and therefore what the NEXT edit is told
 * the member paid. They used to be the guest's total divided by their night
 * count, so an edit spanning a season boundary stored the average — four nights
 * of 50/50/90/90 written back as four 70s, and the next edit charging 70 for a
 * 50-cent night and 70 for a 90-cent one. Sums reconciled, so nothing went out
 * of balance; the snapshot simply was not the price list.
 *
 * Two parts, and the split between them is the edit window:
 *
 *  - FUTURE nights — the ones this edit prices — take the amounts
 *    `calculateBookingPrice` just produced: the locked price for a night the
 *    guest already held, the current season rate for a night newly bought.
 *  - PAST nights — the ones behind the window, which this edit does not touch —
 *    keep the prices already stored against them.
 *
 * The whole list must sum to `totalCents` (= the guest's stored total plus this
 * edit's delta), because that is the number written to `BookingGuest.priceCents`
 * and summed into the booking total; a per-night list that disagreed with it
 * would leave a phantom balance the moment Xero rebuilt its lines from the runs.
 * The one shape where it cannot is a guest left holding NO nights — removed
 * before their stay began — where there is nothing to distribute across. A
 * guest whose rows account for their total lands on exactly zero there, so the
 * empty list is the whole of it; a guest whose total has drifted from their rows
 * keeps the drift, which this rule neither invents nor erases (it is what the
 * pre-#2736 arithmetic left too, and #2745 owns what to do about it).
 *
 * The future part sums to its own total by construction, so the real rates can
 * be written only when the stored past prices account EXACTLY for the rest —
 * every past night has one, and together they come to `totalCents` less the
 * future part. That is the ordinary case, and it is what makes the rows honest.
 *
 * Anything else falls back to the even split this function replaced, over the
 * guest's whole night list — the behaviour every in-progress edit had before.
 * It covers a guest whose rows carry no prices at all (pre-#713, or a booking
 * converted from a request) and a guest whose stored total has drifted from
 * their rows: in both, the per-night record does not support the total, so
 * inventing a distribution from it would be a guess dressed as a rate. Falling
 * back rather than improvising also means a guest with no stored per-night
 * prices comes out of this function EXACTLY where they came out before — the
 * same amounts on the same nights — so the change reaches only guests whose real
 * rates are actually recoverable.
 */
function composeProposedNightPrices(args: {
  pastNightKeys: readonly string[];
  futureNightKeys: readonly string[];
  futurePerNightCents: readonly number[];
  storedNightPriceByKey: ReadonlyMap<string, number>;
  totalCents: number;
}): number[] {
  const futureTotalCents = args.futurePerNightCents.reduce(
    (sum, cents) => sum + cents,
    0
  );
  const pastTotalCents = args.totalCents - futureTotalCents;
  const storedPastCents = args.pastNightKeys.map((key) =>
    args.storedNightPriceByKey.get(key)
  );
  // `null` the moment one past night has no stored price — an unknown night
  // cannot be part of a total that adds up. An empty past list sums to 0, which
  // is the guest whose every proposed night is priced by this edit.
  const storedPastTotalCents = storedPastCents.reduce<number | null>(
    (sum, cents) => (sum === null || cents === undefined ? null : sum + cents),
    0
  );

  if (storedPastTotalCents === pastTotalCents) {
    return [...(storedPastCents as number[]), ...args.futurePerNightCents];
  }
  return distributeEvenlyCents(
    args.totalCents,
    args.pastNightKeys.length + args.futureNightKeys.length
  );
}

/**
 * The plan behind an edit to a booking that is already UNDER WAY: what each
 * guest ends up holding, what that costs, and what capacity must be checked.
 * Shared by the modify-quote preview and the modify-charge apply, so a quote and
 * a charge can never disagree.
 *
 * **Price the nights, never the envelope (INV-MOD-025).** A guest's nights are
 * `BookingGuestNight` rows; `stayStart`/`stayEnd` is a derived half-open
 * envelope (INV-DATE-012) that silently fills a sparse stay's internal gaps.
 * This plan used to carry only the envelope, so a guest booked on nights
 * {20, 22} was priced, quoted, given a bed and written back as if the 21st were
 * theirs — and because the charge is a delta against their stored price, a
 * mid-stay REMOVAL or a SHORTENED check-out subtracted those phantom nights and
 * refunded money the member had never paid (#2736).
 *
 * **Sell only the nights the edit creates (INV-MOD-025).** An edit adds a night
 * to a guest only when it moves the booking's check-out, and only past the OLD
 * check-out. This plan used to run each guest's added-nights leg from their own
 * last held night to the new check-out whether the check-out had moved or not,
 * so a #713 partial-stay guest whose stay had already finished was put back on
 * the booking for the rest of its nights and charged for them by an edit that
 * changed nothing else — adding one guest bought seven nights for another
 * (#2743). Not a NAME correction, which never reaches this plan at all: a
 * name-only request is identity-only on both routes and takes the
 * price-preserving echo (`buildIdentityOnlyPricing`) instead. The edits that DO
 * reach here and used to re-admit are adding a guest, removing a guest, moving
 * the check-out, and a promo or member-link change.
 *
 * For a contiguous stay that runs to the booking's own check-out — every
 * ordinary edit — every output here is identical to the pre-#2736 envelope
 * arithmetic, to the cent, to the night, to the capacity range and to the thrown
 * error. That equivalence is the property that makes the rule safe on live
 * bookings, and `booking-edit-guest-ranges-sparse.test.ts` proves it by
 * re-implementing the old maths and comparing, rather than asserting it. The
 * one deliberate exception is #2743's own shape, and the same suite measures it:
 * the bound never charges MORE than the old arithmetic did, and never lets
 * through an edit the old arithmetic refused.
 *
 * **Value a night at what it was sold for, not at today's rate (#2744).** The
 * guest's stored `BookingGuestNight.priceCents` is passed as `lockedNightPrices`
 * to both pricing legs, so a night given back is credited at the price the
 * member actually paid and a night they keep cancels between the two windows
 * exactly as before (INV-MOD-005). The per-night amounts written back are those
 * same real rates rather than the guest's total divided by their night count.
 * The equivalence above still holds, and is still proved rather than asserted:
 * a stay whose stored per-night prices equal the current season rates — every
 * booking where no rate has moved since it was made — comes out cent for cent
 * where it did, and so does a guest carrying no stored prices at all. What DOES
 * move, deliberately, is a refund on a stay whose rate has changed since: it is
 * now what the club charged rather than what it would charge today.
 *
 * **And a floor under it: no edit leaves a guest owing less than nothing.** The
 * locked prices cure the cause wherever a guest's rows record what they paid,
 * but a guest with no per-night record at all — a booking that predates
 * `BookingGuestNight`, or one created by approving a booking request, which
 * still writes no rows (#2739) — has nothing to recover, so their nights are
 * valued on the old leg at today's rate and after a rate rise the credit can
 * exceed everything the club ever charged them. `refundCeilingCents` caps the
 * credit at what the guest is actually carrying, so their price lands at worst
 * on zero and no negative amount is ever written to a night row for the next
 * edit to read back as a sold price. It cannot bind on a guest whose nights cost
 * no more than they paid, which is every healthy booking and every case in the
 * contiguous equivalence matrix. Guests ALREADY below zero from an edit made
 * before this change are left exactly as found — not driven deeper, not
 * repaired; that correction is an owner decision with its own audit, on #2745.
 */
export function buildInProgressGuestRangePlan(
  input: BuildInProgressGuestRangePlanInput
): BookingEditGuestRangePlan {
  const editableFrom = storedDateOnly(input.editableFrom);
  const bookingCheckIn = storedDateOnly(input.booking.checkIn);
  const bookingCheckOut = storedDateOnly(input.booking.checkOut);
  const newCheckOut = storedDateOnly(input.newCheckOut);
  const addGuests = input.addGuests ?? [];
  const removeSet = new Set(input.removeGuestIds ?? []);

  if (newCheckOut < editableFrom) {
    throw new Error("Check-out cannot move before NZ tomorrow");
  }

  if (addGuests.length > 0 && newCheckOut <= editableFrom) {
    throw new Error("Guests can only be added when the booking has future nights");
  }

  const remainingGuests = input.booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = input.booking.guests.filter((g) => removeSet.has(g.id));

  // A guest ADDED to a stay already under way is admitted for the booking's
  // remaining future nights and nothing else: this plan deliberately overrides
  // whatever per-guest range or night set the request carried, exactly as it
  // did before #2736. So this window is contiguous by construction and there is
  // no sparse input to preserve — but it is still materialised as a night list,
  // so the write path, the capacity check and the per-night quote read one shape
  // for both kinds of guest.
  const addedGuestNightKeys = expandStayEnvelopeToNightKeys(
    editableFrom,
    newCheckOut
  );

  // #2756: WHICH NIGHTS each guest ends up holding is decided for the whole
  // party first, because WHAT THEY COST cannot be decided one guest at a time
  // any more. The group discount is a property of the party on a night, so the
  // two pricing passes below are party-wide and this loop must therefore finish
  // before either of them runs.
  const existingNightPlans = input.booking.guests.map((guest) => {
    const stayStart = storedDateOnly(guest.stayStart ?? bookingCheckIn);
    const stayEnd = storedDateOnly(guest.stayEnd ?? bookingCheckOut);
    // #2736: the nights this guest actually holds today. The explicit
    // `BookingGuestNight` set wins; the half-open envelope is the fallback for a
    // guest carrying no night rows at all (a legacy row, or a booking converted
    // from a request — see #2739). That is `getGuestBedNightKeys`'s own rule,
    // taken through the canonical helpers rather than re-expanded here
    // (INV-DATE-020), and for a contiguous guest the two branches agree night
    // for night.
    const heldNightKeys =
      getExplicitGuestBedNightKeys(guest) ??
      expandStayEnvelopeToNightKeys(stayStart, stayEnd);
    const stayEndKey = dateOnlyKey(stayEnd);
    // #2744: what this guest was charged for each night they already hold. Every
    // night that has one is priced at it in BOTH windows below, so a night given
    // back is credited at the price it was sold for and a night kept still
    // cancels between the two (INV-MOD-005).
    const storedNightPriceByKey = storedNightPricesByKey(guest);

    const oldFutureStart = maxDate(stayStart, editableFrom);
    const oldFutureStartKey = dateOnlyKey(oldFutureStart);
    // The nights of the CURRENT stay this edit is about to reprice. Bounded by
    // the guest's own stay end exactly as the old `[oldFutureStart, stayEnd)`
    // range was, so a contiguous guest is unchanged; for a sparse one the gap
    // nights drop out, which is what stops a mid-stay removal or a shortened
    // check-out from refunding nights the guest never bought.
    const oldWindowNightKeys = heldNightKeys.filter(
      (key) => key >= oldFutureStartKey && key < stayEndKey
    );
    const removedFromFuture = removeSet.has(guest.id);
    const proposedStayEnd = removedFromFuture
      ? minDate(stayEnd, editableFrom)
      : newCheckOut;
    // #2029: the check-out-day extension the widened edit window opened adds
    // genuinely-new nights in [stayEnd, editableFrom) — a slice that sits INSIDE
    // the locked window (editableFrom = NZ tomorrow, but the guest's old stay
    // ended today). Anchoring the new-price window at editableFrom (as the
    // old-price window correctly does — nothing of the old stay is left to
    // reprice there) would drop that slice and hand those nights out free.
    // Start the new-price window at the guest's own stay end whenever it
    // precedes editableFrom. `maxDate(stayStart, …)` keeps a future-dated
    // partial-range guest (#713) from being charged before they arrive;
    // whenever editableFrom <= stayEnd this is byte-identical to the prior
    // `maxDate(stayStart, editableFrom)` (the mid-stay / last-night case).
    //
    // #2743 leaves this anchor exactly where it was and bounds the ADDED leg
    // instead (see `extensionStart` below). The anchor answers "from which night
    // does this edit reprice the guest", and reaching back is right for that —
    // what was wrong was letting the added leg SELL every night between a
    // departed guest's last one and the booking's own check-out.
    const newFutureStart = maxDate(stayStart, minDate(editableFrom, stayEnd));

    // #2736: the night set this edit proposes, in two parts.
    //
    //  1. KEPT — every night the guest already holds that survives the new
    //     check-out. Gaps survive as gaps: this is the whole fix. A shortened
    //     check-out drops the nights beyond it and nothing else.
    //  2. ADDED — the genuinely-new nights an extension buys, which run
    //     contiguously from the morning after the guest's last held night, and
    //     never earlier than the booking's own old check-out (#2743). They are
    //     new occupancy, so there is no pattern to preserve and expanding the
    //     envelope is the right answer for them.
    //
    // The two parts are disjoint by construction (part 1 is entirely before the
    // anchor part 2 starts at), and for a contiguous guest who holds the
    // booking's LAST night they compose to exactly `[stayStart, proposedStayEnd)`
    // — the range this used to expand — whether the edit extends, shortens, or
    // leaves the check-out alone. A guest who goes home before the booking does
    // is the shape #2743 changes: their held nights are kept, and only nights
    // past the old check-out can be added to them.
    const proposedEndKey = dateOnlyKey(proposedStayEnd);
    const keptNightKeys = heldNightKeys.filter((key) => key < proposedEndKey);
    // The morning after their last held night. Read off the night set rather
    // than off `stayEnd` so a guest whose stored envelope has drifted wider than
    // their rows still extends from where they really stop; identical to
    // `stayEnd` for every guest whose envelope agrees with their nights
    // (INV-DATE-012), and for the envelope-fallback guest by construction.
    const heldEndExclusive =
      heldNightKeys.length > 0
        ? addDaysDateOnly(
            parseDateOnly(heldNightKeys[heldNightKeys.length - 1]),
            1
          )
        : stayEnd;
    // #2743: an edit may only SELL nights the edit itself creates. The added leg
    // therefore starts no earlier than the booking's ORIGINAL check-out as well
    // as no earlier than the morning after the guest's last held night, so
    // `[bookingCheckOut, newCheckOut)` — the nights this edit adds to the
    // BOOKING — is the only ground it can ever cover. An edit that leaves the
    // check-out where it is cannot add a night to anybody.
    //
    // Without that bound the reach-back above did double duty: right when a
    // guest's stay ended one day behind the edit window (#2029's check-out-day
    // extension, where the check-out IS moving and the guest's stay end IS the
    // old check-out), wrong when it ended a week behind, because the leg then
    // ran from their last held night all the way to the new check-out whether or
    // not the check-out had moved. A #713 partial-stay guest who had gone home
    // was put back on the booking for every remaining night and charged for
    // them, on ANY edit that reaches this plan — adding one guest bought seven
    // nights for another. (A name-only edit never gets here: it is identity-only
    // on both routes and takes the price-preserving echo.)
    //
    // The real discriminator is NOT "has this guest gone home". It is whether
    // their held nights reach the BOOKING'S OWN check-out, because that is the
    // only thing `bookingCheckOut` can test. Stated boundary by boundary,
    // because getting one wrong either keeps that over-charge or evicts somebody
    // who is still in the lodge:
    //
    //  - RUNS TO THE CHECK-OUT — their last held night is the night before
    //    `bookingCheckOut`. Every ordinary stay. `heldEndExclusive` already
    //    equals `bookingCheckOut`, so the bound is a no-op by construction and
    //    nothing about them moves, extension included.
    //  - LEAVING TODAY — stay end equals the booking's check-out, one day behind
    //    editableFrom. #2029's case: the check-out IS moving, bookingCheckOut is
    //    behind the new nights, and the leg buys them from the same anchor and
    //    at the same price as before. Also a no-op, for the same reason.
    //  - STOPS SHORT OF THE CHECK-OUT — their last held night is before
    //    `bookingCheckOut`, whether they went home a week ago or are IN THE
    //    LODGE TONIGHT and leaving on the 23rd of a booking that runs to the
    //    27th. The nights between their last one and that check-out are the rest
    //    of somebody else's stay, were not created by this edit, and are no
    //    longer sold to them. So an extension gives a still-present early
    //    departer a GAP and a smaller bill too — this is not confined to a guest
    //    who has already departed, and INV-MOD-025 says so. Nights past the OLD
    //    check-out are still sold to all of them: an extension admits every
    //    remaining guest. Not because the request has no way to CARRY a
    //    per-guest end — `BatchModifyInput.guestStayRanges` exists — but because
    //    this plan deliberately overrides it for every existing guest, exactly
    //    as it does for an added one, and the edit panel does not offer the
    //    control on an in-progress edit (`gridMode`/`rangeMode` are both off).
    //    So there is no honoured way to say "this one is not coming back", and
    //    an API caller that sends one for an existing guest is ignored rather
    //    than refused. INV-MOD-025 states both plainly.
    //
    // One consequence is deliberate and recorded rather than guarded: because
    // nobody is back-filled any more, an edit can leave `Booking.checkOut`
    // claiming nights no remaining guest holds — remove the only whole-run guest
    // and the tail after the next-longest stay is uncovered. That is the honest
    // result of not selling nights the edit did not create, the containment
    // triggers permit it (they test containment, never coverage), and refusing
    // it would refuse the ordinary "remove the guest who was staying longest"
    // edit. The refusal below fires only when NO remaining guest holds a future
    // night at all. See INV-MOD-025.
    const extensionStart = maxDate(
      maxDate(newFutureStart, heldEndExclusive),
      bookingCheckOut
    );
    // The upper half of that intersection, `[…, newCheckOut)`, is already
    // implied: `proposedStayEnd` IS newCheckOut for a guest who stays on the
    // booking, and never later than editableFrom (hence never later than
    // newCheckOut, which was refused above if it preceded editableFrom) for a
    // guest being removed.
    const addedNightKeys = expandStayEnvelopeToNightKeys(
      extensionStart,
      proposedStayEnd
    );
    const proposedNightKeys = [
      ...new Set([...keptNightKeys, ...addedNightKeys]),
    ].sort();

    const newFutureStartKey = dateOnlyKey(newFutureStart);
    const futureNightKeys = proposedNightKeys.filter(
      (key) => key >= newFutureStartKey
    );

    return {
      guest,
      stayStart,
      proposedStayEnd,
      storedNightPriceByKey,
      oldWindowNightKeys,
      proposedNightKeys,
      // The same nights as a set, so the old-price window can ask "does this
      // guest KEEP this night?" per night without re-scanning the list.
      proposedNightKeySet: new Set(proposedNightKeys),
      futureNightKeys,
      newFutureStart,
      newFutureStartKey,
      removedFromFuture,
    };
  });

  // #2756: the earliest night this edit prices for ANYBODY — the first night of
  // the earliest future window, or the first night an added guest is admitted for.
  // `undefined` means nobody holds a future night at all, so there is nothing to
  // price (the refusal below usually follows).
  //
  // It bounds what the proposed pass covers, and the bound is load-bearing in both
  // directions. Too high and the party count would miss a guest who holds a priced
  // night as one of their OWN past nights, so a night the edit really is buying
  // could miss a discount the party had earned. That needs a night before
  // `editableFrom` to be priced at all, which is #2029's check-out-day extension
  // — a guest whose stay ended today buys tonight while the window opens tomorrow
  // — and a second guest whose stored nights claim that same night, which takes
  // drifted data, since the night the extension buys is the booking's own old
  // check-out and no undrifted guest holds it. Rare, then, but the floor makes the
  // count right there rather than resting on the drift being absent. Too low —
  // handing each guest their whole proposed night list, back to their check-in —
  // and this plan would start demanding a season rate for nights nobody is
  // repricing, so an edit to a stay whose past nights sit outside any active
  // season, or whose age-tier rate row has since been removed, would fail where it
  // used to succeed. A guest who went home a week ago makes that difference a week
  // wide.
  //
  // The floor alone is not enough for that second direction, which is why
  // `proposedPassNightKeys` also decides per guest: a night below a guest's OWN
  // first priced night is in the pass for the COUNT only, so it is carried only
  // when its price is locked and can never reach the season table. Without that,
  // the reach-back in #2029's shape could still demand a rate for a drifted
  // guest's past night and refuse an edit that used to work.
  //
  // Read off the night LISTS rather than off `newFutureStart`, which is a pricing
  // anchor that reaches back to a departed guest's own stay end and would drag the
  // floor back with it even though that guest buys nothing before the booking's
  // old check-out (#2743). Every night either leg sums is at or after this floor:
  // the new-price leg sums `futureNightKeys`, and the old-price leg's kept nights
  // are a subset of them (`oldFutureStart` is never earlier than
  // `newFutureStart`).
  const pricingFloorKey = existingNightPlans.reduce<string | undefined>(
    (earliest, entry) => {
      const firstPricedNight = entry.futureNightKeys[0];
      return firstPricedNight !== undefined &&
        (earliest === undefined || firstPricedNight < earliest)
        ? firstPricedNight
        : earliest;
    },
    addGuests.length > 0 ? addedGuestNightKeys[0] : undefined
  );

  // #2756: THE PRE-EDIT WINDOW, over the nights each guest currently holds inside
  // the edit window. It is read for one thing only — a night this edit takes AWAY,
  // which appears in no other pass — so it decides whether the club hands back
  // what it took. Each night is valued at the price it was SOLD for (#2744)
  // through the locked prices, falling back to the current season rate only for a
  // night with no stored price to recover.
  //
  // **NO GROUP DISCOUNT IS PASSED HERE, and that is a money decision rather than
  // an oversight.** #2756 reaches the nights an edit BUYS and nothing else, so
  // this leg is byte-identical to what it was before #2756, discount configured
  // or not. Passing the config would have valued a night with no recoverable
  // price under TODAY's party and TODAY's config, which can only ever SHRINK the
  // credit: a removal on a booking whose rows are missing credited $160 for
  // nights the club had charged $240 for, and `refundCeilingCents` below caps the
  // credit from above only, so there is no floor under that direction. The club
  // would have kept money it should have returned, on the credit leg, which is
  // the leg #2744 exists to keep honest.
  //
  // What survives is the pre-#2756 rule and its two halves, and every guest falls
  // under one of them:
  //
  //  - A guest whose `BookingGuestNight` rows record what they paid is credited
  //    EXACTLY that, discount-inclusive, through the lock — which is how
  //    INV-MOD-006's "a party dropping below the minimum on removal never loses a
  //    discount it bought" is actually achieved, and it needs no party count.
  //  - A guest with NOTHING recorded (a booking predating the rows, or one created
  //    by approving a request — #2739 backfills those but cannot empty the
  //    population) has no per-night evidence at all, so this errs TOWARD the
  //    member: their own rate type at today's rate, no substitution, which is at
  //    or above the discounted rate for any sane rate table. The over-credit that
  //    direction allows is bounded by `refundCeilingCents`, is the documented
  //    pre-existing degradation INV-MOD-005 already names, and is unchanged here.
  //
  // The accurate answer for that second guest is their own stored per-night
  // average — right in both directions, where neither today's-rate rule is — but
  // it moves the discount-DISABLED path too, so it is a change to ordinary
  // bookings and the 960-case equivalence matrix, and it belongs to its own issue
  // with #2745's repricing decision rather than to this one.
  //
  // Still a party-wide pass, for one reason: with no config the party count cannot
  // change a price (`isGroupDiscountApplicable` refuses before it is read and no
  // rate can be substituted), so this is the per-guest arithmetic in one call, and
  // ordering it first makes a booking with no rate for one of its nights throw
  // naming the same night it named before rather than one from the other pass.
  const heldWindowPrices = pricePartyNights(
    existingNightPlans.map((entry) => ({
      guest: entry.guest,
      nightKeys: entry.oldWindowNightKeys,
      lockedNightPricesByKey: entry.storedNightPriceByKey,
    })),
    input.seasons
  );

  // #2756: THE POST-EDIT PARTY, over the nights each guest ends up holding — the
  // pass the whole change is for. Every guest who survives the edit is in it with
  // the nights they will hold, and every added guest is in it with theirs, so on
  // a night this edit newly buys `countActiveGuestsForNight` sees the party that
  // will really be in the lodge and the group discount applies to it exactly as it
  // does on creation, a waitlist reprice, an ordinary date change or an ordinary
  // guest add (INV-MOD-006). The count is right in both directions without any
  // special-casing: a removed guest's proposed nights stop at the edit window, so
  // they are not counted on a future night; a shortened check-out drops its own
  // tail; and a guest whose stay ends early is counted on the nights they hold and
  // no others.
  const proposedPartyPrices = pricePartyNights(
    [
      ...existingNightPlans.map((entry) => ({
        guest: entry.guest,
        nightKeys:
          pricingFloorKey === undefined
            ? []
            : proposedPassNightKeys(entry, pricingFloorKey),
        lockedNightPricesByKey: entry.storedNightPriceByKey,
      })),
      // No stored night prices to honour: every night is being bought now, so
      // each one is its own current season rate (#2744) — under the post-edit
      // party, which is the defect #2756 fixes.
      ...addGuests.map((guest) => ({ guest, nightKeys: addedGuestNightKeys })),
    ],
    input.seasons,
    input.groupDiscount
  );

  const proposedExistingGuests = existingNightPlans.map((entry, index) => {
    const {
      guest,
      storedNightPriceByKey,
      oldWindowNightKeys,
      proposedNightKeys,
      proposedNightKeySet,
      futureNightKeys,
      newFutureStartKey,
      removedFromFuture,
    } = entry;
    const proposedPriced = proposedPartyPrices[index];
    const heldPriced = heldWindowPrices[index];

    // What the guest's current nights inside the edit window are worth. "Raw"
    // because a night with no recoverable price is valued at TODAY's rate, which
    // after a rate rise can exceed what the member was ever charged;
    // `refundCeilingCents` below is what stops that leaving the wire.
    //
    // #2756 splits it by whether the guest KEEPS the night, and that split is the
    // property that makes a party-aware discount safe on live bookings:
    //
    //  - A night they KEEP is taken from the POST-EDIT pass, the same number the
    //    new-price window below will use for it, so it cancels to nothing across
    //    the difference exactly as #2744's locked prices made it cancel. Nothing
    //    already bought moves — not for a guest whose rows record what they paid
    //    (whose price is locked anyway), and not for a legacy guest with no
    //    recoverable price either, who would otherwise have been re-rated in one
    //    window and not the other every time an edit pushed the party across the
    //    minimum group size. Adding a guest would then have CREDITED the rest of
    //    the party for nights they already held, and removing one would have
    //    CHARGED them more for the same nights (INV-MOD-005, INV-MOD-006).
    //  - A night they GIVE BACK appears in this window only, so there is nothing
    //    to cancel against, and it is valued exactly as it was before #2756: from
    //    the pre-edit window, which is passed NO discount config. A guest whose
    //    rows record what they paid is credited that, discount included, through
    //    the lock — which is how INV-MOD-006's "a party dropping below the minimum
    //    on removal never loses a discount it bought" is really achieved. A guest
    //    with nothing recorded has no per-night evidence, so the fallback errs
    //    toward the member at their own type's rate rather than guessing today's
    //    party onto a night it may never have priced. See the pass itself for why
    //    the more accurate stored-average valuation is a separate change.
    const rawOldFuturePriceCents = sumCents(
      oldWindowNightKeys.map((key) =>
        proposedNightKeySet.has(key)
          ? nightPriceFrom(proposedPriced, key)
          : nightPriceFrom(heldPriced, key)
      )
    );

    // #2744: the same locked prices go into the NEW window too. A night the
    // guest keeps therefore carries one price on both sides of the difference
    // and cancels to nothing, which is why an extension's delta is still exactly
    // the nights it adds and no night anybody already bought is ever re-rated
    // (INV-MOD-005). Only genuinely-new nights reach a season lookup.
    const futurePerNightCents = removedFromFuture
      ? // A removed guest holds no future night — `proposedStayEnd` collapses to
        // the edit window, so `futureNightKeys` is empty and this maps to `[]`.
        // Written as a zero per night rather than a bare `[]` so the per-night
        // list stays the same length as the night list by construction.
        futureNightKeys.map(() => 0)
      : nightPricesFrom(proposedPriced, futureNightKeys);
    const newFuturePriceCents = sumCents(futurePerNightCents);
    // #2744, acceptance criterion 1: an edit can never leave a guest owing less
    // than nothing. The locked prices above cure the CAUSE for every guest whose
    // rows record what they paid, but they cannot help a guest with no
    // recoverable price at all — a booking that predates `BookingGuestNight`,
    // or one created by approving a booking request, which still writes no rows
    // (#2739). Those nights are valued at today's rate on the old leg, so after
    // a rate rise the credit can exceed the guest's whole stored total and the
    // club hands back money it never took.
    //
    // The ceiling is what the guest is actually carrying: their stored price,
    // plus whatever this edit is charging them for the nights they keep. Credit
    // more than that and their price goes negative. Below the ceiling nothing
    // moves, which is why this is a floor under the money rather than a change
    // to the arithmetic — for a guest whose nights are priced at or under what
    // they paid (every healthy booking, and every case in the contiguous
    // equivalence matrix, where the old window prices a SUBSET of the nights the
    // stored total covers) the clamp cannot bind.
    //
    // Clamped here, on the old-price leg, and not on the delta: the leg is what
    // the modify-quote route itemises as the "removed from future nights"
    // credit, so quote and charge stay the same number, and
    // `newFuture - oldFuture === futureDelta` stays true for every consumer.
    //
    // `Math.max(guest.priceCents, 0)` and not the stored price itself: a guest
    // whose price is ALREADY below zero was damaged by an edit made before this
    // change, and their ceiling is 0 — no further credit — so this edit cannot
    // drive them deeper. It does not lift them back to zero either. Correcting
    // what the old arithmetic already wrote is an owner decision with its own
    // audit, tracked on #2745; refusing to make it worse is not.
    const refundCeilingCents =
      Math.max(guest.priceCents, 0) + newFuturePriceCents;
    const oldFuturePriceCents = Math.min(
      rawOldFuturePriceCents,
      refundCeilingCents
    );
    const futureDeltaCents = newFuturePriceCents - oldFuturePriceCents;
    const priceCents = guest.priceCents + futureDeltaCents;

    return {
      guest,
      stayStart: entry.stayStart,
      stayEnd: entry.proposedStayEnd,
      nights: proposedNightKeys.map((key) => parseDateOnly(key)),
      perNightCents: composeProposedNightPrices({
        pastNightKeys: proposedNightKeys.filter(
          (key) => key < newFutureStartKey
        ),
        futureNightKeys,
        futurePerNightCents,
        storedNightPriceByKey,
        totalCents: priceCents,
      }),
      futureNights: futureNightKeys.map((key) => parseDateOnly(key)),
      priceCents,
      oldFuturePriceCents,
      newFuturePriceCents,
      futureDeltaCents,
      removedFromFuture,
      futureStart: entry.newFutureStart,
    };
  });

  const proposedAddedGuests = addGuests.map((guest, addedIndex) => {
    // Their slice of the post-edit party pass (#2756), read out by index the way
    // the guest-add route reads the added guest's slice of its own combined
    // breakdown: every existing guest comes first, in booking order, then every
    // added guest in request order. The per-night amounts are what pricing
    // returned night by night — no average, and the sum is the total by
    // construction (#2744) — and each one now carries the group discount the
    // whole party qualifies for on that night.
    const perNightCents = nightPricesFrom(
      proposedPartyPrices[existingNightPlans.length + addedIndex],
      addedGuestNightKeys
    );
    return {
      guest,
      stayStart: editableFrom,
      stayEnd: newCheckOut,
      nights: addedGuestNightKeys.map((key) => parseDateOnly(key)),
      perNightCents,
      priceCents: sumCents(perNightCents),
    };
  });

  // #2029: a guest is "active in the future window" when its corrected future
  // window [futureStart, proposedStayEnd) is non-empty. Using futureStart (not
  // editableFrom) folds in the check-out-day extension night, which the old
  // `maxDate(stayStart, editableFrom) < stayEnd` test dropped (proposedStayEnd
  // could equal editableFrom on a +1 extension). Byte-identical for mid-stay /
  // last-night edits, where futureStart === editableFrom.
  //
  // #2736 states the same test over the night set instead of the window: a
  // guest is future-active when they hold at least one night from futureStart
  // on. Identical for a contiguous guest — a non-empty window is exactly a
  // non-empty run of nights — and correct for a sparse one, whose remaining
  // nights can all sit behind a window that is still nominally open.
  const futureActiveGuestCount =
    proposedExistingGuests.filter(
      (entry) => !entry.removedFromFuture && entry.futureNights.length > 0
    ).length + proposedAddedGuests.length;

  if (newCheckOut > editableFrom && futureActiveGuestCount === 0) {
    // #2736 makes one refusal this rule never used to make, and it deserves to
    // say which one it is. A guest whose remaining nights all sit BEHIND the
    // edit window still has a nominally-open window [futureStart, stayEnd), so
    // the old count called them future-active and let the edit through — leaving
    // the booking with future nights nobody occupies. The night test refuses it
    // instead, which is right, but "must have at least one guest" describes the
    // rule rather than the problem: the officer's actual mistake is the
    // check-out date, and the recoverable answer is the morning after the last
    // night anybody still holds.
    //
    // #2743 widens the same refusal to one more booking, and it is worth being
    // plain about it: a booking whose check-out is still ahead but EVERY guest's
    // stay has already finished. That edit used to go through by re-admitting
    // and charging those guests for the remaining nights; the nights are no
    // longer sold, so nobody is left holding one and the save is refused with
    // the same recoverable sentence. The booking is inconsistent — its check-out
    // claims nights no guest ever booked — and the message names the check-out
    // that matches who is actually there.
    //
    // It fires only when NOBODY is left in the future window, never when the
    // tail is merely PARTLY uncovered. That asymmetry is deliberate: a booking
    // whose check-out outruns its longest remaining stay is the ordinary result
    // of removing the guest who was staying longest, and refusing it would
    // refuse a routine save. The counterpart is that such a booking eventually
    // walks into THIS refusal, once the remaining nights fall behind the window
    // — which is why the sentence below has to name a check-out the plan will
    // actually accept, and does.
    //
    // Unreachable for a contiguous stay that runs to the booking's own
    // check-out. Such a guest, if they keep any proposed night, always holds one
    // from futureStart on (their nights are a run that starts at or before it),
    // so this branch cannot change the wording of any refusal the pre-#2736
    // arithmetic also made — which is what the 960-case matrix in
    // `booking-edit-guest-ranges-sparse.test.ts` compares. Removing every guest
    // still lands on the original sentence.
    //
    // This string is a LOG line, not operator copy: the quote route replaces it
    // with "Unable to price the requested future-night changes" and the save
    // route with "Failed to modify booking" (#1888 keeps raw messages off the
    // wire). Making the edit panel explain this properly is a UI change, not
    // this function's to make.
    const lastRemainingNightKeys = proposedExistingGuests
      .filter((entry) => !entry.removedFromFuture)
      .flatMap((entry) => entry.nights.map(dateOnlyKey))
      .sort();
    const lastRemainingNightKey =
      lastRemainingNightKeys[lastRemainingNightKeys.length - 1];
    if (lastRemainingNightKey !== undefined) {
      // The morning after the last night anybody still holds — CLAMPED to
      // `editableFrom`, because a check-out before it is refused by this
      // function's own first guard and by `resolveTargetDates` before that
      // ("NZ today and earlier are locked for self-service changes"). Under
      // #2736 alone the clamp was invisible: that refusal needs a guest whose
      // last night is the day before the window opens, so lastNight + 1 landed
      // exactly ON editableFrom. #2743's shape is a guest who left a WEEK ago,
      // and lastNight + 1 is then a date nobody can save — the message would
      // name a remedy the code rejects and the booking would be editable by no
      // route at all. Clamped, the named date is always one the plan accepts,
      // and the #2736 wording is byte-identical because its own suggestion
      // already equalled editableFrom.
      const workableCheckOut = dateOnlyKey(
        maxDate(
          addDaysDateOnly(parseDateOnly(lastRemainingNightKey), 1),
          editableFrom
        )
      );
      throw new Error(
        `No remaining guest is booked for a night on or after ${dateOnlyKey(editableFrom)}, ` +
          `so the nights up to the new check-out ${dateOnlyKey(newCheckOut)} would be unoccupied. ` +
          `Set the check-out to ${workableCheckOut} instead.`
      );
    }
    throw new Error("Booking must have at least one guest for future nights");
  }

  const newTotalPriceCents =
    proposedExistingGuests.reduce((sum, entry) => sum + entry.priceCents, 0) +
    proposedAddedGuests.reduce((sum, entry) => sum + entry.priceCents, 0);
  const newDiscountCents = input.booking.discountCents;
  const newPromoAdjustmentCents = input.booking.promoAdjustmentCents;
  const newFinalPriceCents = newTotalPriceCents + newPromoAdjustmentCents;
  const priceDiffCents = newFinalPriceCents - input.booking.finalPriceCents;
  const futureExistingDeltaCents = proposedExistingGuests.reduce(
    (sum, entry) => sum + entry.futureDeltaCents,
    0
  );
  const capacityGuestRanges = [
    ...proposedExistingGuests
      .filter(
        (entry) => !entry.removedFromFuture && entry.futureNights.length > 0
      )
      .map((entry) => ({
        // #2029: anchor the checked range at the guest's corrected futureStart,
        // not editableFrom, so the genuinely-new check-out-day night is inside
        // the window the capacity resolver iterates (it would otherwise be
        // invisible and overbookable). Unchanged for mid-stay / last-night.
        stayStart: entry.futureStart,
        stayEnd: entry.stayEnd,
        // #2736: the window still bounds which nights are examined; the night
        // set decides which of them this guest actually occupies. Expanding to
        // the same nights for a contiguous guest, so no ordinary edit's capacity
        // verdict moves.
        nights: entry.futureNights,
        memberId: entry.guest.memberId ?? null,
      })),
    ...proposedAddedGuests.map((entry) => ({
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
      nights: entry.nights,
      memberId: entry.guest.memberId ?? null,
    })),
  ];

  // #2029: the capacity window must start no later than the earliest checked
  // night. Seed at editableFrom (so it is never pushed later than today+1) and
  // pull it back to the earliest night any included range actually OCCUPIES —
  // which drops to the check-out-day night for such an extension, and stays
  // editableFrom for every mid-stay edit.
  //
  // #2743: read off the night set, not off `range.stayStart`. That start is the
  // guest's pricing anchor (`futureStart`), which reaches back to their own stay
  // end so a check-out-day extension's new night is priced — and for a guest who
  // went home a week ago it reached back a week, dragging the checked window
  // over nights this edit puts nobody on. `checkCapacityForGuestRanges`
  // evaluates EVERY night in `[capacityRangeStart, newCheckOut)`, so a past
  // night that is over capacity (possible via the #1668 admin override) or under
  // a whole-lodge hold (never admin-overridable, ADR-001 decision 5) could
  // refuse an extension that adds nobody to it. Every range in this list is
  // non-empty by the filter above, so `nights[0]` always exists, and it is by
  // construction the earliest night that range can occupy — narrowing the window
  // to it can never hide a night that IS checked.
  const capacityRangeStart = capacityGuestRanges.reduce((earliest, range) => {
    const firstOccupiedNight = range.nights[0];
    return firstOccupiedNight !== undefined && firstOccupiedNight < earliest
      ? firstOccupiedNight
      : earliest;
  }, editableFrom);

  return {
    proposedExistingGuests,
    proposedAddedGuests,
    remainingGuests,
    removedGuests,
    newTotalPriceCents,
    newDiscountCents,
    newPromoAdjustmentCents,
    newFinalPriceCents,
    priceDiffCents,
    futureExistingDeltaCents,
    futureActiveGuestCount,
    capacityGuestRanges,
    capacityRangeStart,
  };
}
