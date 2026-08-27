import { BookingStatus, type AgeTier, type SeasonType } from "@prisma/client";
import {
  calculateBookingPrice,
  getStayNights,
  isGroupDiscountApplicable,
  type GroupDiscountConfig,
  type GuestInput,
  type PriceBreakdown,
  type SeasonRateData,
  type UnratedGuestInput,
} from "@/lib/pricing";
import {
  countActiveGuestsForNight,
  type GuestNightInput,
} from "@/lib/booking-guest-stay-ranges";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import type { CalendarDate } from "@/lib/club-time";
import {
  calculateAppliedCreditRestore,
  calculateDualRefundAmounts,
  daysUntilDate,
  type CancellationRule,
} from "./cancellation";

export type { CancellationRule };

export interface GroupDiscountSettingLike {
  enabled: boolean;
  minGroupSize: number;
  summerOnly: boolean;
  // Rate membership type substituted for NON_MEMBER_DEFAULT guests in a
  // qualifying group (#1930, E4). Seeded to the built-in FULL type.
  rateMembershipTypeId?: string | null;
}

/**
 * The same setting, read by an EDIT path, where `applyToEdits` is load-bearing
 * (#2770, INV-MOD-026).
 *
 * It is REQUIRED here rather than optional-with-a-default, and the DIRECTION of
 * the failure it prevents is the point. `toEditTimeGroupDiscountConfig` gates on
 * `!setting?.applyToEdits`, so a row that arrives WITHOUT the field is falsy and
 * the discount is WITHHELD. `GroupDiscountSetting` is already read with a narrow
 * `select` in one place (the public fee-page tokens select
 * `enabled`/`minGroupSize`/`summerOnly` only), so if this field were optional a
 * future narrow select on an edit path would silently withhold a discount the
 * club left ON — money against the member, with nothing failing. Requiring it
 * makes that a typecheck failure instead.
 *
 * `group-discount-section.tsx`'s `data.applyToEdits ?? true` is the deliberate
 * OPPOSITE default, and for a different reason: a UI with no value must show the
 * behaviour actually in force, and the column's own default is ON.
 */
export interface EditTimeGroupDiscountSettingLike
  extends GroupDiscountSettingLike {
  applyToEdits: boolean;
}

export interface SeasonRateSource {
  id: string;
  startDate: Date;
  endDate: Date;
  type?: SeasonType;
  // Membership-type-keyed rate rows (#1930, E4) — the ONLY nightly-rate source.
  // Load from Season.membershipTypeRates. The legacy member/non-member
  // boolean-keyed SeasonRate table and its `rates` relation no longer exist:
  // the #2129 step 2 contract migration
  // 20260721120000_contract_drop_season_rate (Release B) dropped them. Do not
  // reintroduce a boolean member/non-member rate key.
  membershipTypeRates: Array<{
    membershipTypeId: string;
    ageTier: AgeTier | null;
    pricePerNightCents: number;
  }>;
}

export interface GuestPricingSource {
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // Explicit included nights (issue #713). Passed through to pricing so a
  // guest with a non-contiguous stay is priced for exactly those nights.
  nights?: ReadonlyArray<GuestNightInput> | null;
}

/**
 * The group-discount config for a FIRST purchase: booking creation, the public
 * quote, a group booking, a school/booking-request approval, and the waitlist
 * offer reprice that re-bases a booking at current rates before the member
 * confirms. None of those is a later edit to nights somebody already holds, so
 * none of them consults the #2770 switch.
 *
 * An EDIT path must call {@link toEditTimeGroupDiscountConfig} instead, and
 * `group-discount-edit-switch-census.test.ts` fails the build if it does not:
 * the two mappers differ only by one boolean, so nothing in the type system can
 * tell a mistake here from a deliberate choice.
 */
export function toGroupDiscountConfig(
  setting: GroupDiscountSettingLike | null | undefined
): GroupDiscountConfig | undefined {
  if (!setting?.enabled) {
    return undefined;
  }

  return {
    minGroupSize: setting.minGroupSize,
    summerOnly: setting.summerOnly,
    enabled: true,
    rateMembershipTypeId: setting.rateMembershipTypeId ?? null,
  };
}

