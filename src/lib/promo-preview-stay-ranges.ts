import {
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRanges,
  type NormalizedBookingGuestStayRange,
} from "@/lib/booking-guest-stay-range-input";
import {
  resolveModificationStayRanges,
  type LiveGuestStayRow,
  type StayRangeDeltaEntry,
} from "@/lib/booking-modification-stay-ranges";
import { editedGuestPricingLocks } from "@/lib/booking-modify-plan";
import type { BookingGuestNightPriceSource } from "@prisma/client";

/**
 * Which nights each guest is priced on in the promo preview
 * (`POST /api/promo-codes/validate`), #4199.
 *
 * The preview prices a whole PARTY, not a delta: one row per guest, in the order
 * a guest-targeted code's indexes count them. On an edit (a booking id the
 * caller may read) that party is the edit the booking editor will save, so its
 * nights must be the ones the save prices. The save resolves them with the
 * modification planner, `resolveModificationStayRanges` (`INV-EXCEPT-022`), so
 * this module hands the party to that same planner as the delta it is, rather
 * than re-deciding any of its rules:
 *
 *  - a guest naming a row of this booking (`bookingGuestId`) whose member is the
 *    guest's member (both empty for a non-member) is a REMAINING guest, and
 *    their dates or night set are that guest's `guestStayRanges` entry. Only
 *    the first guest naming a row claims it;
 *  - every other guest is an ADDED guest;
 *  - the request's dates are the delta's dates.
 *
 * So a guest the grid gives the 10th and 12th is priced on two nights, as the
 * quote and the save price them; a range-mode guest's dates are continuous, as
 * the owner decided on #4189; and a request carrying no ranges at all keeps
 * each guest's stored nights unless the booking's dates moved, which is the
 * planner's own rule.
 *
 * A create preview (no booking) has no planner: each guest is normalised on
 * their own, exactly as the create route does. Range errors surface as
 * `BookingGuestStayRangeValidationError` for the route to answer with a 400.
 *
 * PRICES, #4202. A remaining guest also carries the locks the quote and the
 * save price them with, from the one home for them (`editedGuestPricingLocks`,
 * `INV-SSOT`): every night they already hold keeps its valued figure (#1036,
 * `INV-MOD-005`, `INV-MOD-028` since #4317), and only a night the edit buys
 * prices at current rates. The route hands the party to the same pricing pass the quote uses
 * (`priceBookingGuestsWithMembershipTypePolicy`), so when rates have changed
 * since the booking was made the box discounts what the quote discounts.
 *
 * RE-RATES. The two officer re-rates the quote clears a guest's locks for — a
 * #2337 placeholder-to-member link and an other-lodge tick or untick — are
 * resolved before this module runs, by the quote's own resolvers
 * (`promoPreviewEditContext`), and arrive on the stored row: `linkedMemberId`
 * (the guest then prices as that member) and `repricedDeliberately` (the locks
 * are cleared through the same `editedGuestPricingLocks(row, true)` the quote
 * calls). A linked guest is still the row's placeholder in the request, so the
 * row match below is unchanged by the link. `otherLodgeMember` is the flag the
 * quote prices the guest with: the election's end state, or the stored flag
 * when the edit carries none. An added guest and a create preview carry no
 * locks and no flag. The refusals of a re-rate are the quote's and are raised
 * there too, before this module runs; what the box does NOT mirror (the
 * parked-amount election refusal, the mid-stay refusal of any code change) is
 * listed on `promoPreviewEditContext`.
 */
export type PromoPreviewStayGuest = StayRangeDeltaEntry & {
  memberId?: string | null;
  bookingGuestId?: string;
};

/**
 * A row of the booking being edited: as much of it as stay resolution needs,
 * plus the price each night was sold at, which the pricing pass keeps (#4202).
 */
export type PromoPreviewStoredGuest = Omit<LiveGuestStayRow, "nights"> & {
  memberId: string | null;
  /** `BookingGuest.priceCents` as stored: the total the valued locks add up to (#4317). */
  priceCents: number;
  /** The other-lodge flag the quote prices this guest with (Other Lodges epic). */
  otherLodgeMember?: boolean;
  /** The edit re-rates this guest (a #2337 link, an other-lodge tick or untick): no locks. */
  repricedDeliberately?: boolean;
  /** #2337: the member this placeholder is being linked to, whom it then prices as. */
  linkedMemberId?: string;
  nights?: ReadonlyArray<{
    stayDate: Date;
    priceCents?: number | null;
    priceSource?: BookingGuestNightPriceSource;
  }> | null;
};

/** The booking an edit preview is for, with its rows the request names. */
export type PromoPreviewEdit = {
  booking: { checkIn: Date; checkOut: Date };
  storedGuests: ReadonlyArray<PromoPreviewStoredGuest>;
};

/** What a guest prices with from their stored row (#4202): only a remaining guest has any. */
type PromoPreviewGuestLocks = Partial<Pick<ReturnType<typeof editedGuestPricingLocks>, "lockedNightPrices">> & {
  otherLodgeMember?: boolean;
  /** #2337: a linked placeholder prices as the member it is being linked to. */
  link?: { memberId: string; isMember: true };
};

