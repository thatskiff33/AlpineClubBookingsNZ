import type { AgeTier } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getDefaultLodgeId } from "@/lib/lodges";
import type { NormalizedBookingGuestStayRange } from "@/lib/booking-guest-stay-range-input";
import { resolveModificationStayRanges, resolvedAddedGuestRange } from "@/lib/booking-modification-stay-ranges";
import { changeRequestProposalBatchInput } from "@/lib/booking-change-request-stored";
import { mergeChangeRequestGuests, type ChangeRequestDelta } from "@/lib/booking-change-request-input";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { calculateBookingPrice, getStayNights, type GuestInput } from "@/lib/pricing";
import { loadActiveSeasonRates } from "@/lib/booking-modify-plan";
import { toEditTimeGroupDiscountConfig } from "@/lib/policies/booking-route-decisions";
import {
  resolveGroupDiscountRateType,
  resolveGuestRateMembershipTypes,
} from "@/lib/membership-type-policy";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import type {
  ChangeRequestAddGuest,
  ChangeRequestEstimate,
} from "@/lib/booking-change-request-guests";

/**
 * The price shown on a member's in-progress change request before they send it
 * (#4030 Part A: "it shows the quote, as the structured route does").
 *
 * WHAT IT IS. The added NON-MEMBER guests priced night by night at the stay's
 * own active season rates by the canonical pricing engine
 * (`calculateBookingPrice`, with the canonical rate resolver and the club's
 * edit-time group discount), with the whole party the proposal leaves counted
 * on the nights it gives them — the booking's guests less the main editor's
 * removals, plus the editor's added guests (#4203) — so a party that crosses
 * the group-discount size is priced as one. That is the same arithmetic the finished-stay approval's
 * ordinary pricing pass uses for an added guest (#3750), so on an unchanged
 * season it is the price approving charges. Adding guests carries no change fee.
 *
 * WHAT IT IS NOT, and the card says so:
 *  - It is an ESTIMATE: the officer's approval is what prices and charges it, at
 *    that moment's rates and with any promotion or account credit applied.
 *  - It never prices a MEMBER guest. Resolving a member's rate reads their
 *    membership type and subscription, and a member-reachable route that did that
 *    for any id it was handed would answer "is this person a paid-up member" for
 *    anyone (the D-8 boundary the member-guest finder exists to hold). A member
 *    guest's line is "priced at their membership rate when approved".
 *  - Guests already on the booking, the editor's added guests AND added member
 *    guests are COUNTED, never priced (#4030 review M5, #4203): each holds its nights as count-only locked entries
 *    at zero, so no rate is looked up for them, nothing about their price is read
 *    or returned, and the party size on each night — which decides the group
 *    discount — is the party the approval will price.
 */

export const CHANGE_REQUEST_ESTIMATE_NO_RATE_MESSAGE =
  "These nights can't be priced at the moment (no active season covers them). You can still send the request; the booking officer confirms the price when they approve it.";

interface EstimateBooking {
  checkIn: Date;
  checkOut: Date;
  lodgeId: string | null;
  guests: Array<{
    id: string;
    stayStart: Date;
    stayEnd: Date;
    ageTier: AgeTier;
    isMember: boolean;
    nights: Array<{ stayDate: Date }>;
  }>;
}

/** Count-only party entries for a run of nights: locked at zero, never priced. */
function countOnly(
  guest: { ageTier: AgeTier; isMember: boolean },
  range: NormalizedBookingGuestStayRange,
): GuestInput {
  const nights = range.nights ?? getStayNights(range.stayStart, range.stayEnd);
  return {
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    rateMembershipTypeId: "count-only",
    nights,
    lockedNightPrices: nights.map((stayDate) => ({ stayDate, priceCents: 0 })),
  };
}

/**
 * The card's added guests priced inside the party the whole proposal would
 * leave on each night (#4203): the booking's guests minus the editor's
 * removals, on the nights the proposal gives them, plus the editor's added
 * guests, plus the card's. `editorChanges` is the main editor's part of the
 * proposal, already validated by the route (`INV-REQ-011`) with every named
 * guest on this booking; the party is read through approval's own mapping
 * (`changeRequestProposalBatchInput`, so repeated ranges keep their nights,
 * `INV-REQ-012`) and the planner's range resolver. Only card guests are
 * returned; every other guest is count-only.
 */