/**
 * The group-discount config for an EDIT to an existing booking — the ONE place
 * the club's `applyToEdits` switch is applied (#2770, INV-MOD-026).
 *
 * Every edit path resolves its config here: the ordinary planner
 * (`calculateModifiedPricing`), the date-modification service, the guest-add
 * route, the single-guest-removal service, and the modify-quote preview. There
 * is deliberately no second gate anywhere else. The rule the switch exists to
 * protect is that no edit path can price a night differently from another
 * (#2756 was one planner reading a different config from the rest), and one
 * chokepoint is the only shape that keeps that true as paths are added.
 *
 * Returning `undefined` when the switch is off is what makes an off club price
 * byte-identically to a club with the discount disabled: it is the same absent
 * config, down the same code path, not a second discount rule with a zero rate.
 * Nights a guest already bought are untouched in both states — they carry their
 * stored `BookingGuestNight.priceCents` as locked prices (INV-MOD-005), which
 * pricing honours regardless of any config passed here.
 */
export function toEditTimeGroupDiscountConfig(
  setting: EditTimeGroupDiscountSettingLike | null | undefined
): GroupDiscountConfig | undefined {
  if (!setting?.applyToEdits) {
    return undefined;
  }

  return toGroupDiscountConfig(setting);
}

/**
 * What a member or officer is told when the club runs a group discount, has
 * switched it off for later edits, AND this particular edit would otherwise have
 * been discounted (#2770 D2, INV-MOD-026).
 *
 * The switch half is derived FROM the mapper rather than from a second reading of
 * the column, on purpose: the quote can then never say "these nights are not
 * discounted" while the same request discounts them, or stay silent while it
 * does not. One condition, one answer, quote and charge in lockstep (#1095).
 *
 * The STAY half is what keeps the note honest. D2 asked for a line that explains
 * a number that went up, so a note beside a number that did not go up is worse
 * than no note: an officer editing a two-guest booking at a `minGroupSize: 5`
 * club, or a winter stay at a `summerOnly` club, would read that the discount was
 * withheld from a price that would have been identical with the switch on, and
 * conclude the switch was why. So the same proposed stay is put to
 * `isGroupDiscountAppliedToBooking` under the UNGATED config, and the note is
 * returned only if that says yes. This is the one other place
 * `toGroupDiscountConfig` is called for an edit, and it is deliberately here
 * rather than in the route: the caller cannot then reach the ungated config, so
 * the switch still cannot be worked around, and the census still finds exactly
 * one file that turns `applyToEdits` into a pricing decision.
 *
 * `null` in the other states, because none has anything to explain: a club with
 * no group discount is not withholding one, and a club whose switch is on is
 * giving it.
 *
 * The stay it judges is the PROPOSED post-edit stay and party, which is what the
 * route is quoting. It is therefore a statement about the edit, not about which
 * individual night moved.
 */
export const GROUP_DISCOUNT_EDIT_OFF_NOTICE =
  "Group discount does not apply to nights added after booking. Nights already booked keep the price they were booked at.";

export function groupDiscountEditNotice(
  setting: EditTimeGroupDiscountSettingLike | null | undefined,
  stay: {
    checkIn: Date;
    checkOut: Date;
    guests: UnratedGuestInput[];
    seasons: SeasonRateData[];
  }
): string | null {
  if (!setting?.enabled) {
    return null;
  }
  if (toEditTimeGroupDiscountConfig(setting)) {
    return null;
  }
  return isGroupDiscountAppliedToBooking({
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    guestCount: stay.guests.length,
    guests: stay.guests,
    seasons: stay.seasons,
    groupDiscount: toGroupDiscountConfig(setting),
  })
    ? GROUP_DISCOUNT_EDIT_OFF_NOTICE
    : null;
}

/**
 * The ONE mapper from loaded `Season` rows to the shape every pricing pass reads.
 *
 * **It is the only one on purpose, and `type` is why (#2756).** The group
 * discount's `summerOnly` flag — `true` by `prisma/schema.prisma`'s own default,
 * by `DEFAULT_GROUP_DISCOUNT_SETTING`, and by the admin section's default — makes
 * `isGroupDiscountApplicable` test `findSeasonForDate(night, seasons)?.type ===
 * "SUMMER"`. `SeasonRateData.type` is OPTIONAL, because a caller that never
 * configures a discount has no use for it, so a mapping that simply omits the
 * field compiles silently, throws nothing, fails no test — and turns the discount
 * OFF for every summer-only club, on whichever paths use that mapping.
 *
 * That is exactly what had happened: creation, the quote route, booking requests,
 * group and school bookings and the waitlist reprice all came through here and
 * carried `type`, while all five EDIT paths hand-rolled their own four-key literal
 * without it. So a club on the default setting had its booking discounted when it
 * was made and every later edit priced at the full rate — INV-MOD-006's parity
 * claim was false for the most likely real configuration, and the money ran
 * against the member. Route new season loads through this function rather than
 * mapping them again; `in-progress-edit-sold-price-census.test.ts` fails a second
 * production mapper, because the type system cannot.
 */
