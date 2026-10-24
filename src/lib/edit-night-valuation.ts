import type { BookingGuestNightPriceSource, MemberGuestConsentStatus } from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import logger from "@/lib/logger";
import {
  getGuestBedNightKeys,
  type BookingStayRange,
} from "@/lib/booking-guest-stay-ranges";
import type { StrandNightPrices } from "@/lib/booking-strand-night-prices";
import {
  dateOnlyInstantOf,
  requireCalendarDate,
  type CalendarDate,
} from "@/lib/club-time";
import { compareOrdinal } from "@/lib/ordinal-order";
import {
  storedNightPriceDetailsByKey,
  type StoredNightPriceInput,
  type StoredNightPriceWithSource,
} from "@/lib/stored-night-price-write";
import {
  valueStrandNights,
  type ValuedStrandNight,
} from "@/lib/strand-night-valuation";

/**
 * #4317 (epic #4302, owner decisions D1, D8 and D11, 23 Oct 2026): WHAT AN EDIT
 * READS A GUEST'S HELD NIGHTS AS BEING WORTH, AND WHAT IT DOES TO THE HEADLINE.
 *
 * Every edit is priced from stored data (`INV-MOD-028`). The night values come
 * from `valueStrandNights`, the one home for the rule; this module only adapts
 * them to the shapes the edit doors price with, so no door states the rule
 * again (`INV-SSOT-001`):
 *
 * - **Locks.** Every night a guest holds is handed to pricing at its valued
 *   figure, so a night the guest keeps keeps that figure and a night given back
 *   is credited at it. Only a night the edit newly buys is priced at today's
 *   rates. This replaces the lenient `lockedNightPricesForGuest`, which locked
 *   only usable rows and let a blank night fall through to today's rate.
 * - **The headline moves only by the edit's own change**
 *   ({@link editedBookingTotalCents}). A booking whose stored total disagrees
 *   with its guests' stored totals (a headline a parked edit froze) keeps that
 *   gap through the edit, so the edit never settles it as if it were its own.
 * - **Money not attached to a night.** The values add up to the guest's stored
 *   total, except for a strand holding no night at all, which carries its total
 *   as `unattachedCents`; an edit keeps it on the strand, so a guest the edit
 *   does not touch keeps its stored total exactly (T1).
 * - **A negative stored guest total refuses the edit** (D11, #4317 review M2).
 *   The database forbids one (`BookingGuest_price_nonnegative`) and none has ever
 *   been measured, so `valueStrandNights` still values it at $0 as a pure
 *   function, but no door writes from it: {@link refuseNegativeStoredGuestTotals}.
 *
 * Night keys come from `getGuestBedNightKeys`, the canonical helper: a guest's
 * own rows where it has any, otherwise its stay envelope, otherwise the
 * booking's range (`INV-DATE-020`). No clock, no database, no rate table. The
 * two side effects are refusals' log lines: D11's writes to the logger its
 * caller hands in; the negative-headline refusal in `editedBookingTotalCents`,
 * which the pure in-progress planner reaches too, writes to the shared one.
 */

/** One held night with what an edit reads it as worth. */
export type ValuedHeldNight = {
  date: CalendarDate;
  valueCents: number;
  /**
   * The provenance a rewritten row records: the stored one where the row is
   * the value, `EVEN_SPLIT` for a share of a split, `UNKNOWN` for a night
   * valued at $0 because its strand's total is negative.
   */
  priceSource: BookingGuestNightPriceSource;
};

export type ValuedEditStrand = {
  /** Every night the guest holds, in the order of the keys given. */
  nights: ReadonlyArray<ValuedHeldNight>;
  /**
   * The stored total less what its nights are valued at. Zero except on a
   * strand holding no night with money on it, or on a negative stored total
   * (D11), which no door prices.
   */
  unattachedCents: number;
  /** Set on a negative stored total, for #2745 (D11). */
  flag: "NEGATIVE_STORED_TOTAL" | null;
};

function sourceOf(
  night: ValuedStrandNight,
  stored: StoredNightPriceWithSource | undefined,
): BookingGuestNightPriceSource {
  switch (night.basis) {
    case "STORED_ROW":
      return stored?.priceSource ?? "UNKNOWN";
    case "SPLIT":
      return "EVEN_SPLIT";
    case "NEGATIVE_TOTAL":
      return "UNKNOWN";
    default: {
      const unhandled: never = night.basis;
      throw new Error(`edit-night-valuation: unhandled basis ${String(unhandled)}`);
    }
  }
}

/**
 * Value one strand from the night keys it holds and what is stored against
 * them. The planner already holds both, keyed through the canonical helpers,
 * so it calls this directly; every other caller goes through
 * {@link valueEditStrand}.
 */
