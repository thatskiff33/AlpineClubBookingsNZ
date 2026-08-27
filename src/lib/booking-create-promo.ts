/**
 * Promo/pricing resolution helpers for the booking-creation service.
 *
 * Extracted verbatim from `booking-create.ts`. Depends only on the shared
 * `booking-create-types` module, never on the orchestrator, to avoid an import
 * cycle.
 */
import { PromoCodeType, type FixedNightlyMode, type BookingGuest } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CalendarDate } from "@/lib/club-time";
import {
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
  type PromoBeneficiaryAllocation,
} from "@/lib/promo";
import { resolveWorkPartyEventPromoForBooking } from "@/lib/work-party";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { type BookingGuestInput, BookingPromoError } from "./booking-create-types";

export interface ResolvedPromo {
  discountCents: number;
  promoAdjustmentCents: number;
  promoFreeNightsUsed: number;
  promoEligibleGuestCount: number;
  promoAllocations: PromoBeneficiaryAllocation[];
  promoSelectedGuestIndexes?: number[];
  promoShouldPersist: boolean;
  promoCodeRecord:
    | {
        id: string;
        type: PromoCodeType;
        valueCents: number | null;
        percentOff: number | null;
        freeNightsPerIndividual: number | null;
        lifetimeFreeNightsCap: number | null;
        fixedNightlyPriceCents: number | null;
        fixedNightlyMode: FixedNightlyMode | null;
        maxGuestsPerBooking: number | null;
        maxNightlyValueCents: number | null;
        memberGuestsOnly: boolean;
        assignedMembersOnlyOwnNights?: boolean | null;
      }
    | null;
}

export function getPromoTargetBookingGuestIds(
  bookingGuests: BookingGuest[],
  selectedGuestIndexes: number[] | undefined
) {
  if (!selectedGuestIndexes) return undefined;
  return selectedGuestIndexes
    .map((index) => bookingGuests[index]?.id)
    .filter((id): id is string => Boolean(id));
}

/**
 * Resolve and validate a promo code inside the booking transaction.
 * Locks the row for update so concurrent bookings cannot over-redeem.
 * Throws BookingPromoError on validation failure so the caller can
 * roll back and return a 400.
 *
 * Internal promos (work party events) are rejected like unknown codes
 * unless allowInternal is set by the work-party resolution path.
 */