export async function estimateChangeRequestAddedGuests(
  booking: EstimateBooking,
  addGuests: ReadonlyArray<ChangeRequestAddGuest>,
  editorChanges: ChangeRequestDelta = {},
): Promise<ChangeRequestEstimate> {
  const editorAdded = editorChanges.addGuests ?? [];
  const proposal = mergeChangeRequestGuests(editorChanges, addGuests);
  const resolved = resolveModificationStayRanges({
    booking,
    guests: booking.guests,
    input: changeRequestProposalBatchInput(booking, proposal) ?? {},
  });
  const { checkIn, checkOut } = resolved;
  // Each added guest's nights as the planner would write them — the editor's,
  // then the card's: the grid's night set (#713, #4088), else the two bounds,
  // else the whole stay, by the canonical range rule (`INV-SSOT`). Refused,
  // never invented, if the resolver's list is out of step (#2800).
  const addedCount = editorAdded.length + addGuests.length;
  const addedRange = (index: number) => resolvedAddedGuestRange(resolved.added, index, addedCount);
  const cardRange = (index: number) => addedRange(editorAdded.length + index);
  const nonMembers = addGuests
    .map((guest, index) => ({ guest, index }))
    .filter(({ guest }) => !guest.isMember);
  const seasonYear = seasonYearOfStoredDate(checkIn);
  const lodgeId = booking.lodgeId ?? (await getDefaultLodgeId(prisma));
  const [seasons, groupDiscountSetting, subscriptionLockoutMode] = await Promise.all([
    loadActiveSeasonRates(prisma, lodgeId),
    prisma.groupDiscountSetting.findUnique({ where: { id: "default" } }),
    resolveSubscriptionLockoutMode(),
  ]);
  const groupDiscount = await resolveGroupDiscountRateType(
    prisma,
    toEditTimeGroupDiscountConfig(groupDiscountSetting),
  );
  // Non-members only, and with no member id, so the resolver reads no member.
  const rated = await resolveGuestRateMembershipTypes(prisma, {
    seasonYear,
    subscriptionLockoutMode,
    guests: nonMembers.map(({ guest, index }) => {
      const range = cardRange(index);
      return {
        ageTier: guest.ageTier as AgeTier,
        isMember: false,
        memberId: null,
        stayStart: range.stayStart,
        stayEnd: range.stayEnd,
        // A grid night set prices exactly those nights (`GuestInput.nights`).
        ...(range.nights ? { nights: range.nights } : {}),
      };
    }),
  });
  // The added guests in the order they were sent: a non-member's rated entry,
  // or a member's count-only one (#4030 review M5).
  const ratedByIndex = new Map(nonMembers.map(({ index }, row) => [index, rated[row]]));
  const addedEntries = addGuests.map((guest, index) => {
    const ratedEntry = ratedByIndex.get(index);
    if (ratedEntry) return ratedEntry;
    return countOnly(
      { ageTier: guest.ageTier as AgeTier, isMember: true },
      cardRange(index),
    );
  });
  // Everyone else in the proposed party: counted on their nights, never priced.
  const countedParty = [
    ...resolved.remaining.map(({ guest, ...range }) => countOnly(guest, range)),
    ...editorAdded.map((guest, index) =>
      countOnly({ ageTier: guest.ageTier as AgeTier, isMember: guest.isMember }, addedRange(index)),
    ),
  ];
  let priced;
  try {
    priced = calculateBookingPrice(
      checkIn,
      checkOut,
      [...countedParty, ...addedEntries],
      seasons,
      groupDiscount,
    );
  } catch {
    // The engine's only throw here is a night no active season prices.
    return { outcome: "unpriced", message: CHANGE_REQUEST_ESTIMATE_NO_RATE_MESSAGE };
  }
  const addedRows = priced.guests.slice(countedParty.length);
  const guests = addGuests.map((_guest, index) => {
    const row = addedRows[index];
    return {
      priceCents: ratedByIndex.has(index) && row ? row.priceCents : null,
      nights: row?.nights ?? 0,
    };
  });
  return {
    outcome: "priced",
    guests,
    // Members' count-only rows are zero, so they add nothing here.
    totalCents: addedRows.reduce((sum, row) => sum + row.priceCents, 0),
    excludesMemberGuests: nonMembers.length < addGuests.length,
  };
}