export type PromoPreviewStays<Guest> = {
  checkIn: Date;
  checkOut: Date;
  guests: Array<Guest & NormalizedBookingGuestStayRange & Omit<PromoPreviewGuestLocks, "link">>;
};

type PromoPreviewStayArgs<Guest> = {
  checkIn: Date;
  checkOut: Date;
  guests: ReadonlyArray<Guest>;
  edit: PromoPreviewEdit | null;
};

/**
 * The route's door: a range the planner refuses comes back as its own wording
 * (`refusal`) for a 400, so the preview and the save refuse it identically.
 */
export function resolvePromoPreviewStaysOrRefusal<Guest extends PromoPreviewStayGuest>(
  args: PromoPreviewStayArgs<Guest>,
): PromoPreviewStays<Guest> | { refusal: string } {
  try {
    return resolvePromoPreviewStays(args);
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) return { refusal: error.message };
    throw error;
  }
}

export function resolvePromoPreviewStays<Guest extends PromoPreviewStayGuest>(
  args: PromoPreviewStayArgs<Guest>,
): PromoPreviewStays<Guest> {
  if (!args.edit) {
    return {
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      guests: normalizeGuestStayRanges([...args.guests], {
        checkIn: args.checkIn,
        checkOut: args.checkOut,
      }),
    };
  }

  const storedById = new Map(args.edit.storedGuests.map((row) => [row.id, row]));
  const remainingRows: PromoPreviewStoredGuest[] = [];
  const partyIndexByRowId = new Map<string, number>();
  const addedPartyIndexes: number[] = [];
  args.guests.forEach((guest, index) => {
    const row = guest.bookingGuestId ? storedById.get(guest.bookingGuestId) : undefined;
    const sameMember = row && (row.memberId ?? null) === (guest.memberId?.trim() || null);
    if (row && sameMember && !partyIndexByRowId.has(row.id)) {
      remainingRows.push(row);
      partyIndexByRowId.set(row.id, index);
    } else {
      addedPartyIndexes.push(index);
    }
  });

  const stayOf = (guest: Guest): StayRangeDeltaEntry => ({
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    nights: guest.nights,
  });
  const guestAt = (index: number): Guest => {
    const guest = args.guests[index];
    if (guest === undefined) {
      throw new Error(`Promo preview has no guest at party position ${index} (#4199).`);
    }
    return guest;
  };

  const resolved = resolveModificationStayRanges({
    booking: args.edit.booking,
    guests: remainingRows,
    input: {
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      guestStayRanges: remainingRows.map((row) => ({
        guestId: row.id,
        ...stayOf(guestAt(partyIndexByRowId.get(row.id)!)),
      })),
      addGuests: addedPartyIndexes.map((index) => stayOf(guestAt(index))),
    },
  });

  const rangeByPartyIndex = new Map<number, NormalizedBookingGuestStayRange>();
  const locksByPartyIndex = new Map<number, PromoPreviewGuestLocks>();
  for (const { guest: row, ...range } of resolved.remaining) {
    const index = partyIndexByRowId.get(row.id)!;
    rangeByPartyIndex.set(index, range);
    locksByPartyIndex.set(index, {
      ...editedGuestPricingLocks(lockableNights(row), args.edit.booking, row.repricedDeliberately === true),
      otherLodgeMember: row.otherLodgeMember ?? false,
      ...(row.linkedMemberId ? { link: { memberId: row.linkedMemberId, isMember: true as const } } : {}),
    });
  }
  resolved.added.forEach((range, addedIndex) => {
    rangeByPartyIndex.set(addedPartyIndexes[addedIndex]!, range);
  });

  return {
    checkIn: resolved.checkIn,
    checkOut: resolved.checkOut,
    guests: args.guests.map((guest, index) => {
      const range = rangeByPartyIndex.get(index);
      if (range === undefined) {
        throw new Error(`Promo preview resolved no stay for party position ${index} (#4199).`);
      }
      // The planner's answer replaces the request's own fields outright, so a
      // night set the planner did not keep cannot ride along as strings; and a
      // remaining guest's locks and flag are the stored row's, never anything sent.
      return {
        ...guest,
        stayStart: range.stayStart,
        stayEnd: range.stayEnd,
        nights: range.nights,
        lockedNightPrices: locksByPartyIndex.get(index)?.lockedNightPrices,
        otherLodgeMember: locksByPartyIndex.get(index)?.otherLodgeMember,
        ...locksByPartyIndex.get(index)?.link,
      };
    }),
  };
}

/**
 * The stored row in the shape the lock reader takes. Every night is kept, so the
 * valued locks see every night the guest holds (#4317); a row read without its
 * price source is recorded as UNKNOWN, which never changes a value (`INV-MOD-028`).
 */
function lockableNights(row: PromoPreviewStoredGuest): Parameters<typeof editedGuestPricingLocks>[0] {
  return {
    priceCents: row.priceCents,
    stayStart: row.stayStart,
    stayEnd: row.stayEnd,
    nights: (row.nights ?? []).map((night) => ({
      stayDate: night.stayDate,
      priceCents: night.priceCents,
      priceSource: night.priceSource ?? "UNKNOWN",
    })),
  };
}