export async function resolvePromoInTransaction(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  options: {
    promoCodeStr: string;
    effectiveMemberId: string;
    checkIn: Date;
    guests: BookingGuestInput[];
    totalPriceCents: number;
    perNightCentsByGuest: number[][];
    nightDatesByGuest?: Date[][];
    promoGuestIndexes?: number[];
    allowInternal?: boolean;
    lodgeId: string;
    /**
     * The club's own calendar day (#3123, `INV-CONFIG-002`), resolved by the
     * caller BEFORE it opened the transaction whose client arrives as `tx`.
     *
     * REQUIRED. `INV-LOCK-004` names the club timezone as one of only two reads
     * that cannot take a transaction client; by this point the caller holds
     * `pg_advisory_xact_lock(1)`, the per-lodge capacity key and a `FOR UPDATE`
     * row lock on the promo code itself. It decides the promotion's validity
     * window, which is whether the member gets the discount at all.
     */
    todayAtClub: CalendarDate;
  },
): Promise<ResolvedPromo> {
  const {
    promoCodeStr,
    effectiveMemberId,
    checkIn,
    guests,
    totalPriceCents,
    perNightCentsByGuest,
    nightDatesByGuest,
    promoGuestIndexes,
    allowInternal,
    lodgeId,
    todayAtClub,
  } = options;
  const normalizedCode = promoCodeStr.toUpperCase().trim();

  // LOCK RAW, READ TYPED (#2289). The raw statement exists ONLY to take the row
  // lock, so it selects a constant, returns an affected-row count through
  // `$executeRaw`, and is never read; the promo itself is then read back through
  // the Prisma model, under that lock, in the same transaction.
  //
  // This used to be `$queryRaw<LockedPromoRow[]>\`SELECT * FROM "PromoCode" …\``,
  // and that is the single most expensive line this repository has written. The
  // generic is an unchecked CAST: raw SQL returns the PHYSICAL column names while
  // the hand-written type declared the Prisma ones, and where a deployment's
  // columns differed the properties simply arrived `undefined` —
  // `maxRedemptionsTotal` undefined made `!== null` true and `n > undefined`
  // false, so the total-redemption cap never fired, and
  // `freeNightsPerIndividual` undefined made `?? 0` yield zero, so FREE_NIGHTS
  // promos applied NO discount at booking creation while the quote path (an
  // ordinary mapped Prisma read) showed the member one. Members were quoted a
  // discount and charged without it, for months, with nothing logged: the cast
  // silenced the compiler and the mocked tests returned the same wrong shape the
  // author believed.
  //
  // The model read cannot repeat that. Prisma owns the column mapping, so the
  // names can never drift from what the schema says, and a genuinely missing
  // column is a startup/query error rather than a silent `undefined`. The cost
  // is one extra round trip inside a transaction that already makes many.
  //
  // THE ZERO-MATCH GUARD IS LOAD-BEARING, not defensive tidiness. Splitting one
  // statement into two is only behaviour-identical while the lock actually
  // matches something. `FOR UPDATE` locks NOTHING when it matches nothing, and
  // this repository runs at PostgreSQL's default READ COMMITTED deliberately
  // (`member-merge.ts` documents the reliance), so the `findUnique` below takes
  // a FRESH statement snapshot and can see a `PromoCode` that was INSERTED — or
  // whose `code` was renamed to this one — after the lock statement ran. That
  // row would be read, validated and have its redemption slot consumed with no
  // lock held on it, so two concurrent bookings could both see
  // `currentRedemptions = 0` and both redeem a `maxRedemptionsTotal: 1` code:
  // exactly the check-then-consume race the lock exists to close. `code` is the
  // only MUTABLE natural key any converted site locks on — every other site
  // keys on an immutable cuid, or materialises its singleton before locking —
  // so this is the one place it can happen.
  //
  // The old single `SELECT * … FOR UPDATE` could not do this: a row it had not
  // locked could not appear in its result set, so the same interleaving refused
  // with "Promo code not found". Reproduce that exactly rather than inventing a
  // new outcome — no lock, no promo. Re-locking by the now-known id would also
  // be correct, but it adds a second raw statement and a retry path to buy an
  // outcome (a promo created DURING this transaction being honoured by it) that
  // the code never had and nobody has asked for.
  const lockedRowCount =
    await tx.$executeRaw`SELECT 1 FROM "PromoCode" WHERE "code" = ${normalizedCode} FOR UPDATE`;
  const promoCode =
    lockedRowCount > 0
      ? await tx.promoCode.findUnique({ where: { code: normalizedCode } })
      : null;

  if (promoCode?.internal && !allowInternal) {
    throw new BookingPromoError("Promo code not found");
  }

  let assignedMemberIds: string[] | null = null;
  let promoLodges: { lodgeId: string }[] = [];
  if (promoCode) {
    const [assignments, lodgeRows] = await Promise.all([
      tx.promoCodeAssignment.findMany({
        where: { promoCodeId: promoCode.id },
        select: { memberId: true },
      }),
      tx.promoCodeLodge.findMany({
        where: { promoCodeId: promoCode.id },
        select: { lodgeId: true },
      }),
    ]);
    if (assignments.length > 0) {
      assignedMemberIds = assignments.map((a) => a.memberId);
    }
    promoLodges = lodgeRows;
  }

  const guestNightRates = guests.map((guest, index) => ({
    memberId: guest.memberId ?? null,
    isMember: guest.isMember,
    perNightRates: perNightCentsByGuest[index],
    firstNight: guest.stayStart ?? checkIn,
    nightDates: nightDatesByGuest?.[index],
  }));
  const application = await validateAndCalculatePromoDiscount(
    promoCode ? { ...promoCode, lodges: promoLodges } : null,
    {
      memberId: effectiveMemberId,
      bookingCheckIn: checkIn,
      totalPriceCents,
      guests: guestNightRates,
    },
    assignedMemberIds,
    { db: tx, selectedGuestIndexes: promoGuestIndexes, lodgeId, todayAtClub }
  );
  if (application.error || !application.discount) {
    throw new BookingPromoError(application.error ?? "Promo code could not be applied");
  }
  const promoResult = application.discount;

  return {
    discountCents: promoResult.discountCents,
    promoAdjustmentCents: promoResult.priceAdjustmentCents,
    promoFreeNightsUsed: promoResult.freeNightsUsed,
    promoEligibleGuestCount: promoResult.eligibleGuestCount,
    promoAllocations: promoResult.allocations,
    promoSelectedGuestIndexes: application.selectedGuestIndexes,
    promoShouldPersist: shouldPersistPromoRedemption(promoResult),
    promoCodeRecord: promoCode,
  };
}