export function toSeasonRateData(seasons: SeasonRateSource[]): SeasonRateData[] {
  return seasons.map((season) => ({
    seasonId: season.id,
    startDate: season.startDate,
    endDate: season.endDate,
    type: season.type,
    rates: season.membershipTypeRates.map((rate) => ({
      membershipTypeId: rate.membershipTypeId,
      ageTier: rate.ageTier,
      pricePerNightCents: rate.pricePerNightCents,
    })),
  }));
}

export function toGuestPricingInputs(
  guests: GuestPricingSource[],
): UnratedGuestInput[] {
  return guests.map((guest) => ({
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? undefined,
    stayStart: guest.stayStart ?? undefined,
    stayEnd: guest.stayEnd ?? undefined,
    nights: guest.nights ?? undefined,
  }));
}

export function priceBookingGuests(input: {
  checkIn: Date;
  checkOut: Date;
  guests: GuestInput[];
  seasons: SeasonRateData[];
  groupDiscount?: GroupDiscountConfig;
}): PriceBreakdown {
  return calculateBookingPrice(
    input.checkIn,
    input.checkOut,
    input.guests,
    input.seasons,
    input.groupDiscount
  );
}

/**
 * Price the deferred non-member "guest portion" (#2003) — the SINGLE server
 * function both the booking quote and booking-create use for the split child.
 *
 * A split party (#738) charges the member places up front and defers the
 * non-member guests to a provisional linked child; that child's
 * `finalPriceCents` is booking-create pricing the NON-MEMBER SUBSET ALONE. This
 * function reproduces exactly that: filter to the non-members, then price them
 * with `priceBookingGuestsWithMembershipTypePolicy` in the same call shape
 * booking-create uses (no `ownerMemberId`; the same `groupDiscount`).
 *
 * Why the subset — not the whole party — is the source of truth: the group
 * discount only substitutes a cheaper rate when ENOUGH ACTIVE GUESTS share a
 * night (`isGroupDiscountApplicable` / `countActiveGuestsForNight`). The
 * non-member subset can fall UNDER `minGroupSize` even when the whole party
 * meets it, so the whole party's non-member rows can be group-discounted while
 * the subset the child is actually charged is not. Summing the whole-party
 * non-member rows for the review banner therefore UNDER-QUOTES the deferred
 * charge under group discounts (the surprise direction). Pricing the subset
 * here — the same input booking-create charges — is what makes the review
 * banner equal the real charge.
 *
 * Returns null when the party has no non-member guests (nothing is deferred);
 * otherwise the subset's server `PriceBreakdown` (money in integer cents). This
 * is a pure pricing read — it performs no writes.
 */
export async function priceDeferredNonMemberPortion(
  db: unknown,
  input: {
    checkIn: Date;
    checkOut: Date;
    guests: readonly GuestPricingSource[];
    seasons: SeasonRateData[];
    groupDiscount?: GroupDiscountConfig;
  }
): Promise<PriceBreakdown | null> {
  const nonMemberGuests = input.guests.filter((guest) => !guest.isMember);
  if (nonMemberGuests.length === 0) {
    return null;
  }
  return priceBookingGuestsWithMembershipTypePolicy(db, {
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guests: toGuestPricingInputs(nonMemberGuests),
    seasons: input.seasons,
    groupDiscount: input.groupDiscount,
  });
}

export function isGroupDiscountAppliedToBooking(input: {
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  // Only stay ranges are read (via countActiveGuestsForNight), so unrated
  // guests are accepted — the rate membership type is irrelevant here.
  guests?: UnratedGuestInput[];
  seasons: SeasonRateData[];
  groupDiscount?: GroupDiscountConfig;
}): boolean {
  const { checkIn, checkOut, guestCount, guests, seasons, groupDiscount } = input;
  if (!groupDiscount?.enabled) {
    return false;
  }

  if (guests) {
    return getStayNights(checkIn, checkOut).some((night) =>
      isGroupDiscountApplicable(
        countActiveGuestsForNight(guests, night, { checkIn, checkOut }),
        night,
        seasons,
        groupDiscount
      )
    );
  }

  if (guestCount < groupDiscount.minGroupSize) return false;
  if (!groupDiscount.summerOnly) {
    return true;
  }

  return seasons.some(
    (season) =>
      season.type === "SUMMER" &&
      season.startDate < checkOut &&
      season.endDate >= checkIn
  );
}

