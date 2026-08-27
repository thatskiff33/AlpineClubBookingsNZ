import type { PromoCodeType } from "@prisma/client";
import {
  selectPromoDiscountGuests,
  type PromoCodeInput,
  type PromoDiscountGuest,
} from "@/lib/pricing";

// Who a promotion reaches on a booking, before any question of price or cap.
//
// Split out of `promo.ts` unchanged (#3128). Three related questions, answered
// purely: which ASSIGNMENT mode a code is in and what that mode demands of the
// booker; which of the booking's guests are in scope, including the ones the
// booker picked; and which members would therefore benefit.
//
// Every function here is synchronous and side-effect free — no database, no
// clock, no zone — which is why it could leave `promo.ts`. What it produces is
// the candidate list the cap arithmetic then trims and pricing then charges.

export function hasAssignedMembers(assignedMemberIds: string[] | null | undefined) {
  return Boolean(assignedMemberIds && assignedMemberIds.length > 0);
}

function assignedMembersOnlyOwnNights(
  promoCode: { assignedMembersOnlyOwnNights?: boolean | null }
) {
  return promoCode.assignedMembersOnlyOwnNights ?? true;
}

/**
 * A fixed-nightly "group" promo prices the whole booking at the configured
 * nightly rate. When assigned to members it stays group-scoped: every eligible
 * guest-night is repriced (members and non-members), the booker is the
 * beneficiary of record, and the booker must be one of the assigned members.
 * It does not scope the discount to the assigned members' own nights, nor ask
 * the booker to pick guests.
 *
 * Gated on assignedMembersOnlyOwnNights === false so an admin can still choose
 * own-night scoping for a fixed-nightly code. member-guests-only fixed-nightly
 * codes are excluded (they always scope to assigned member guests).
 */
function isFixedNightlyGroupPromo(promoCode: {
  type?: PromoCodeType | string | null;
  memberGuestsOnly?: boolean | null;
  assignedMembersOnlyOwnNights?: boolean | null;
}) {
  return (
    promoCode.type === "FIXED_NIGHTLY_PRICE" &&
    !promoCode.memberGuestsOnly &&
    !assignedMembersOnlyOwnNights(promoCode)
  );
}

export function scopedAssignmentMemberIds(
  promoCode: { assignedMembersOnlyOwnNights?: boolean | null },
  assignedMemberIds: string[] | null | undefined
) {
  return assignedMembersOnlyOwnNights(promoCode) ? assignedMemberIds : null;
}

export function assignmentRequiresGuestSelection(
  promoCode: {
    type?: PromoCodeType | string | null;
    memberGuestsOnly?: boolean | null;
    assignedMembersOnlyOwnNights?: boolean | null;
  },
  assignedMemberIds: string[] | null | undefined
) {
  // Group fixed-nightly codes price every eligible guest automatically, so the
  // booker never picks guests even though own-night scoping is off.
  if (isFixedNightlyGroupPromo(promoCode)) return false;
  return hasAssignedMembers(assignedMemberIds) && !assignedMembersOnlyOwnNights(promoCode);
}

/**
 * Whether the booker must be one of the assigned members. True for the two
 * non-own-night assignment modes: "booker picks guests" (per-guest selection)
 * and "group" fixed-nightly pricing. Own-night scoping leaves this false so any
 * booker can use the code as long as an assigned member is staying.
 */
export function assignmentRequiresAssignedBooker(
  promoCode: {
    type?: PromoCodeType | string | null;
    memberGuestsOnly?: boolean | null;
    assignedMembersOnlyOwnNights?: boolean | null;
  },
  assignedMemberIds: string[] | null | undefined
) {
  if (!hasAssignedMembers(assignedMemberIds)) return false;
  return (
    assignmentRequiresGuestSelection(promoCode, assignedMemberIds) ||
    isFixedNightlyGroupPromo(promoCode)
  );
}

export function scopeGuestsForAssignedMembers(
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null | undefined
) {
  if (!hasAssignedMembers(assignedMemberIds)) return guests;

  const assigned = new Set(assignedMemberIds);
  return guests.filter((guest) => Boolean(guest.memberId && assigned.has(guest.memberId)));
}

export function selectablePromoGuestIndexes(
  promo: { memberGuestsOnly?: boolean | null },
  guests: PromoDiscountGuest[]
) {
  return guests
    .map((guest, index) => ({ guest, index }))
    .filter(({ guest }) => guest.perNightRates.length > 0)
    .filter(({ guest }) => !promo.memberGuestsOnly || guest.isMember)
    .map(({ index }) => index);
}

export function normalizeSelectedGuestIndexes(
  selectedGuestIndexes: number[] | undefined,
  guestCount: number
): { indexes: number[]; error?: string } {
  if (!selectedGuestIndexes) {
    return { indexes: [] };
  }

  const indexes: number[] = [];
  const seen = new Set<number>();
  for (const index of selectedGuestIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= guestCount) {
      return { indexes: [], error: "Selected promo guest is not on this booking" };
    }
    if (!seen.has(index)) {
      seen.add(index);
      indexes.push(index);
    }
  }
  indexes.sort((a, b) => a - b);
  return { indexes };
}

export function filterGuestsByIndexes(guests: PromoDiscountGuest[], indexes: number[]) {
  return indexes.map((index) => guests[index]).filter(Boolean);
}

function selectPromoBeneficiaryGuests(
  promo: PromoCodeInput,
  guests: PromoDiscountGuest[],
  protectedMemberIds?: ReadonlySet<string> | null
) {
  const selectedGuests = selectPromoDiscountGuests(promo, guests, protectedMemberIds);
  if (promo.type !== "FIXED_NIGHTLY_PRICE") {
    return selectedGuests;
  }

  const fixedNightlyPriceCents = promo.fixedNightlyPriceCents ?? 0;
  if (fixedNightlyPriceCents <= 0) return [];

  if ((promo.fixedNightlyMode ?? "CAP_ONLY") === "CAP_ONLY") {
    return selectedGuests.filter(({ guest }) =>
      guest.perNightRates.some((rate) => rate > fixedNightlyPriceCents)
    );
  }

  return selectedGuests.filter(({ guest }) => guest.perNightRates.length > 0);
}

/**
 * Who a promotion would benefit on this booking.
 *
 * `protectedMemberIds` (#2390) keeps a member who already holds the discount on
 * the booking being repriced ahead of the `maxGuestsPerBooking` cut, so an
 * expensive newly-added guest cannot take their slot. See
 * `selectPromoDiscountGuests`.
 */
export function getPromoBeneficiaryMemberIds(
  promo: PromoCodeInput,
  bookingMemberId: string,
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null = null,
  protectedMemberIds?: ReadonlySet<string> | null
): string[] {
  const scopedGuests = scopeGuestsForAssignedMembers(guests, assignedMemberIds);
  const selectedGuests = selectPromoBeneficiaryGuests(promo, scopedGuests, protectedMemberIds);
  if (selectedGuests.length === 0) return [];

  if (!hasAssignedMembers(assignedMemberIds)) {
    return [bookingMemberId];
  }

  return [...new Set(
    selectedGuests
      .map(({ guest }) => guest.memberId)
      .filter((memberId): memberId is string => Boolean(memberId))
  )];
}