const PROMO_WORK_PARTY_EXCLUSION_MESSAGE =
  "A promo code cannot be combined with a working bee discount. Please remove one of them and try again.";

/**
 * Resolve the effective promo source for a booking: either the
 * member-entered code or the selected work party event's internal promo.
 * Only one PromoRedemption can exist per booking, so the two are mutually
 * exclusive. Throws BookingPromoError when both are supplied or the event
 * is not bookable for these dates.
 */
export async function resolveEffectivePromoSource(
  db: Parameters<typeof resolveWorkPartyEventPromoForBooking>[0],
  options: {
    promoCodeStr?: string;
    workPartyEventId?: string;
    checkIn: Date;
    checkOut: Date;
    // Lodge the booking is being created at: a lodge-bound working bee
    // only discounts stays at its own lodge.
    lodgeId?: string | null;
  }
): Promise<{ promoCodeStr: string; allowInternal: boolean } | null> {
  if (!options.workPartyEventId && !options.promoCodeStr) {
    return null;
  }

  // Honour the admin module toggles: when a feature is off, its input is ignored
  // (no discount applied) rather than erroring, so a disabled module can never
  // affect pricing even if an id/code reaches this far.
  const modules = await loadEffectiveModuleFlags();
  const workPartyEventId = modules.workParties
    ? options.workPartyEventId
    : undefined;
  const promoCodeStr = modules.promoCodes ? options.promoCodeStr : undefined;

  if (workPartyEventId && promoCodeStr) {
    throw new BookingPromoError(PROMO_WORK_PARTY_EXCLUSION_MESSAGE);
  }
  if (workPartyEventId) {
    const resolution = await resolveWorkPartyEventPromoForBooking(
      db,
      workPartyEventId,
      options.checkIn,
      options.checkOut,
      options.lodgeId
    );
    if (!resolution.ok) {
      throw new BookingPromoError(resolution.error);
    }
    return { promoCodeStr: resolution.promoCodeStr, allowInternal: true };
  }
  if (promoCodeStr) {
    return { promoCodeStr, allowInternal: false };
  }
  return null;
}

/**
 * Remap promo-target guest indexes (which point into the full party guest list)
 * onto a subset of that list. Used when a mixed party is split so the promo,
 * which is applied to the member booking, targets the right member guests.
 * Indexes pointing at guests outside the subset (e.g. non-members) are dropped.
 */
export function remapPromoIndexesToSubset(
  indexes: number[] | undefined,
  allGuests: BookingGuestInput[],
  subset: BookingGuestInput[]
): number[] | undefined {
  if (!indexes) return undefined;
  const subsetIndexByGuest = new Map(subset.map((guest, index) => [guest, index]));
  const remapped = indexes
    .map((index) => allGuests[index])
    .map((guest) => (guest ? subsetIndexByGuest.get(guest) : undefined))
    .filter((index): index is number => index !== undefined);
  return remapped.length > 0 ? remapped : undefined;
}