export function valueHeldNights(
  heldNightKeys: readonly string[],
  storedNightDetailsByKey: ReadonlyMap<string, StoredNightPriceWithSource>,
  storedTotalCents: number,
): ValuedEditStrand {
  if (heldNightKeys.length === 0 && storedTotalCents >= 0) {
    // Nothing to attach the money to. It stays on the strand while the strand
    // does, and a whole removal credits it (T2).
    return { nights: [], unattachedCents: storedTotalCents, flag: null };
  }
  const valuation = valueStrandNights(
    heldNightKeys.map((key) => ({
      date: requireCalendarDate(key),
      priceCents: storedNightDetailsByKey.get(key)?.priceCents ?? null,
      priceSource: storedNightDetailsByKey.get(key)?.priceSource,
    })),
    storedTotalCents,
  );
  return {
    nights: valuation.nights.map((night) => ({
      date: night.date,
      valueCents: night.valueCents,
      priceSource: sourceOf(night, storedNightDetailsByKey.get(night.date)),
    })),
    unattachedCents: storedTotalCents - valuation.totalCents,
    flag: valuation.flag,
  };
}

/** The stored shape every edit door already loads for a guest. */
export type StoredEditStrand = {
  priceCents: number;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  nights?: ReadonlyArray<StoredNightPriceInput> | null;
};

/** {@link valueHeldNights} for a guest as loaded, keyed by the canonical helper. */
export function valueEditStrand(
  guest: StoredEditStrand,
  booking: BookingStayRange,
): ValuedEditStrand {
  return valueHeldNights(
    getGuestBedNightKeys(guest, booking),
    storedNightPriceDetailsByKey(guest.nights),
    guest.priceCents,
  );
}

/** A lock the pricing engine reads (`lockedNightPrices`), one per held night. */
export type ValuedNightLock = {
  stayDate: Date;
  priceCents: number;
  priceSource: BookingGuestNightPriceSource;
};

/**
 * The locks and the unattached money one existing guest prices an edit with.
 * Every held night is locked at its value, so only a night the edit buys
 * reaches a season rate.
 */
export function valuedNightLocksForGuest(
  guest: StoredEditStrand,
  booking: BookingStayRange,
): { lockedNightPrices: ValuedNightLock[]; unattachedCents: number } {
  const valued = valueEditStrand(guest, booking);
  return {
    lockedNightPrices: valued.nights.map((night) => ({
      stayDate: dateOnlyInstantOf(night.date),
      priceCents: night.valueCents,
      priceSource: night.priceSource,
    })),
    unattachedCents: valued.unattachedCents,
  };
}

/**
 * Put each strand's unattached money back into a breakdown the pricing engine
 * produced from valued locks: a strand holding no night keeps its stored total
 * on itself rather than being priced at $0.
 *
 * `pricedGuests` is index-aligned with the breakdown: an existing guest's
 * `unattachedCents`, or nothing for a guest the edit adds. With no night-less
 * strand on the booking every term is zero and the breakdown comes back
 * unchanged.
 */
export function withUnattachedStrandMoney<
  Breakdown extends {
    totalPriceCents: number;
    guests: ReadonlyArray<{ priceCents: number }>;
  },
>(
  breakdown: Breakdown,
  // `& object` so a guest the edit adds, which carries no field of this shape
  // at all, is accepted rather than refused as a "weak type" mismatch.
  pricedGuests: ReadonlyArray<{ unattachedCents?: number } & object>,
): Breakdown {
  const unattached = pricedGuests.map((guest) => guest.unattachedCents ?? 0);
  if (unattached.every((cents) => cents === 0)) {
    // Nothing to add: the breakdown is returned as the engine produced it, so a
    // caller's own check of its shape still answers a malformed one.
    return breakdown;
  }
  if (pricedGuests.length !== breakdown.guests.length) {
    throw new Error(
      `withUnattachedStrandMoney: ${pricedGuests.length} pricing inputs for ${breakdown.guests.length} priced guests (#4317).`,
    );
  }
  const totalUnattached = unattached.reduce((sum, cents) => sum + cents, 0);
  return {
    ...breakdown,
    totalPriceCents: breakdown.totalPriceCents + totalUnattached,
    guests: breakdown.guests.map((guest, index) => ({
      ...guest,
      priceCents: guest.priceCents + (unattached[index] ?? 0),
    })),
  };
}

/**
 * THE BOOKING TOTAL AN EDIT WRITES (#4317 review H1): the stored total, moved
 * by exactly what the edit changed on its guests.
 *
 * `pricedGuestsTotalCents` is what the edited party comes to, guest by guest —
 * the engine's breakdown, or the in-progress planner's guests. `storedBooking`
 * is the booking as loaded BEFORE the edit, every guest included, a removed one
 * too. Every writer stores the total as the sum of its guests, so for an
 * ordinary booking this is simply that sum. A booking whose headline a parked
 * edit froze (`INV-MOD-055`) is not: its total still counts money the open or
 * declined review holds. Reading the new total as the bare sum of the guests
 * would settle that gap, unasked, on the first edit after #4317 — a $600
 * headline over two $200 guests extended by a $50 night each would refund $100
 * for $100 of nights bought. Carrying the gap leaves it exactly where it was for
 * the review, or wave B's re-base (D5), to settle.
 *
 * The one home (`INV-SSOT-001`): every edit door, the quote and the
 * in-progress planner take the new total through here, so quote and save
 * cannot carry it differently.
 */
