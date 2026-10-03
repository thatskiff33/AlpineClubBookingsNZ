/**
 * Promo/pricing resolution helpers for the booking-creation service.
 *
 * Extracted verbatim from `booking-create.ts`. Depends only on the shared
 * `booking-create-types` module, never on the orchestrator, to avoid an import
 * cycle.
 */
import type { BookingGuest, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CalendarDate } from "@/lib/club-time";
import type { PromoAdjustmentTarget } from "@/lib/night-adjustment-write";
import {
  GUEST_SELECTION_REQUIRED_MESSAGE,
  lockPromoCodeRowsForUpdate,
  promoLodgeRestrictionRefusal,
  shouldPersistPromoRedemption,
  validatePromoCodeRules,
  type PromoBeneficiaryAllocation,
} from "@/lib/promo";
import { applyBookingPromotions } from "@/lib/booking-promotions";
import { guestConsentStatus } from "@/lib/member-guest-consent";
import {
  assignmentRequiresAssignedBooker,
  assignmentRequiresGuestSelection,
} from "@/lib/promo-guest-scope";
import { resolveWorkPartyEventPromoForBooking } from "@/lib/work-party";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { normalizePromoCodeInput, promoCodeListRefusal } from "@/lib/promo-code-list-rules";
import { type BookingGuestInput, BookingPromoError } from "./booking-create-types";

/** One promo code a create request carries, in the booker's order (D-3813-2). */
export interface PromoCodeRequest {
  code: string;
  /** Guest positions the booker chose for a booker-picks-guests code. */
  promoGuestIndexes?: number[];
}

/** A code to apply at create: a typed code, or the working bee's internal one. */
export interface EffectivePromoSource {
  promoCodeStr: string;
  allowInternal: boolean;
  promoGuestIndexes?: number[];
}

/** What one applied code will persist as its `PromoRedemption`. */
export interface ResolvedPromoRedemption {
  promoCodeId: string;
  /** The code's place in the booking's order (D-3813-2; work party first, D-3813-3). */
  applicationOrder: number;
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number;
  eligibleGuestCount: number;
  allocations: PromoBeneficiaryAllocation[];
  selectedGuestIndexes?: number[];
}

/**
 * Every code a create applies, priced together (#3827). Totals are the sum over
 * the codes, each its own integer cents; `redemptions` holds only the codes
 * that persist a row (`shouldPersistPromoRedemption`).
 */
export interface ResolvedPromotions {
  discountCents: number;
  promoAdjustmentCents: number;
  /** #3276: what each code took off each night or guest, by guest index, naming its code. */
  promoAdjustmentTargets: PromoAdjustmentTarget[];
  redemptions: ResolvedPromoRedemption[];
}

export const NO_PROMOTIONS: ResolvedPromotions = Object.freeze({
  discountCents: 0,
  promoAdjustmentCents: 0,
  promoAdjustmentTargets: [],
  redemptions: [],
}) as ResolvedPromotions;

/**
 * The codes a create request carries, in order: the plural `promoCodes` when
 * sent, else the legacy single `promoCode` with its guest choice (#3827 keeps
 * the legacy field accepted).
 */
export function promoCodeRequestsOf(input: {
  promoCodes?: PromoCodeRequest[];
  promoCodeStr?: string;
  promoGuestIndexes?: number[];
}): PromoCodeRequest[] {
  if (input.promoCodes) return input.promoCodes;
  return input.promoCodeStr
    ? [{ code: input.promoCodeStr, promoGuestIndexes: input.promoGuestIndexes }]
    : [];
}