function calculateHoldDaysUntilCheckIn(
  checkIn: Date,
  now: Date = new Date()
): number {
  // Math.ceil keeps any fractional day over the threshold pending; cancellation
  // refund tier lookups deliberately use floor semantics instead.
  return Math.ceil(
    (checkIn.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );
}

export function calculateBookingHoldDecision(input: {
  hasNonMembers: boolean;
  checkIn: Date;
  holdDays: number;
  holdEnabled?: boolean;
  now?: Date;
}): {
  daysUntilCheckIn: number;
  holdEnabled: boolean;
  shouldBePending: boolean;
  status: BookingStatus;
} {
  const daysUntilCheckIn = calculateHoldDaysUntilCheckIn(input.checkIn, input.now);
  const holdEnabled = input.holdEnabled ?? true;
  const shouldBePending =
    holdEnabled && input.hasNonMembers && daysUntilCheckIn > input.holdDays;

  return {
    daysUntilCheckIn,
    holdEnabled,
    shouldBePending,
    status: shouldBePending ? BookingStatus.PENDING : BookingStatus.PAYMENT_PENDING,
  };
}

export function calculateBookingCreditApplication(input: {
  requestedCreditCents: number;
  creditBalanceCents: number;
  finalPriceCents: number;
  status: BookingStatus;
}): {
  creditAppliedCents: number;
  effectivePriceCents: number;
} {
  const { requestedCreditCents, creditBalanceCents, finalPriceCents, status } = input;
  if (requestedCreditCents <= 0 || status !== BookingStatus.PAYMENT_PENDING) {
    return {
      creditAppliedCents: 0,
      effectivePriceCents: finalPriceCents,
    };
  }

  if (requestedCreditCents > creditBalanceCents) {
    throw new Error(
      `Insufficient credit: ${creditBalanceCents} cents available, ${requestedCreditCents} requested`
    );
  }
  if (requestedCreditCents > finalPriceCents) {
    throw new Error(
      `Credit amount (${requestedCreditCents}) exceeds booking price (${finalPriceCents})`
    );
  }

  return {
    creditAppliedCents: requestedCreditCents,
    effectivePriceCents: finalPriceCents - requestedCreditCents,
  };
}

export function calculateCancellationPreview(input: {
  payment: {
    amountCents: number;
    refundedAmountCents: number;
    changeFeeCents: number;
    creditAppliedCents?: number | null;
  };
  finalPriceCents: number;
  checkIn: Date;
  policyRules: CancellationRule[];
  /**
   * The club's own calendar day, resolved by the caller (#3123).
   *
   * REQUIRED, and a `CalendarDate` rather than an instant. This preview is what
   * a member is shown before they confirm a cancellation, so the tier it names
   * has to be the tier the executed cancel will apply — and `daysUntilDate`
   * below is the refund-tier boundary. The old `now?: Date` defaulted through
   * `new Date()` into a projection through `APP_TIME_ZONE`, so a club whose
   * configured zone differs from its container's previewed a different tier from
   * the one it charged. `INV-CONFIG-002` says which zone answers "today";
   * `docs/CLUB_TIME_KERNEL.md` says an instant has no calendar day until one is
   * supplied, which is why this parameter cannot be an instant.
   */
  todayAtClub: CalendarDate;
}): {
  refundAmountCents: number;
  keptAmountCents: number;
  changeFeeCents: number;
  refundPercentage: number;
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
  creditRestoredCents: number;
  totalPaidCents: number;
} {
  const paidAmountCents =
    input.payment.amountCents - input.payment.refundedAmountCents;
  const changeFeeCents = input.payment.changeFeeCents;
  // Same refundable-base cap as cancelBooking (#1031): the preview must not
  // promise a refund the stale Payment mirror can no longer back.
  const refundableBaseCents =
    Math.min(paidAmountCents, input.finalPriceCents + changeFeeCents) -
    changeFeeCents;
  const days = daysUntilDate(input.checkIn, input.todayAtClub);
  const {
    cardRefundAmountCents,
    cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
  } = calculateDualRefundAmounts(refundableBaseCents, days, input.policyRules);

  return {
    refundAmountCents: cardRefundAmountCents,
    keptAmountCents: paidAmountCents - cardRefundAmountCents,
    changeFeeCents,
    refundPercentage: cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
    // Applied-credit slice is tiered by the SAME card tier as the card slice
    // (#1164 / D7), no longer restored at 100%. Fed the same refundableBaseCents
    // and days so preview == actual cancel.
    creditRestoredCents: calculateAppliedCreditRestore(
      input.payment.creditAppliedCents ?? 0,
      refundableBaseCents,
      days,
      input.policyRules,
    ).creditRestoredCents,
    totalPaidCents: paidAmountCents,
  };
}