export function editedBookingTotalCents(
  storedBooking: {
    id?: string;
    totalPriceCents: number;
    guests: ReadonlyArray<{ priceCents: number }>;
  },
  pricedGuestsTotalCents: number,
): number {
  const storedGuestsTotalCents = storedBooking.guests.reduce(
    (sum, guest) => sum + guest.priceCents,
    0,
  );
  const totalPriceCents =
    storedBooking.totalPriceCents + (pricedGuestsTotalCents - storedGuestsTotalCents);
  if (totalPriceCents < 0) {
    // #4317 review round 2: a frozen headline BELOW its guests (a parked add
    // whose review settled while the re-base declined) can carry an edit's
    // change below zero - $100 over $400 of guests, less a $300 guest, is
    // -$200. A negative total misreads everywhere it is used (the cancellation
    // cap, bank reconciliation), so the edit is refused, nothing written, until
    // wave B re-bases the headline (#4302 D5). A promotion never takes a total
    // of zero or more below zero: the doors that re-decide it cap it in the
    // engine, and the in-progress planner caps the one it carries (round 3).
    logger.error(
      {
        bookingId: storedBooking.id ?? null,
        storedTotalPriceCents: storedBooking.totalPriceCents,
        storedGuestsTotalCents,
        editedTotalPriceCents: totalPriceCents,
        flag: "NEGATIVE_EDITED_HEADLINE",
      },
      "A booking edit was refused: carrying its frozen headline forward would write a negative total; the clean-up wave re-bases it (#4302 D5)",
    );
    throw new NegativeEditedHeadlineError();
  }
  return totalPriceCents;
}

/** What a member or officer is told when an edit would carry the total below zero. */
export const NEGATIVE_EDITED_HEADLINE_MESSAGE =
  "This booking's stored total is out of step with its guests and needs correcting by the club before it can be changed. Nothing has been changed; please contact the club.";

/** The refusal {@link editedBookingTotalCents} throws: a 409, nothing written. */
export class NegativeEditedHeadlineError extends ApiError {
  constructor() {
    super(NEGATIVE_EDITED_HEADLINE_MESSAGE, 409);
    this.name = "NegativeEditedHeadlineError";
  }
}

/**
 * Each guest's nights as the money a promotion is re-decided over, valued by
 * the same rule an edit prices with — for a re-price that moves only the
 * promotion (a guest's acceptance, #3827). Sorted by date so the rates and
 * dates are parallel and in stay order.
 */
export function valuedStrandNightPrices(
  guests: ReadonlyArray<
    StoredEditStrand & {
      id: string;
      memberId: string | null;
      isMember: boolean;
      consentStatus: MemberGuestConsentStatus | null;
    }
  >,
  booking: BookingStayRange,
): StrandNightPrices[] {
  return guests.map((guest) => {
    const nights = [...valueEditStrand(guest, booking).nights].sort((a, b) =>
      compareOrdinal(a.date, b.date),
    );
    return {
      bookingGuestId: guest.id,
      memberId: guest.memberId,
      isMember: guest.isMember,
      consentStatus: guest.consentStatus,
      perNightRates: nights.map((night) => night.valueCents),
      nightDates: nights.map((night) => dateOnlyInstantOf(night.date)),
    };
  });
}

/** What a member or officer is told when an edit meets a negative stored total. */
export const NEGATIVE_STORED_GUEST_TOTAL_MESSAGE =
  "This booking's stored price needs correcting by the club before it can be changed. Nothing has been changed; please contact the club.";

/** The refusal {@link refuseNegativeStoredGuestTotals} throws: a 409, nothing written. */
export class NegativeStoredGuestTotalError extends ApiError {
  constructor() {
    super(NEGATIVE_STORED_GUEST_TOTAL_MESSAGE, 409);
    this.name = "NegativeStoredGuestTotalError";
  }
}

/**
 * D11, as the doors apply it (#4317 review M2): an edit that meets a negative
 * stored guest total is REFUSED, before anything is written, and logged at
 * error level naming #2745.
 *
 * The database refuses such a row (`BookingGuest_price_nonnegative`, migration
 * `20260819130000`), and a production audit found none, so this is a guard on
 * an unreachable shape rather than a path anyone takes. It refuses rather than
 * prices because pricing one would have to write the negative figure back, which
 * the same constraint rejects (23514), or leave its shortfall on the headline.
 * The logger is the caller's, which keeps this module free of a logger import.
 */
export function refuseNegativeStoredGuestTotals(
  log: { error: (obj: Record<string, unknown>, msg: string) => void },
  context: { bookingId: string; site: string },
  guests: ReadonlyArray<{ id: string; priceCents: number }>,
): void {
  const bookingGuestIds = guests
    .filter((guest) => guest.priceCents < 0)
    .map((guest) => guest.id);
  if (bookingGuestIds.length === 0) return;
  log.error(
    { ...context, bookingGuestIds, flag: "NEGATIVE_STORED_TOTAL" },
    "A booking edit was refused: a stored guest total is negative, which BookingGuest_price_nonnegative forbids (D11); see #2745",
  );
  throw new NegativeStoredGuestTotalError();
}