/**
 * Map selected guest indexes to booking-guest ids, for the booking-CREATE path.
 *
 * There is a second form of this on the booking-MODIFICATION path —
 * `targetBookingGuestIdsForSelectedIndexes` in `promo-stored-guest-targets.ts`,
 * which #3131 converged five copies into. The two are the same algorithm and
 * differ in exactly one thing: which key the index is read through. Here it is
 * `BookingGuest.id`; there it is a rate row's `bookingGuestId`.
 *
 * They were deliberately NOT unified (#3163). That was the recommended default,
 * taken by an orchestrator session under the owner's 30 Aug 2026 instruction to
 * proceed autonomously and record decisions for later review — it is NOT an
 * owner decision read at source, and it stands only until the owner says
 * otherwise. `INV-SSOT-001` permits a second *form* of one fact and warns
 * against contorting a helper to serve two shapes, and the accessor argument
 * that would unify these is exactly that contortion, bought on the
 * booking-create money path for no behaviour change.
 *
 * **So if you change what this does, change the other one too.** That is the
 * cost of the decision, and it is why these two point at each other rather than
 * relying on someone remembering.
 */
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
 * Resolve, price and validate every code a create applies (#3827), in the
 * order `resolveEffectivePromoSources` gave — through the one orchestrator
 * (`applyBookingPromotions`), so a create prices several codes exactly as every
 * edit re-prices them. Throws BookingPromoError on the first refusal so the
 * caller rolls back and returns a 400.
 *
 * LOCKS (`lockRows`, the in-transaction creates): the code rows are resolved
 * to ids UNLOCKED, locked in ONE sorted call (`lockPromoCodeRowsForUpdate`),
 * then re-read by id under the lock. A row whose `code` no longer reads as
 * typed — renamed between the two reads — is refused as "Promo code not found",
 * the outcome the former code-keyed `FOR UPDATE` gave when its lock matched
 * nothing; a code created or renamed TO the typed text after the unlocked read
 * is likewise not found. The caller holds `pg_advisory_xact_lock(1)` and the
 * per-lodge capacity key, so the order is lodge -> promo rows, sorted by id.
 * The waitlisted create prices before its transaction and passes
 * `lockRows: false`, as it always read the code unlocked.
 *
 * Internal promos (work party events) are rejected like unknown codes unless
 * the source came from the work-party resolution.
 */
export async function resolvePromotionsInTransaction(
  db: Prisma.TransactionClient,
  options: {
    sources: readonly EffectivePromoSource[];
    lockRows: boolean;
    effectiveMemberId: string;
    checkIn: Date;
    guests: BookingGuestInput[];
    totalPriceCents: number;
    perNightCentsByGuest: number[][];
    /** #3276: REQUIRED, so an adjustment row can be attributed to a night by date. */
    nightDatesByGuest: Date[][];
    lodgeId: string;
    /**
     * The club's own calendar day (#3123, `INV-CONFIG-002`), resolved by the
     * caller BEFORE it opened the transaction whose client arrives as `db`.
     *
     * REQUIRED. `INV-LOCK-004` names the club timezone as one of only two reads
     * that cannot take a transaction client; by this point the caller holds
     * `pg_advisory_xact_lock(1)`, the per-lodge capacity key and the promo row
     * locks. It decides each promotion's validity window, which is whether the
     * member gets the discount at all.
     */
    todayAtClub: CalendarDate;
  },
): Promise<ResolvedPromotions> {
  const { sources, guests, perNightCentsByGuest, nightDatesByGuest } = options;
  if (sources.length === 0) return NO_PROMOTIONS;
  const typed = sources.map((source) => normalizePromoCodeInput(source.promoCodeStr));

  // LOCK RAW, READ TYPED (#2289), keyed on the IMMUTABLE id (#3827): resolve,
  // lock in sorted-id order, re-read under the lock. See the docblock.
  const resolvedIds = await db.promoCode.findMany({
    where: { code: { in: typed } },
    select: { id: true, code: true },
  });
  if (options.lockRows) {
    await lockPromoCodeRowsForUpdate(db, resolvedIds.map((row) => row.id));
  }
  const rows = resolvedIds.length
    ? await db.promoCode.findMany({ where: { id: { in: resolvedIds.map((row) => row.id) } } })
    : [];
  const [assignmentRows, lodgeRows] = rows.length
    ? await Promise.all([
        db.promoCodeAssignment.findMany({
          where: { promoCodeId: { in: rows.map((row) => row.id) } },
          select: { promoCodeId: true, memberId: true },
        }),
        db.promoCodeLodge.findMany({
          where: { promoCodeId: { in: rows.map((row) => row.id) } },
          select: { promoCodeId: true, lodgeId: true },
        }),
      ])
    : [[], []];

  const applications = sources.map((source, index) => {
    const code = typed[index]!;
    const id = resolvedIds.find((row) => row.code === code)?.id;
    const promoCode = rows.find((row) => row.id === id && row.code === code) ?? null;
    const hidden = promoCodeVisibilityRefusal(promoCode, source.allowInternal);
    if (hidden) throw new BookingPromoError(hidden);
    if (!promoCode) throw new BookingPromoError("Promo code not found");
    const assignments = assignmentRows.filter((row) => row.promoCodeId === promoCode.id);
    return {
      code: promoCode.code,
      promoCode: {
        ...promoCode,
        lodges: lodgeRows
          .filter((row) => row.promoCodeId === promoCode.id)
          .map((row) => ({ lodgeId: row.lodgeId })),
      },
      assignedMemberIds: assignments.length > 0 ? assignments.map((row) => row.memberId) : null,
      selectedGuestIndexes: source.promoGuestIndexes,
      capOverflow: "reject" as const,
    };
  });

  // Each guest's own per-night rates, read once. The caller builds this vector
  // for exactly this party, so a guest with no rates would be a promo evaluated
  // against nothing — refused rather than discounted on a guess (#2800).
  const guestNightRates = guests.map((guest, index) => {
    const perNightRates = perNightCentsByGuest[index];
    if (perNightRates === undefined) {
      throw new Error(
        `Promo evaluation has no per-night rates for guest ${index + 1} of ${guests.length} (#3167).`,
      );
    }
    return {
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates,
      firstNight: guest.stayStart ?? options.checkIn,
      nightDates: nightDatesByGuest[index],
      // D-3813-4: the consent this row is about to be created with. A
      // cross-family guest added as PENDING takes no code until they accept.
      consentStatus: guestConsentStatus(guest),
    };
  });
  const priced = await applyBookingPromotions(applications, {
    memberId: options.effectiveMemberId,
    bookingCheckIn: options.checkIn,
    totalPriceCents: options.totalPriceCents,
    guests: guestNightRates,
    db,
    lodgeId: options.lodgeId,
    todayAtClub: options.todayAtClub,
  });

  const redemptions: ResolvedPromoRedemption[] = [];
  for (const { application, applicationOrder, result } of priced.outcomes) {
    if (result.error || !result.discount) {
      throw new BookingPromoError(result.error ?? "Promo code could not be applied");
    }
    const discount = result.discount;
    if (!shouldPersistPromoRedemption(discount)) continue;
    redemptions.push({
      promoCodeId: application.promoCode.id,
      applicationOrder,
      discountCents: discount.discountCents,
      priceAdjustmentCents: discount.priceAdjustmentCents,
      freeNightsUsed: discount.freeNightsUsed,
      eligibleGuestCount: discount.eligibleGuestCount,
      allocations: discount.allocations,
      selectedGuestIndexes: result.selectedGuestIndexes,
    });
  }
  return {
    discountCents: priced.discountCents,
    promoAdjustmentCents: priced.priceAdjustmentCents,
    promoAdjustmentTargets: priced.adjustmentTargets,
    redemptions,
  };
}

/**
 * The codes a create REQUEST carries, in the booker's order (#3827): the plural
 * `promoCodes` sorted by each entry's `order` — the list's own order where an
 * entry gives none, and between equals — or the legacy single code with its
 * guest choice.
 */
export function orderedPromoCodeRequests(body: {
  promoCodes?: Array<PromoCodeRequest & { order?: number }>;
  promoCodeStr?: string;
  promoGuestIndexes?: number[];
}): PromoCodeRequest[] {
  if (!body.promoCodes) return promoCodeRequestsOf(body);
  return body.promoCodes
    .map((entry, position) => ({ entry, position }))
    .sort(
      (a, b) =>
        (a.entry.order ?? a.position) - (b.entry.order ?? b.position) ||
        a.position - b.position,
    )
    .map(({ entry }) => ({
      code: entry.code,
      ...(entry.promoGuestIndexes ? { promoGuestIndexes: entry.promoGuestIndexes } : {}),
    }));
}

// The stored spelling of a typed code and the code-list refusals live in the
// leaf `promo-code-list-rules.ts` (#3827), re-exported here for this module's
// importers.
export {
  DUPLICATE_PROMO_CODE_MESSAGE,
  normalizePromoCodeInput,
  ONE_PROMO_CODE_PER_BOOKING_MESSAGE,
} from "@/lib/promo-code-list-rules";

/**
 * An internal (working-bee) code is "not found" to anyone who typed it; only the
 * working-bee path may redeem one. The one spelling of that rule (#3770).
 */
export function promoCodeVisibilityRefusal(
  promoCode: { internal: boolean } | null,
  allowInternal: boolean,
): string | null {
  return promoCode?.internal && !allowInternal ? "Promo code not found" : null;
}

/**
 * The refusal a promo code earns from the REQUEST and the BOOKER alone, or null
 * (#3770).
 *
 * The create route asks this before its member lookup, so the answer is the same
 * whether a member id in the party is real or not. It is a pre-check, not the
 * decision: {@link resolvePromoInTransaction} re-reads the code under its row
 * lock and refuses authoritatively. Its order is the application's
 * (`validateAndCalculatePromoDiscount`): visibility, existence, the lodge, the
 * missing guest selection, then the rules. Left to the services, because they
 * read the priced, resolved party: which selected guests may use the code and
 * how many may, whether an assigned member is staying, and every usage cap (the
 * booker is a beneficiary only when the priced party selects somebody).
 */
export async function promoCodeRequestRefusal(options: {
  promoCodeStr: string;
  allowInternal: boolean;
  memberId: string;
  checkIn: Date;
  lodgeId: string;
  promoGuestIndexes?: number[];
  todayAtClub: CalendarDate;
}): Promise<string | null> {
  const promoCode = await prisma.promoCode.findUnique({
    where: { code: normalizePromoCodeInput(options.promoCodeStr) },
    include: {
      assignments: { select: { memberId: true } },
      lodges: { select: { lodgeId: true } },
    },
  });
  const hidden = promoCodeVisibilityRefusal(promoCode, options.allowInternal);
  if (hidden || !promoCode) return hidden ?? "Promo code not found";
  const lodgeRefusal = promoLodgeRestrictionRefusal(promoCode, options.lodgeId);
  if (lodgeRefusal) return lodgeRefusal;
  const assignedMemberIds = promoCode.assignments.length
    ? promoCode.assignments.map((assignment) => assignment.memberId)
    : null;
  if (
    assignmentRequiresGuestSelection(promoCode, assignedMemberIds) &&
    (options.promoGuestIndexes?.length ?? 0) === 0
  ) {
    return GUEST_SELECTION_REQUIRED_MESSAGE;
  }
  return validatePromoCodeRules(
    promoCode,
    { memberId: options.memberId, bookingCheckIn: options.checkIn },
    options.todayAtClub,
    { capsResolvedByBeneficiaryTrim: true },
    // "Not assigned to you" reads only the booker when the code needs an
    // assigned booker; the application passes the same expression.
    assignmentRequiresAssignedBooker(promoCode, assignedMemberIds)
      ? assignedMemberIds
      : null,
    options.lodgeId,
  );
}

/**
 * Resolve the codes a create applies, in order (#3827): the selected working
 * bee's internal promo first — it claims its in-window nights before any code
 * (D-3813-3) — then the member's codes in the order they chose (D-3813-2).
 *
 * While the club's `multiPromoCodes` switch is off a booking still holds ONE
 * code (#3826), so a second source is refused here in words the member reads —
 * the working bee keeps its own exclusion sentence — before
 * `redeemPromoCode`'s backstop could refuse it less helpfully. Throws
 * BookingPromoError when the event is not bookable for these dates.
 */
export async function resolveEffectivePromoSources(
  db: Parameters<typeof resolveWorkPartyEventPromoForBooking>[0],
  options: {
    promoCodes: readonly PromoCodeRequest[];
    workPartyEventId?: string;
    checkIn: Date;
    checkOut: Date;
    // Lodge the booking is being created at: a lodge-bound working bee
    // only discounts stays at its own lodge.
    lodgeId?: string | null;
  }
): Promise<EffectivePromoSource[]> {
  if (!options.workPartyEventId && options.promoCodes.length === 0) {
    return [];
  }

  // Honour the admin module toggles: when a feature is off, its input is ignored
  // (no discount applied) rather than erroring, so a disabled module can never
  // affect pricing even if an id/code reaches this far.
  const modules = await loadEffectiveModuleFlags();
  const workPartyEventId = modules.workParties
    ? options.workPartyEventId
    : undefined;
  const promoCodes = modules.promoCodes
    ? options.promoCodes.filter((request) => request.code.trim().length > 0)
    : [];

  const listRefusal = promoCodeListRefusal({
    typedCodes: promoCodes.map((request) => normalizePromoCodeInput(request.code)),
    workPartyApplied: Boolean(workPartyEventId),
    multiPromoCodes: modules.multiPromoCodes,
  });
  if (listRefusal) throw new BookingPromoError(listRefusal);
  const sources: EffectivePromoSource[] = [];
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
    sources.push({ promoCodeStr: resolution.promoCodeStr, allowInternal: true });
  }
  for (const request of promoCodes) {
    sources.push({
      promoCodeStr: request.code,
      allowInternal: false,
      ...(request.promoGuestIndexes ? { promoGuestIndexes: request.promoGuestIndexes } : {}),
    });
  }
  return sources;
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
