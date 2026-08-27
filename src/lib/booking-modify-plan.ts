// Split out of src/lib/booking-modify.ts (issue #1138): the in-transaction
// modification pipeline — guest plan, repricing, promo changes, change fee,
// and guest/chore writes. Kept together because the booking-guest-profile
// gate contract test compares string indexes across this pipeline in one
// file. Code moved verbatim; import via the "@/lib/booking-modify" barrel.

import {
  AdminReviewStatus,
  BookingStatus,
  type AgeTier,
  type BookingGuest,
  type Prisma,
  type PromoCode,
  type Role,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import type { CalendarDate } from "@/lib/club-time";
import {
  assertOtherLodgeExists,
  requestCarriesOtherLodgeElection,
  resolveOtherLodgeRateElection,
  type OtherLodgeRateElection,
} from "@/lib/booking-other-lodge-rate";
import logger from "@/lib/logger";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import {
  buildInProgressGuestRangePlan,
  type BookingEditGuestRangePlan,
} from "@/lib/booking-edit-guest-ranges";
import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";
import {
  daysUntilDate,
  loadCancellationPolicy,
  type CancellationPolicyDb,
} from "@/lib/cancellation";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  checkCapacityForGuestRanges,
  checkCapacityForPartnerSharedAdmission,
} from "@/lib/capacity";
import {
  OverCapacityConfirmationRequiredError,
  overCapacityNights,
  wholeLodgeBlockedNights,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
import {
  type SeasonRateData,
} from "@/lib/pricing";
import {
  resolveGuestRateMembershipTypes,
  assertMembershipTypeBookingAllowed,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import {
  toEditTimeGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import {
  deletePromoRedemptionAndAdjustCount,
  lockAndRefreshPromoCodeUsage,
  lockPromoCodeRowsForUpdate,
  redeemPromoCode,
  replacePromoRedemptionAllocations,
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import {
  describePromoCapCoverage,
  type PromoCoverageNotice,
} from "@/lib/promo-cap-coverage";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import {
  evaluateNonMemberPricingRequirements,
  PaidUpAdultMemberRequiredError,
} from "@/lib/subscription-lockout-enforcement";
import { isLikelyTypoCorrection } from "@/lib/guest-name-similarity";
import {
  assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembersWithBoundary,
  type BookingGuestInput,
} from "@/lib/booking-guests";
import {
  markCrossFamilyGuestsOnBooking,
  planMemberGuestConsentWrites,
  type MemberGuestAddPolicy,
  type MemberGuestConsentGuestFields,
  type MemberGuestConsentWritePlanEntry,
} from "@/lib/member-guest-add-policy";
import {
  isOperationallyPresentConsent,
  type MemberGuestAddActor,
  type MemberGuestConsentColumns,
} from "@/lib/member-guest-consent";
import {
  addDaysDateOnly,
  formatDateOnly,
} from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { resolveOtherLodgeRateEligibleGuestIds } from "@/lib/membership-type-policy";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import {
  BookingModifyReviewJustificationRequiredError,
  isBookingFullyPaidForGuestNameEdits,
  resolveStayRangesOrApiError,
  type BatchModifyInput,
  type LoadedBookingForModify,
  type LoadedPromoRedemption,
} from "@/lib/booking-modify-validation";

type ProposedGuestPricingInput = {
  bookingGuestId?: string | null;
  ageTier: AgeTier;
  isMember: boolean;
  memberId: string | null;
  // Other Lodges epic: the reciprocal other-club rate flag this guest will carry
  // once saved. Read by `resolveGuestRateMembershipTypes`, which resolves such a
  // guest to the built-in FULL type's rate rows.
  otherLodgeMember?: boolean;
  stayStart: Date;
  stayEnd: Date;
  nights?: Date[];
  // #1036 / #2337: nights the guest already bought keep their booked price; the
  // pricing pass reads this. A linked placeholder clears it to re-rate at the
  // member season rate (see the carve-out where `proposedGuestRows` is built),
  // so the field is part of this type rather than only present at runtime.
  lockedNightPrices?: Array<{ stayDate: Date; priceCents: number }>;
};

type ProposedRemainingGuest = {
  guest: BookingGuest & { nights?: { stayDate: Date; priceCents?: number }[] };
  stayStart: Date;
  stayEnd: Date;
  nights?: Date[];
};

/**
 * The guest's stored per-night prices, usable as `lockedNightPrices` (#1036).
 * Rows loaded without `priceCents` (or legacy guests without night rows)
 * yield no locks, so those nights price at current season rates.
 */
export function lockedNightPricesForGuest(guest: {
  nights?: { stayDate: Date; priceCents?: number }[];
}): Array<{ stayDate: Date; priceCents: number }> {
  return (guest.nights ?? []).flatMap((night) =>
    typeof night.priceCents === "number"
      ? [{ stayDate: night.stayDate, priceCents: night.priceCents }]
      : [],
  );
}

/**
 * The `rateMembershipTypeId` value to WRITE for a repriced guest — or `undefined`
 * to leave the stored snapshot alone (#2543, D5).
 *
 * THE SNAPSHOT IS PER GUEST; THE LOCKED PRICES ARE PER NIGHT, and that mismatch is
 * the whole reason this exists. `BookingGuestNight` carries no rate-type column
 * (`prisma/schema.prisma`), and Xero resolves ONE item code per guest and applies
 * it to every night run of that guest, even though runs are split by price change.
 * So on an edit where SOME of a guest's nights keep their locked booked price and
 * others price fresh, overwriting the guest's snapshot posts the member-rate nights
 * under the newly resolved (non-member) item code.
 *
 * Worked example, and the reason this became ordinary rather than rare: a club in
 * NO_BLOCK has a member with an unpaid subscription holding a PAID 3-night booking
 * at the member rate (snapshot FULL, 3 x 1000 c). The club switches to
 * NON_MEMBER_PRICING. The member extends by one night. The 3 original nights keep
 * 1000 c each; the new night prices at 2400 c; the guest snapshot would flip to
 * NON_MEMBER, and the invoice would post 3000 c of MEMBER-rate hut-fee revenue to
 * the non-member item. Pre-#2543 the trigger was a mid-booking membership-type
 * change, i.e. rare; #2543 made it the ordinary case for any unpaid member editing
 * a booking.
 *
 * KEEPING THE STALE SNAPSHOT IS WHAT THE INVARIANT ALREADY PROMISES:
 * `docs/DOMAIN_INVARIANTS.md` states that "a locked night keeps both its price and
 * its stale snapshot untouched". The price was protected; the snapshot was not.
 * Owner direction, 2 Aug 2026: honour the promise. The residual, stated plainly, is
 * that a guest whose stay mixes locked and newly-priced nights keeps the OLD item
 * code for all of them — the same direction the locked price itself takes, and the
 * only per-guest answer available until an item code can be resolved per night run.
 *
 * A guest whose locked prices were deliberately CLEARED (the #2337 placeholder→member
 * link, which reprices the whole stay so the member actually gets the member rate)
 * has no kept locked night and is therefore correctly re-snapshotted.
 */
export function rateSnapshotUpdateForRepricedGuest(
  pricedGuest:
    | { rateMembershipTypeId?: string | null; nightDates?: Date[] }
    | undefined,
  lockedNightPrices:
    | ReadonlyArray<{ stayDate: Date | string }>
    | null
    | undefined,
): string | null | undefined {
  const locked = new Set(
    (lockedNightPrices ?? []).map((entry) =>
      typeof entry.stayDate === "string"
        ? entry.stayDate.slice(0, 10)
        : formatDateOnly(entry.stayDate),
    ),
  );
  if (locked.size > 0) {
    const keepsLockedNight = (pricedGuest?.nightDates ?? []).some((night) =>
      locked.has(formatDateOnly(night)),
    );
    if (keepsLockedNight) return undefined;
  }
  return pricedGuest?.rateMembershipTypeId;
}

export type ResolvedGuestNameUpdate = {
  guestId: string;
  firstName: string;
  lastName: string;
  previousFirstName: string;
  previousLastName: string;
};

/**
 * Shown when a free-text non-member guest name edit on a fully-paid booking is
 * NOT an identity-preserving spelling correction (#1386). The paid-name lock
 * still blocks swapping in a different person; only typo fixes are exempt.
 */
export const PAID_NAME_TYPO_ONLY_MESSAGE =
  "Only spelling corrections are allowed after payment; to change who a booking is for, contact the office.";

function normalizeGuestName(value: string, fieldName: string) {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  if (!normalized) {
    throw new ApiError(`${fieldName} is required`, 400);
  }
  if (normalized.length > 100) {
    throw new ApiError(`${fieldName} must be 100 characters or fewer`, 400);
  }
  return normalized;
}

export function resolveGuestNameUpdates({
  booking,
  input,
  allowWhenFullyPaid = false,
  allowTypoFixWhenFullyPaid = false,
}: {
  booking: Pick<
    LoadedBookingForModify,
    "guests" | "status" | "finalPriceCents" | "payment"
  >;
  input: Pick<BatchModifyInput, "guestUpdates" | "removeGuestIds">;
  /**
   * Quoted (booking-request) bookings are exempt from the paid-name lock
   * (#1099): their guests are placeholder records ("School Child 1..N") and
   * replacing them with real attendee names before arrival is the intended
   * workflow — including after the school has paid its invoice.
   */
  allowWhenFullyPaid?: boolean;
  /**
   * Identity-only edits (no structural change) on a fully-paid booking may fix
   * an identity-preserving spelling TYPO on a free-text non-member guest
   * (#1386). Each changed name must pass {@link isLikelyTypoCorrection}; the
   * lock still rejects anything that could be a different person (a swap).
   * Ignored when {@link allowWhenFullyPaid} already lifts the lock (quoted
   * bookings), and irrelevant when the booking is not fully paid.
   */
  allowTypoFixWhenFullyPaid?: boolean;
}): ResolvedGuestNameUpdate[] {
  if (!input.guestUpdates?.length) {
    return [];
  }

  const fullyPaidLockActive =
    !allowWhenFullyPaid && isBookingFullyPaidForGuestNameEdits(booking);

  if (fullyPaidLockActive && !allowTypoFixWhenFullyPaid) {
    throw new ApiError(
      "Non-member guest names cannot be edited after the booking is fully paid",
      400,
    );
  }

  const removedGuestIds = new Set(input.removeGuestIds ?? []);
  const guestsById = new Map(booking.guests.map((guest) => [guest.id, guest]));
  const seenGuestIds = new Set<string>();
  const updates: ResolvedGuestNameUpdate[] = [];

  for (const update of input.guestUpdates) {
    if (seenGuestIds.has(update.guestId)) {
      throw new ApiError("Each guest can only be updated once", 400);
    }
    seenGuestIds.add(update.guestId);

    if (removedGuestIds.has(update.guestId)) {
      throw new ApiError(
        "A guest cannot be renamed and removed in the same change",
        400,
      );
    }

    const guest = guestsById.get(update.guestId);
    if (!guest) {
      throw new ApiError(
        "One or more guest updates referenced a guest not found on this booking",
        400,
      );
    }

    if (guest.isMember || guest.memberId) {
      throw new ApiError("Member guest names cannot be edited on a booking", 400);
    }

    const firstName = normalizeGuestName(update.firstName, "First name");
    const lastName = normalizeGuestName(update.lastName, "Last name");
    if (firstName === guest.firstName && lastName === guest.lastName) {
      continue;
    }

    // On a fully-paid booking the lock is only lifted for an identity-preserving
    // spelling correction (#1386); a name that could be a different person keeps
    // the hard reject so payment can't quietly transfer the booking.
    if (
      fullyPaidLockActive &&
      !isLikelyTypoCorrection(
        guest.firstName,
        guest.lastName,
        firstName,
        lastName,
      )
    ) {
      throw new ApiError(PAID_NAME_TYPO_ONLY_MESSAGE, 400);
    }

    updates.push({
      guestId: guest.id,
      firstName,
      lastName,
      previousFirstName: guest.firstName,
      previousLastName: guest.lastName,
    });
  }

  return updates;
}

export type ResolvedGuestMemberLink = {
  guestId: string;
  memberId: string;
  previousFirstName: string;
  previousLastName: string;
};

export const GUEST_MEMBER_LINK_ADMIN_ONLY_MESSAGE =
  "Linking a placeholder guest to a member is an admin-only action.";
export const GUEST_MEMBER_LINK_WHOLE_LODGE_ONLY_MESSAGE =
  "A placeholder guest can only be linked to a member on a whole-lodge booking.";
export const GUEST_MEMBER_LINK_PLACEHOLDER_ONLY_MESSAGE =
  "Only an unlinked placeholder guest can be linked to a member; a guest already linked to a member cannot be re-pointed.";
export const GUEST_MEMBER_LINK_ALREADY_ON_BOOKING_MESSAGE =
  "This member is already on the booking and cannot be linked to another guest.";

/**
 * Resolve the #2337 placeholder→member links, enforcing the narrow gate that
 * makes this the ONE sanctioned reversal of the member-guest refusal
 * (`resolveGuestNameUpdates` still refuses to touch a member-linked guest at
 * :250-252, and that refusal is left intact — a rename can never re-rate).
 *
 * This is the SYNCHRONOUS gate: actor role, the whole-lodge fence, placeholder-
 * only, and the structural sanity checks (dedupe, not-also-removed, not-also-
 * renamed). The DEEPER eligibility — the target member exists/active, the family
 * boundary + consent, membership-type policy, and person-night conflicts — is
 * enforced by threading the linked members through the same machinery an
 * `addGuests` member guest uses (see `prepareGuestPlan`). The member-ORIGIN fence
 * (this must be a member whole-lodge booking, not a SCHOOL one) is asynchronous
 * and lives on the apply/quote paths beside the quote-priced block.
 */
export function resolveGuestMemberLinks({
  booking,
  input,
  role,
}: {
  booking: Pick<LoadedBookingForModify, "guests" | "wholeLodgeHold">;
  input: Pick<
    BatchModifyInput,
    "linkGuestToMember" | "removeGuestIds" | "guestUpdates"
  >;
  role: Role;
}): ResolvedGuestMemberLink[] {
  if (!input.linkGuestToMember?.length) {
    return [];
  }

  // Narrow gate 1 — admin/officer only. The reversal must be unreachable from
  // member self-service, however this resolver is reached.
  if (role !== "ADMIN") {
    throw new ApiError(GUEST_MEMBER_LINK_ADMIN_ONLY_MESSAGE, 403);
  }
  // Narrow gate 2 — whole-lodge bookings only, so the exemption cannot touch an
  // ordinary booking and the #1386 paid-name lock stays intact everywhere else.
  if (!booking.wholeLodgeHold) {
    throw new ApiError(GUEST_MEMBER_LINK_WHOLE_LODGE_ONLY_MESSAGE, 400);
  }

  const removedGuestIds = new Set(input.removeGuestIds ?? []);
  const updatedGuestIds = new Set(
    (input.guestUpdates ?? []).map((update) => update.guestId),
  );
  const guestsById = new Map(booking.guests.map((guest) => [guest.id, guest]));
  // Members ALREADY on the booking — e.g. a prior committed link, or the booking
  // owner and their family placed as member guests at approval. A second link to
  // any of them would bill the member rate twice (#2337 double-billing), so it is
  // refused below. On the apply path `booking.guests` is the post-lock re-read
  // (`modifyBookingBatch` re-reads the full booking under the money + per-lodge
  // locks and passes it straight to `prepareGuestPlan`), so this same check is
  // the in-transaction re-check that closes a concurrent double-link — two racing
  // requests serialise on the lock, and the second sees the first's committed row.
  const existingBookingMemberIds = new Set(
    booking.guests
      .filter((guest) => guest.memberId)
      .map((guest) => guest.memberId as string),
  );
  const seenGuestIds = new Set<string>();
  const seenMemberIds = new Set<string>();
  const links: ResolvedGuestMemberLink[] = [];

  for (const link of input.linkGuestToMember) {
    const memberId = link.memberId?.trim();
    if (!memberId) {
      throw new ApiError("A member must be chosen to link a guest to", 400);
    }
    if (seenGuestIds.has(link.guestId)) {
      throw new ApiError("Each guest can only be linked once", 400);
    }
    seenGuestIds.add(link.guestId);
    // One member cannot be two guests on the same booking; catching it here keeps
    // the person-night conflict check from having to reason about a self-clash.
    if (seenMemberIds.has(memberId)) {
      throw new ApiError("The same member cannot be linked to two guests", 400);
    }
    seenMemberIds.add(memberId);
    // …and one already on the booking (a prior committed link, or a member guest
    // added at approval) cannot be linked to ANOTHER placeholder row — that is the
    // cross-request double-bill the within-request guard above cannot see. The
    // person-night conflict check excludes this booking, so nothing else catches
    // it (#2337).
    if (existingBookingMemberIds.has(memberId)) {
      throw new ApiError(GUEST_MEMBER_LINK_ALREADY_ON_BOOKING_MESSAGE, 400);
    }

    if (removedGuestIds.has(link.guestId)) {
      throw new ApiError(
        "A guest cannot be linked and removed in the same change",
        400,
      );
    }
    // A link replaces the placeholder name with the member's identity, so a
    // simultaneous free-text rename of the same row is ambiguous — refuse it, the
    // same instinct as the rename+remove guard.
    if (updatedGuestIds.has(link.guestId)) {
      throw new ApiError(
        "A guest cannot be renamed and linked in the same change",
        400,
      );
    }

    const guest = guestsById.get(link.guestId);
    if (!guest) {
      throw new ApiError(
        "One or more guest links referenced a guest not found on this booking",
        400,
      );
    }
    // Narrow gate 3 — placeholder-only. NEVER member→member: a guest that already
    // carries a member identity keeps the same lock a rename keeps, so the
    // reversal can never silently transfer a booking to a different member.
    if (guest.isMember || guest.memberId) {
      throw new ApiError(GUEST_MEMBER_LINK_PLACEHOLDER_ONLY_MESSAGE, 400);
    }

    links.push({
      guestId: guest.id,
      memberId,
      previousFirstName: guest.firstName,
      previousLastName: guest.lastName,
    });
  }

  return links;
}

export type GuestPlan = {
  /**
   * Whether the GUEST-AUTHORISATION questions were judged with admin elevation
   * (#2526). Equals `role === "ADMIN"` for every existing caller; false when an
   * ADMIN caller passed `input.reviewedMemberProposal` — the policy-exception
   * approval, which borrows ADMIN only for the reviewed minimum-stay override.
   * The pricing pass reads the SAME answer, so the plan and the price can never
   * disagree about whether the family boundary applied.
   */
  guestAuthorizationIsAdmin: boolean;
  remainingGuests: BookingGuest[];
  proposedRemainingGuests: ProposedRemainingGuest[];
  removedGuests: BookingGuest[];
  normalizedAddGuests:
    | Array<BookingGuestInput & MemberGuestConsentGuestFields>
    | undefined;
  guestsForPricing: ProposedGuestPricingInput[];
  /**
   * The cross-family member guests this modification adds, keyed by target member
   * id ("+ Add Member Guest", epic #2305, MG2 #2307). The batch service matches
   * these to the guest rows `applyGuestChanges` creates and sends the request or
   * notice AFTER the transaction commits — nothing in this file mails anybody.
   * Empty on every family-scope modification.
   */
  memberGuestEntries: Map<string, MemberGuestConsentWritePlanEntry>;
  /**
   * #2337: the resolved placeholder→member links this modification applies, in
   * request order, with the placeholder's previous name for the audit row. Empty
   * on every modification that names no link.
   */
  guestMemberLinks: ResolvedGuestMemberLink[];
  /**
   * #2337: the member-guest consent columns to write onto each linked EXISTING
   * row, keyed by guestId. Undefined for a family-scope link (writes nothing new);
   * a beyond-family link carries the same columns an added cross-family member
   * guest would — so the consent email fires exactly as remove-and-re-add does.
   */
  guestMemberLinkColumns: Map<string, MemberGuestConsentColumns | undefined>;
  /**
   * #2337: the linked member's canonical name, keyed by guestId, so the linked
   * row displays the member's name rather than the "Guest N" placeholder — the
   * same as an added member guest. Null when the member record carries no name,
   * in which case the placeholder name is kept rather than blanking the row.
   */
  guestMemberLinkNames: Map<
    string,
    { firstName: string | null; lastName: string | null }
  >;
  /**
   * The resolved reciprocal other-club rate election (Other Lodges epic).
   *
   * Carried on the plan rather than re-resolved at the write step for the same
   * reason every other decision here is: the rows were PRICED against this
   * election (its `repriceGuestIds` is what cleared their locked nights), so the
   * flags written must be the ones the price was computed from. An inert
   * election — every modification that says nothing about the rate — reports the
   * stored state and an empty reprice set, so nothing is written.
   */
  otherLodgeElection: OtherLodgeRateElection;
  totalGuestCount: number;
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  /**
   * Review-related fields to write to the booking after the modification.
   * Encapsulates four scenarios: rule clears (fields nulled), rule trips
   * for the first time on a member modification (justification captured,
   * adminReviewStatus = PENDING), rule trips on an admin modification
   * (auto-approved), rule already tripped (existing review state kept).
   */
  reviewUpdate: {
    requiresAdminReview: boolean;
    adminReviewReason: string | null;
    memberReviewJustification: string | null;
    adminReviewStatus: AdminReviewStatus | null;
    adminReviewNotes: string | null;
    adminReviewedById: string | null;
    adminReviewedAt: Date | null;
    /** When true, status must move to AWAITING_REVIEW unless already there. */
    parkForReview: boolean;
    /** When true, AWAITING_REVIEW should be released to PAYMENT_PENDING. */
    releaseFromReview: boolean;
  };
};

export async function prepareGuestPlan(
  tx: Prisma.TransactionClient,
  {
    booking,
    role,
    actorId,
    input,
    isInProgressEdit,
    editableFrom,
    newCheckIn,
    newCheckOut,
    memberGuestPolicy,
    subscriptionLockoutMode,
    today,
    now = new Date(),
  }: {
    booking: LoadedBookingForModify;
    role: Role;
    actorId: string;
    input: BatchModifyInput;
    isInProgressEdit: boolean;
    editableFrom: Date | null;
    newCheckIn: Date;
    newCheckOut: Date;
    /**
     * MG2 (#2307). Read by the caller BEFORE it opened this transaction — see the
     * ordering rule in `member-guest-add-policy.ts`. Optional so the existing
     * unit tests of this planner keep compiling; a missing policy is MG1's
     * behaviour, which is a refusal, not a silent consent-free add.
     */
    memberGuestPolicy?: MemberGuestAddPolicy;
    /**
     * The club's subscription-lockout mode (#2543), resolved by the caller before
     * it opened this transaction.
     *
     * This planner is the SIXTH enforcement site — the apply half of the edit flow
     * whose preview is `modify-quote` — and it was the one the issue's anchor list
     * missed. Without the mode it hard-blocked an unpaid member guest in EVERY
     * regime, so under NON_MEMBER_PRICING a member was quoted the non-member price
     * with an explanation and then refused on save with the pre-#2543 403: an edit
     * that could never complete. Optional, and a missing value is read as
     * HARD_BLOCK, which is the pre-#2543 behaviour and the safe direction for the
     * planner's own unit tests.
     */
    subscriptionLockoutMode?: SubscriptionLockoutMode;
    /**
     * The CLUB's today, as the UTC-midnight `Date` a `@db.Date` round-trips
     * through, resolved by the caller BEFORE it opened this transaction
     * (`INV-CONFIG-002`, `INV-LOCK-004`).
     *
     * REQUIRED, and deliberately unlike `memberGuestPolicy` and
     * `subscriptionLockoutMode` above, which are optional so the planner's own
     * unit tests keep compiling. Both of those have a safe reading when absent —
     * MG1 behaviour and HARD_BLOCK, each a refusal. A missing day has no safe
     * reading: the only two candidates are the container's zone, which is the
     * defect this issue removes, and a read taken here under
     * `pg_advisory_xact_lock(1)` plus the per-lodge capacity key, which is the
     * pool-starvation shape `INV-LOCK-004` forbids. So the compiler enumerates
     * the callers instead.
     *
     * It reaches the person-night guard below, whose `evaluateGuestSelfRemoval`
     * decides whether a clashing guest may take themselves off the other
     * booking — a member-facing answer that must be the club's day, not the
     * host's.
     */
    today: Date;
    now?: Date;
  },
): Promise<GuestPlan> {
  // MG4-D-a, brought forward: `role === "ADMIN"` is exactly the condition that
  // passes `skipAuthorization`, so an admin modification adds a cross-family guest
  // consent-free and always-notify, stamped with the acting admin.
  //
  // #2526: `input.reviewedMemberProposal` opts an ADMIN caller OUT of that
  // elevation for the guest-authorisation questions only — see the field's own
  // docblock. Everything else on this path still keys on `role`, so the reviewed
  // minimum-stay override (which genuinely is what ADMIN buys the approval) is
  // untouched. One derived flag, used everywhere the guest rules are decided, so
  // the two can never disagree.
  const guestAuthorizationRole: Role =
    role === "ADMIN" && input.reviewedMemberProposal === true
      ? ("MEMBER" as Role)
      : role;
  const guestAuthorizationIsAdmin = guestAuthorizationRole === "ADMIN";
  const memberGuestActor: MemberGuestAddActor = guestAuthorizationIsAdmin
    ? { kind: "ADMIN", adminMemberId: actorId }
    : { kind: "MEMBER" };
  // #2337: resolve the placeholder→member links (the synchronous narrow gate)
  // BEFORE the member/boundary resolution, so their member ids join the same
  // resolve — a linked member is checked for existence/eligibility and placed in
  // the family boundary exactly like an added member guest, reusing all of it.
  const guestMemberLinks = resolveGuestMemberLinks({ booking, input, role });
  // Other Lodges epic: the same resolver `modify-quote` ran to build the preview,
  // over the same stored booking and the same request fields — so the flags this
  // save writes, and the rows it reprices, are exactly the ones the officer was
  // quoted. `booking` here is the post-lock re-read, so a concurrent edit that
  // changed a guest's flag is seen before the reprice decision is made.
  // #2978: eligibility is a rate question, so it needs the season's
  // membership-type policies and whether anybody owes a subscription. Resolved
  // on `tx`, never the module client: this runs inside the transaction holding
  // the capacity lock, and a second pool connection under that lock is the
  // starvation shape `docs/CONCURRENCY_AND_LOCKING.md` forbids by name. Keyed to
  // the BOOKING's season, exactly as `modify-quote` keys it, so the preview and
  // the save fence identical sets.
  //
  // ONLY WHEN THIS REQUEST ACTUALLY MENTIONS THE RATE, because of what it costs
  // inside that transaction. Be precise about the number: it is THREE reads
  // minimum on an election that names a member guest — the policy resolver's
  // member + assignment pair, then the settlement pair (subscriptions +
  // members) issued together — and a fourth when a member has no season
  // assignment and the built-in fallback type has to be looked up. It is ZERO
  // when nobody on the booking is a member, which the helper short-circuits.
  //
  // ONE OF THOSE READS CAN LEAVE THIS TRANSACTION, and saying "no settings read
  // is added" (as this comment used to) was wrong.
  // `loadMemberSubscriptionSettlements` calls `getAgeTierSettings()`, which
  // serves a five-minute in-process cache and, on a miss, imports the MODULE
  // prisma client and reads `AgeTierSetting` on a second connection. That shape
  // is pre-existing and is not introduced here; what #2978 changes is how often
  // it is reached, since eligibility no longer consults the lockout mode (owner
  // decision, 21 Aug 2026) and so no longer returns early under `HARD_BLOCK` and
  // `NO_BLOCK`. It stays bounded: an election request, a member guest on the
  // booking, and a cold cache, all at once.
  const otherLodgeEligibleGuestIds = requestCarriesOtherLodgeElection(input)
    ? await resolveOtherLodgeRateEligibleGuestIds(tx, {
        seasonYear: seasonYearOfStoredDate(booking.checkIn),
        guests: booking.guests,
      })
    : new Set<string>();
  const otherLodgeElection = resolveOtherLodgeRateElection({
    booking,
    input,
    role,
    eligibleGuestIds: otherLodgeEligibleGuestIds,
  });
  // Only when this edit named a lodge: an inert election's stored id was already
  // validated when it was set, so re-reading it on every unrelated modification
  // would be a query for nothing.
  if (otherLodgeElection.requested) {
    await assertOtherLodgeExists(tx, otherLodgeElection.otherLodgeId);
  }
  const { members: linkedMembers, boundary } =
    await resolveLinkedBookingMembersWithBoundary(
      tx,
      booking.memberId,
      [
        ...(input.addGuests ?? []).map((guest) => guest.memberId),
        ...guestMemberLinks.map((link) => link.memberId),
      ],
      {
        skipAuthorization: guestAuthorizationIsAdmin,
        memberGuestWideningEnabled: memberGuestPolicy?.wideningEnabled ?? false,
      },
    );
  await assertLinkedBookingMembersCanBeBooked(
    tx,
    linkedMembers,
    // Judged as the booking's own member when the caller asked for member
    // semantics: the profile/bookability gate answers "can THIS person add that
    // member", and for an approved exception request that person is the booker.
    guestAuthorizationIsAdmin ? actorId : booking.memberId,
    {
    actorRole: guestAuthorizationRole,
    onBehalfOfMemberId: guestAuthorizationIsAdmin ? booking.memberId : null,
    // D-8: a blocked cross-family member is refused neutrally.
    crossFamilyMemberIds: boundary.beyondFamilyMemberIds,
    },
  );
  const consentPlan = planMemberGuestConsentWrites({
    guests: input.addGuests
      ? normalizeBookingGuestInputs(input.addGuests, linkedMembers).map((guest, index) => ({
          ...guest,
          stayStart: input.addGuests?.[index]?.stayStart ?? null,
          stayEnd: input.addGuests?.[index]?.stayEnd ?? null,
          nights: input.addGuests?.[index]?.nights ?? null,
        }))
      : [],
    boundary,
    actor: memberGuestActor,
    now,
    bookingCheckIn: newCheckIn,
    policy:
      memberGuestPolicy ?? {
        wideningEnabled: false,
        approvalRequired: true,
        pendingHoldExpiryDays: 0,
      },
  });
  const memberGuestEntries = consentPlan.entriesByMemberId;
  const normalizedAddGuests = input.addGuests ? consentPlan.guests : undefined;

  // #2337: plan the consent columns for the linked EXISTING rows through the same
  // pure planner (option a — a beyond-family link reuses the MG2/MG3 consent
  // machinery unchanged). Keyed by guestId because the columns land on a row that
  // already exists rather than one being created. Entries are merged into
  // `memberGuestEntries` so a beyond-family link fires exactly the notification an
  // added cross-family member guest would.
  const linkConsentPlan = planMemberGuestConsentWrites({
    guests: guestMemberLinks.map((link) => ({
      guestId: link.guestId,
      memberId: link.memberId,
    })),
    boundary,
    actor: memberGuestActor,
    now,
    bookingCheckIn: newCheckIn,
    policy:
      memberGuestPolicy ?? {
        wideningEnabled: false,
        approvalRequired: true,
        pendingHoldExpiryDays: 0,
      },
  });
  const guestMemberLinkColumns = new Map<
    string,
    MemberGuestConsentColumns | undefined
  >(linkConsentPlan.guests.map((guest) => [guest.guestId, guest.memberGuestConsent]));
  const linkCrossFamilyByGuestId = new Map<string, boolean>(
    linkConsentPlan.guests.map((guest) => [
      guest.guestId,
      Boolean(guest.crossFamilyMemberGuest),
    ]),
  );
  const linkByGuestId = new Map(
    guestMemberLinks.map((link) => [link.guestId, link]),
  );
  // #2337: the member's canonical name for each linked row, resolved from the
  // same `linkedMembers` the boundary machinery produced.
  const guestMemberLinkNames = new Map<
    string,
    { firstName: string | null; lastName: string | null }
  >(
    guestMemberLinks.map((link) => {
      const member = linkedMembers.get(link.memberId);
      return [
        link.guestId,
        {
          firstName: member?.firstName ?? null,
          lastName: member?.lastName ?? null,
        },
      ];
    }),
  );
  for (const [memberId, entry] of linkConsentPlan.entriesByMemberId) {
    memberGuestEntries.set(memberId, entry);
  }

  const removeSet = new Set(input.removeGuestIds ?? []);
  const remainingGuests = booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = booking.guests.filter((g) => removeSet.has(g.id));

  if (
    !isInProgressEdit &&
    remainingGuests.length === 0 &&
    (!normalizedAddGuests || normalizedAddGuests.length === 0)
  ) {
    throw new ApiError("Booking must have at least one guest", 400);
  }

  // The SHARED canonical stay-range resolution (#2526, #2563). `resolveTargetDates`
  // already ran the identical call to derive `newCheckIn`/`newCheckOut`, the
  // policy-exception workflow runs it to freeze the party an officer reviews, and
  // the modification PREVIEW (`POST /api/bookings/[id]/modify-quote`) runs it to
  // quote the price — so all four agree by construction rather than by inspection.
  // Keep this count in step with `docs/DOMAIN_INVARIANTS.md` ("Four surfaces, one
  // implementation"); a stale enumeration here is how the #2526 divergence sat
  // unnoticed. Passing the resolved envelope as `requested` keeps an in-progress
  // edit (whose check-in is pinned to the stored one) resolving against the
  // envelope actually being applied.
  const resolvedRanges = resolveStayRangesOrApiError({
    booking: { checkIn: booking.checkIn, checkOut: booking.checkOut },
    guests: remainingGuests,
    input,
    requested: { checkIn: newCheckIn, checkOut: newCheckOut },
  });
  const proposedRemainingGuests: ProposedRemainingGuest[] = resolvedRanges.remaining.map(
    ({ guest, ...range }) => ({ guest, ...range }),
  );

  // Each field assigned explicitly rather than spread: `addGuests` carries its
  // own raw `nights` (date STRINGS from the request payload) and the resolved
  // range carries the normalised `Date[]`, so a spread leaves the property typed
  // as the union of the two and the pricing input rejects it.
  const normalizedAddGuestsWithRanges = normalizedAddGuests
    ? normalizedAddGuests.map((guest, index) => ({
        ...guest,
        stayStart: resolvedRanges.added[index].stayStart,
        stayEnd: resolvedRanges.added[index].stayEnd,
        nights: resolvedRanges.added[index].nights,
      }))
    : undefined;

  const proposedGuestRows = [
    ...proposedRemainingGuests.map((entry) => {
      const link = linkByGuestId.get(entry.guest.id);
      return {
        bookingGuestId: entry.guest.id,
        // #2337: the link keeps the placeholder's OWN age tier (member whole-lodge
        // placeholders are all ADULT), so it re-rates member-vs-non-member at the
        // SAME age class the booking reserved and held. Changing the age class
        // would change capacity/headcount and break the capacity-invariant the
        // link is required to hold; an age-class change stays a remove-and-re-add.
        ageTier: entry.guest.ageTier as AgeTier,
        // #2337: a linked placeholder enters pricing with the MEMBER identity, so
        // the membership-type policy and the season-rate resolver price it at the
        // member rate. A non-linked guest is untouched.
        isMember: link ? true : entry.guest.isMember,
        memberId: link ? link.memberId : (entry.guest.memberId ?? null),
        // Other Lodges epic: the flag this guest carries once saved. Taken from
        // the election (the stored value when this edit says nothing about it),
        // so an ordinary date change still prices an already-recognised
        // other-club guest at the member rate rather than silently reverting it.
        otherLodgeMember: otherLodgeElection.flaggedGuestIds.has(entry.guest.id),
        stayStart: entry.stayStart,
        stayEnd: entry.stayEnd,
        nights: entry.nights,
        // Nights the guest already bought keep their booked price (#1036);
        // only nights outside the stored set price at current season rates.
        //
        // #2337 LOAD-BEARING: a linked placeholder MUST clear its booked
        // non-member lockedNightPrices, or every night stays locked to the stored
        // non-member price and the re-rate silently does nothing — the member
        // never gets the member rate. Clearing them reprices the whole stay at the
        // member season rate.
        //
        // The other-lodge tick clears them on exactly the same argument, and in
        // BOTH directions: ticking somebody whose nights are locked at the
        // non-member price would never reach the member rate, and unticking
        // somebody whose nights are locked at the member price would never leave
        // it. Only guests whose flag actually CHANGED are cleared, so an
        // unrelated edit never silently reprices a settled stay.
        lockedNightPrices:
          link || otherLodgeElection.repriceGuestIds.has(entry.guest.id)
            ? []
            : lockedNightPricesForGuest(entry.guest),
        // Carry the D-8 marker for a beyond-family link so the person-night guard
        // collapses exactly as it does for an added cross-family member guest.
        ...(link && linkCrossFamilyByGuestId.get(entry.guest.id)
          ? { crossFamilyMemberGuest: true }
          : {}),
      };
    }),
    ...(normalizedAddGuestsWithRanges ?? []).map((g) => ({
      bookingGuestId: null,
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
      stayStart: g.stayStart,
      stayEnd: g.stayEnd,
      nights: g.nights,
      // D-8 (MG2 #2307): this list is rebuilt field by field, so the marker is
      // carried across explicitly — the in-transaction person-night guard below
      // reads it to refuse a cross-family clash neutrally.
      crossFamilyMemberGuest: g.crossFamilyMemberGuest,
    })),
  ];

  // C1 (privacy review of MG3 #2308). The marker above only ever lands on guests
  // this request is ADDING; a cross-family member guest already on the booking
  // was never marked, so the person-night guard described them in full on every
  // later date change. Re-derive it over the whole proposed party — see
  // `markCrossFamilyGuestsOnBooking` for why this uses the live family boundary
  // rather than the persisted consent columns.
  const guestsForPricing = await markCrossFamilyGuestsOnBooking(
    tx,
    booking.memberId,
    proposedGuestRows,
    // `bookingId` arms the owner's gate (finding 4) — see
    // `markCrossFamilyGuestsOnBooking`.
    { skipAuthorization: guestAuthorizationIsAdmin, bookingId: booking.id },
  );

  const totalGuestCount = guestsForPricing.length;
  const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
  const lodgeCapacity = await getLodgeCapacity(bookingLodgeId, tx);
  if (totalGuestCount > lodgeCapacity) {
    throw new ApiError(
      `A booking cannot exceed ${lodgeCapacity} guests`,
      400,
    );
  }

  await assertNoBookingMemberNightConflicts(tx, {
    actorMemberId: actorId,
    actorRole: role,
    checkIn: newCheckIn,
    checkOut: newCheckOut,
    guests: guestsForPricing,
    excludeBookingId: booking.id,
    // Supplied by the caller from outside this transaction (`INV-LOCK-004`) —
    // see the `today` parameter's docblock.
    today,
  });

  const requiresAdminReview = requiresAdultSupervisionReview(guestsForPricing);
  const adminReviewReason = requiresAdminReview
    ? ADULT_SUPERVISION_REVIEW_REASON
    : null;

  const reviewUpdate = resolveModifyReviewUpdate({
    booking,
    // #2526: an ADMIN executing a member's reviewed proposal must not
    // auto-approve the adult-supervision review — that rule was never on the
    // officer's card. Member semantics open it PENDING, which keeps the #1422
    // check-in block armed until a human actually looks.
    role: guestAuthorizationRole,
    actorId,
    nowFlagged: requiresAdminReview,
    memberReviewJustification: input.memberReviewJustification,
  });

  // D-12 facts for the two kinds of row in the proposed party (#2543): the stored
  // status for a row already on the booking, and the status
  // `planMemberGuestConsentWrites` has just decided for a row being added. Built
  // from data already in hand — no extra query.
  const consentStatusByGuestId = new Map(
    booking.guests.map((guest) => [guest.id, guest.consentStatus ?? null]),
  );
  const addedConsentByMemberId = new Map(
    (normalizedAddGuestsWithRanges ?? [])
      .filter((guest) => guest.memberId)
      .map((guest) => [
        guest.memberId as string,
        guest.memberGuestConsent?.consentStatus ?? null,
      ]),
  );

  if (!guestAuthorizationIsAdmin) {
    const unpaidMemberGuests = await findUnpaidMemberGuestNames(tx, {
      bookingMemberId: booking.memberId,
      checkIn: isInProgressEdit && editableFrom ? editableFrom : newCheckIn,
      guests: normalizedAddGuests ?? [],
    });
    // #2543: mode-gated like the five sibling refusal sites. The lookup above
    // still RUNS under NON_MEMBER_PRICING, deliberately — it is what raises the
    // D-8 neutral refusal for an unpaid member guest from beyond the booker's
    // family, and that privacy boundary is not the lockout policy's to relax.
    // Only the refusal is gated. A missing mode reads as HARD_BLOCK.
    if (
      (subscriptionLockoutMode ?? "HARD_BLOCK") === "HARD_BLOCK" &&
      unpaidMemberGuests.length > 0
    ) {
      throw new ApiError(
        `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
        403,
      );
    }

    // #2543 — the paid-up-adult requirement on the APPLY path, over the whole
    // post-modification party.
    //
    // TWO holes closed by putting it here rather than only on the preview.
    // First, `PUT /api/bookings/[id]/modify` is directly reachable without ever
    // calling `modify-quote`, so a requirement enforced only on the preview was
    // bypassable by a client that skips it. Second — and this is the one no add
    // gate could catch — the requirement was evaluated on ADDITIVE writes only,
    // so `removeGuestIds` could take the party's last paid-up adult member off a
    // booking that the add path had just approved on the strength of their
    // presence. Two requests, and the party reaches the state the club configured
    // the rule to refuse, with no review raised. Evaluating the PROPOSED party
    // (remaining + added, which is what `guestsForPricing` is) covers adds,
    // removals and date changes in one place instead of one gate per shape.
    const nonMemberPricing = await evaluateNonMemberPricingRequirements(tx, {
      mode: subscriptionLockoutMode,
      lodgeId: bookingLodgeId,
      seasonYear: seasonYearOfStoredDate(newCheckIn),
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      // Owner decision, 3 Aug 2026. On the apply path this also closes the
      // removal shape of the same hole: an unfinancial owner cannot take their own
      // row off and leave a party they still own with nobody paid-up on it.
      bookingOwnerMemberId: booking.memberId,
      participants: guestsForPricing.map((guest) => ({
        isMember: guest.isMember,
        memberId: guest.memberId ?? null,
        stayStart: guest.stayStart,
        stayEnd: guest.stayEnd,
        nights: guest.nights,
        // D-12: a row already on the booking is judged by its stored
        // consentStatus; a row this modification ADDS is judged by the consent
        // columns `planMemberGuestConsentWrites` has just decided for it.
        operationallyPresent: guest.bookingGuestId
          ? isOperationallyPresentConsent(
              consentStatusByGuestId.get(guest.bookingGuestId) ?? null,
            )
          : isOperationallyPresentConsent(
              addedConsentByMemberId.get(guest.memberId ?? "") ?? null,
            ),
      })),
    });
    if (nonMemberPricing?.violation) {
      throw new PaidUpAdultMemberRequiredError(nonMemberPricing.violation);
    }
  }

  return {
    guestAuthorizationIsAdmin,
    remainingGuests,
    proposedRemainingGuests,
    removedGuests,
    normalizedAddGuests: normalizedAddGuestsWithRanges,
    guestsForPricing,
    totalGuestCount,
    requiresAdminReview,
    adminReviewReason,
    reviewUpdate,
    memberGuestEntries,
    guestMemberLinks,
    guestMemberLinkColumns,
    guestMemberLinkNames,
    otherLodgeElection,
  };
}

function resolveModifyReviewUpdate({
  booking,
  role,
  actorId,
  nowFlagged,
  memberReviewJustification,
}: {
  booking: LoadedBookingForModify;
  role: Role;
  actorId: string;
  nowFlagged: boolean;
  memberReviewJustification: string | undefined;
}): GuestPlan["reviewUpdate"] {
  const wasFlagged = booking.requiresAdminReview;
  const existingStatus = booking.adminReviewStatus;
  const justification = memberReviewJustification?.trim();

  if (!nowFlagged) {
    // Rule cleared. Wipe review state so the booking returns to the
    // normal lifecycle; if it was parked in AWAITING_REVIEW, release it.
    return {
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      adminReviewStatus: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      parkForReview: false,
      releaseFromReview: booking.status === "AWAITING_REVIEW",
    };
  }

  // Still flagged after modification. If review already happened (or is
  // pending), preserve it — admins should not be re-prompted for the same
  // booking just because the guest list shuffled.
  if (wasFlagged && existingStatus !== null) {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification:
        justification ?? booking.memberReviewJustification ?? null,
      adminReviewStatus: existingStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewedById: booking.adminReviewedById,
      adminReviewedAt: booking.adminReviewedAt,
      parkForReview: existingStatus === AdminReviewStatus.PENDING,
      releaseFromReview: false,
    };
  }

  // First time the rule has tripped on this booking.
  if (role === "ADMIN") {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: justification ?? null,
      adminReviewStatus: AdminReviewStatus.APPROVED,
      adminReviewNotes: "Approved at modification by admin.",
      adminReviewedById: actorId,
      adminReviewedAt: new Date(),
      parkForReview: false,
      releaseFromReview: false,
    };
  }

  if (!justification) {
    throw new BookingModifyReviewJustificationRequiredError();
  }

  return {
    requiresAdminReview: true,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    memberReviewJustification: justification,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    parkForReview: true,
    releaseFromReview: false,
  };
}

export async function loadActiveSeasonRates(
  tx: Prisma.TransactionClient,
  lodgeId: string,
): Promise<SeasonRateData[]> {
  const seasons = await tx.season.findMany({
    where: { active: true, ...lodgeNullTolerantScope(lodgeId) },
    include: { membershipTypeRates: true },
  });
  // #2756: through the shared mapper, which carries the season's `type`. This
  // used to hand-roll a four-key literal without it, and because
  // `SeasonRateData.type` is optional that compiled silently and switched the
  // group discount off for every club on the DEFAULT `summerOnly: true` setting —
  // on this function's two consumers, which are the apply path's in-progress
  // planner and its ordinary pricing pass alike.
  return toSeasonRateData(seasons);
}

export type PricingResult = {
  inProgressPlan: BookingEditGuestRangePlan | null;
  // Admin override (issue #1668): true when the target nights were over lodge
  // capacity and the admin confirmed the overbooking. Always false on the
  // normal (hard-blocked) path.
  capacityOverridden: boolean;
  newTotalPriceCents: number;
  priceBreakdown: {
    totalPriceCents: number;
    guests: Array<{ priceCents: number; perNightCents: number[]; nightDates: Date[] }>;
  };
  guestNightRates: Array<{
    bookingGuestId?: string | null;
    memberId: string | null;
    isMember: boolean;
    perNightRates: number[];
    nightDates?: Date[];
  }>;
  /**
   * The existing guests pricing ACTUALLY resolved to the other-lodge member rate
   * (`rateSource: "OTHER_LODGE_MEMBER"`), as opposed to the ones the request
   * asked for (#2978 review).
   *
   * The two are not the same set, and the gap is what let a flag be stored
   * against somebody the money never reached. The election fence is judged
   * against the STORED booking rows; pricing is judged against the PROPOSED
   * rows, which `linkGuestToMember` has already rewritten — so a request that
   * links placeholder G to member M and ticks G passes the fence (G is a
   * placeholder non-member on the stored booking) while pricing correctly
   * resolves M through their own membership type. The charge was right and the
   * stored flag was a lie: the Guests list then reads "(Other Club Member)"
   * against a member of this club, and the stale flag can go live on a later
   * edit if their eligibility changes.
   *
   * `applyGuestChanges` writes the flag from THIS set, so the column and the
   * money are answered by the same pass.
   */
  otherLodgeRatedGuestIds: ReadonlySet<string>;
};

/**
 * The per-night breakdown for one guest of an in-progress edit, in the shape the
 * rest of this file consumes: the nights they hold, what each is worth, and
 * their total.
 *
 * This used to be `splitGuestNightsEvenly`, which took the guest's total and
 * divided it across their nights — so an edit spanning a season boundary stored
 * the average, and `lockedNightPricesForGuest` handed that average to the next
 * edit as the price the member was deemed to have paid (#2744). The plan now
 * computes each night's real amount itself, alongside the price it charges for
 * them, so there is nothing left to split here; the even split survives inside
 * the plan as the fallback for a guest whose stored total cannot be reconciled
 * with their rows (`composeProposedNightPrices`).
 *
 * Integer cents throughout, and `perNightCents` sums to `priceCents` exactly —
 * which is what keeps the Xero lines, rebuilt per contiguous run with
 * `perNightCents * nightCount === totalCents`, free of a phantom balance
 * (INV-MONEY-001, INV-MONEY-003).
 */
function guestNightBreakdown(entry: {
  nights: ReadonlyArray<Date>;
  perNightCents: ReadonlyArray<number>;
  priceCents: number;
}): { priceCents: number; perNightCents: number[]; nightDates: Date[] } {
  return {
    priceCents: entry.priceCents,
    perNightCents: [...entry.perNightCents],
    // #3107: `storedDateOnly`, not `normalizeDateOnlyForTimeZone` (INV-DATE-013).
    // These arrive from the in-progress plan already on the true calendar, and
    // this is the projection that REACHES THE DATABASE - `syncGuestNights`
    // writes these values into `BookingGuestNight.stayDate`, so an in-progress
    // edit stored its nights a day early. The ordinary edit branch takes its
    // nights from `pricing.ts`'s zone-free normaliser and never had the defect.
    nightDates: entry.nights.map((night) => storedDateOnly(night)),
  };
}

/**
 * Split a proposed guest set into admin-flagged partner-sharers and ordinary
 * guests (matched by memberId) and run the #1745 reserved-slot admission
 * check (#1746). Shared by the modify service (which throws on rejection)
 * and the modify-quote preview (which reports the outcome): one splitter, so
 * preview and apply can never disagree on who counts as a sharer.
 *
 * A flagged memberId that matches no proposed guest throws — a sharer flag
 * must always attach to a real member guest in the change. A member holding
 * several ranges (data error) matches once; later duplicates stay ordinary
 * so they cannot widen the shared claim.
 */
export async function resolvePartnerSharedCapacity(params: {
  lodgeId: string;
  rangeStart: Date;
  rangeEnd: Date;
  proposedRanges: Array<{
    stayStart?: Date | null;
    stayEnd?: Date | null;
    nights?: Date[];
    memberId?: string | null;
  }>;
  partnerSharedGuests: Array<{ memberId: string; partnerMemberId: string }>;
  excludeBookingId: string;
  tx?: Prisma.TransactionClient;
}): Promise<Awaited<ReturnType<typeof checkCapacityForPartnerSharedAdmission>>> {
  const sharerByMemberId = new Map(
    params.partnerSharedGuests.map((sharer) => [sharer.memberId, sharer]),
  );
  if (sharerByMemberId.size !== params.partnerSharedGuests.length) {
    // Two flags for one member would otherwise collapse last-wins; reject so
    // a malformed caller payload can never silently change which partner an
    // admission is checked against.
    throw new ApiError(
      "The same guest was flagged as a partner-sharer more than once.",
      400,
    );
  }
  const matchedSharerIds = new Set<string>();
  const ordinary: typeof params.proposedRanges = [];
  const sharers: Array<{
    range: (typeof params.proposedRanges)[number];
    memberId: string;
    partnerMemberId: string;
  }> = [];
  for (const range of params.proposedRanges) {
    const sharer = range.memberId ? sharerByMemberId.get(range.memberId) : undefined;
    if (sharer && !matchedSharerIds.has(sharer.memberId)) {
      matchedSharerIds.add(sharer.memberId);
      sharers.push({
        range,
        memberId: sharer.memberId,
        partnerMemberId: sharer.partnerMemberId,
      });
    } else {
      ordinary.push(range);
    }
  }
  if (matchedSharerIds.size !== sharerByMemberId.size) {
    throw new ApiError(
      "A guest flagged as a partner-sharer is not part of this change (they must be a member guest on the booking).",
      400,
    );
  }

  return checkCapacityForPartnerSharedAdmission(
    params.lodgeId,
    params.rangeStart,
    params.rangeEnd,
    ordinary,
    sharers,
    params.excludeBookingId,
    params.tx,
  );
}

export async function calculateModifiedPricing(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    isInProgressEdit,
    editableFrom,
    newCheckIn,
    newCheckOut,
    normalizedAddGuests,
    removeGuestIds,
    guestsForPricing,
    subscriptionLockoutMode,
    skipBookingLifecycleRules,
    seasonRateData,
    adminOverride = false,
    confirmOverCapacity = false,
    partnerSharedGuests = [],
    skipAuthorization = false,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    isInProgressEdit: boolean;
    editableFrom: Date | null;
    newCheckIn: Date;
    newCheckOut: Date;
    normalizedAddGuests: BookingGuestInput[] | undefined;
    removeGuestIds: string[] | undefined;
    guestsForPricing: Array<{
      bookingGuestId?: string | null;
      ageTier: AgeTier;
      isMember: boolean;
      memberId: string | null;
      stayStart?: Date | null;
      stayEnd?: Date | null;
      nights?: Date[];
      lockedNightPrices?: ReadonlyArray<{
        stayDate: Date | string;
        priceCents: number;
      }> | null;
    }>;
    skipBookingLifecycleRules: boolean;
    seasonRateData: SeasonRateData[];
    // Admin override (issue #1668): under adminOverride, an over-capacity target
    // warns instead of hard-blocking — the write proceeds only when
    // confirmOverCapacity is set, and capacityOverridden is reported back.
    adminOverride?: boolean;
    confirmOverCapacity?: boolean;
    // Partner-shared admission (#1746, admin-only — routes must gate it):
    // each entry flags a proposed guest (matched by memberId) as the second
    // occupant of a shared double with their CONFIRMED partner. Capacity then
    // runs through checkCapacityForPartnerSharedAdmission — reserved slots
    // above the base ceiling, one per active DOUBLE (#1745) — instead of the
    // ordinary check. Fail-loud: a rejection throws with the check's reason
    // and never falls back to the #1668 overbook path (leave sharers
    // unflagged to overbook the blunt way).
    partnerSharedGuests?: Array<{ memberId: string; partnerMemberId: string }>;
    /**
     * True on an admin/on-behalf modification (privacy re-review of MG3 #2308,
     * finding 2). Keeps the detailed membership-type refusal, which names the
     * blocked member; a member-initiated modification gets D-8's collapsed one
     * for a beyond-family target.
     */
    skipAuthorization?: boolean;
    /**
     * #2543 — the mode this request resolved, forwarded to every rate resolution
     * and to the price call below, so all four agree and none of them reads the
     * settings from inside the transaction holding the capacity lock.
     */
    subscriptionLockoutMode?: SubscriptionLockoutMode;
  },
): Promise<PricingResult> {
  const seasonYear = seasonYearOfStoredDate(newCheckIn);
  await assertMembershipTypeBookingAllowed(tx, {
    ownerMemberId: booking.memberId,
    guests: guestsForPricing,
    seasonYear,
    skipAuthorization,
  });

  const policyAdjustedGuestsForPricing = await resolveGuestRateMembershipTypes(tx, {
    seasonYear,
    guests: guestsForPricing,
    subscriptionLockoutMode,
  });
  const policyAdjustedAddGuests = normalizedAddGuests
    ? await resolveGuestRateMembershipTypes(tx, {
        seasonYear,
        guests: normalizedAddGuests,
        subscriptionLockoutMode,
      })
    : undefined;
  const policyAdjustedExistingGuests = await resolveGuestRateMembershipTypes(tx, {
    seasonYear,
    guests: booking.guests.map((guest) => ({
      ...guest,
      ageTier: guest.ageTier as AgeTier,
    })),
    subscriptionLockoutMode,
  });

  // Group discount applies to the newly priced nights (#1095); locked nights
  // keep their booked (discount-inclusive) prices regardless (INV-MOD-006).
  //
  // #2756: read once, here, and handed to BOTH pricing paths below. It used to be
  // read inline in the not-in-progress branch only, which is how the in-progress
  // planner came to be the one edit path that priced without it — so a stay
  // already under way bought its new nights undiscounted. One query either way,
  // on the connection this function is already using, and it takes no lock.
  //
  // #2770 (INV-MOD-026): resolved through the EDIT-time mapper, because both
  // branches below are edits. That is what makes the club's `applyToEdits`
  // switch mean ONE thing per edit: the in-progress planner and the ordinary
  // pricing pass are handed the same value, so they can never disagree about a
  // night's price the way #2756 had them disagree. Off resolves to no config at
  // all — byte-identical to a club that never enabled the discount — and nights
  // already bought keep their stored prices in either state (INV-MOD-005).
  const groupDiscount = toEditTimeGroupDiscountConfig(
    await tx.groupDiscountSetting.findUnique({ where: { id: "default" } }),
  );

  let inProgressPlan: BookingEditGuestRangePlan | null = null;
  if (isInProgressEdit && editableFrom) {
    // #2756: the same mapping the QUOTE route already applies around its own call
    // to this planner (`modify-quote/route.ts`, "Unable to price the requested
    // future-night changes", 400). The plan can fail for the one reason the
    // ordinary pricing pass below can — no season rate covers a night it has to
    // price — and that pass has been mapped to a 400 all along, from inside the
    // `try` further down. This call sits outside it because the capacity check
    // needs the plan first, so the same failure surfaced as an unmapped error on
    // apply while the preview returned a clean 400. Preview and apply now agree on
    // the refusal as well as on the price.
    try {
      inProgressPlan = buildInProgressGuestRangePlan({
        booking: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          finalPriceCents: booking.finalPriceCents,
          guests: policyAdjustedExistingGuests,
        },
        editableFrom,
        newCheckOut,
        addGuests: policyAdjustedAddGuests,
        removeGuestIds,
        seasons: seasonRateData,
        groupDiscount,
      });
    } catch (error) {
      // An ApiError is already a decided refusal with its own wording and status
      // (the plan's own guards do not raise one today, but re-throwing keeps this
      // from ever swallowing one that is added later).
      if (error instanceof ApiError) {
        throw error;
      }
      logger.error(
        { err: error, bookingId: booking.id },
        "Failed to build the in-progress edit plan",
      );
      throw new ApiError("No season rate found for the requested dates", 400);
    }
  }

  const pricingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
  let capacity: Awaited<ReturnType<typeof checkCapacityForGuestRanges>>;
  let capacityOverridden = false;
  if (skipBookingLifecycleRules) {
    capacity = { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };
  } else if (partnerSharedGuests.length > 0) {
    // Partner-shared admission (#1746): fail-loud on any rejection — the
    // #1668 overbook path stays a deliberately separate, unflagged action.
    const shared = await resolvePartnerSharedCapacity({
      lodgeId: pricingLodgeId,
      // #2029: use the plan's capacityRangeStart (not editableFrom) so a
      // check-out-day extension's newly-occupied night is inside the checked
      // window; it equals editableFrom for every mid-stay / last-night edit.
      rangeStart:
        inProgressPlan && editableFrom
          ? inProgressPlan.capacityRangeStart
          : newCheckIn,
      rangeEnd: newCheckOut,
      proposedRanges:
        inProgressPlan && editableFrom
          ? inProgressPlan.capacityGuestRanges
          : policyAdjustedGuestsForPricing,
      partnerSharedGuests,
      excludeBookingId: bookingId,
      tx,
    });
    if (!shared.available) {
      throw new ApiError(
        shared.reason ?? "Not enough partner-shared capacity for these changes",
        400,
      );
    }
    capacity = {
      available: true,
      minAvailable: shared.minAvailable,
      nightDetails: shared.nightDetails,
    };
  } else {
    capacity =
      inProgressPlan && editableFrom
        ? await checkCapacityForGuestRanges(
            pricingLodgeId,
            // #2029: capacityRangeStart, not editableFrom — see the
            // partner-shared branch above; unchanged for mid-stay edits.
            inProgressPlan.capacityRangeStart,
            newCheckOut,
            inProgressPlan.capacityGuestRanges,
            bookingId,
            tx,
          )
        : await checkCapacityForGuestRanges(
            pricingLodgeId,
            newCheckIn,
            newCheckOut,
            policyAdjustedGuestsForPricing,
            bookingId,
            tx,
          );
    if (!capacity.available) {
      if (!adminOverride) {
        // Member / non-override path: a held night is unavailable exactly like a
        // full lodge (ADR-001 decision 6, issue #118) — no exclusive signal.
        throw new ApiError("Not enough beds available for these changes", 400);
      }
      if (!confirmOverCapacity) {
        throw new OverCapacityConfirmationRequiredError(overCapacityNights(capacity));
      }
      // Admin explicitly confirmed the overbooking. An exclusive hold is NOT
      // bypassable by the override (ADR-001 decision 5, issue #118) — refuse
      // before reporting capacityOverridden so no guest is admitted onto a held
      // night.
      const blocked = wholeLodgeBlockedNights(capacity);
      if (blocked.length > 0) {
        throw new WholeLodgeHoldBlockedError(blocked);
      }
      // proceed and report it so the caller can audit capacityOverridden.
      capacityOverridden = true;
    }
  }

  let priceBreakdown: PricingResult["priceBreakdown"];
  try {
    priceBreakdown = inProgressPlan
      ? {
          totalPriceCents: inProgressPlan.newTotalPriceCents,
          guests: [
            ...inProgressPlan.proposedExistingGuests.map(guestNightBreakdown),
            ...inProgressPlan.proposedAddedGuests.map(guestNightBreakdown),
          ],
        }
      : await priceBookingGuestsWithMembershipTypePolicy(tx, {
          ownerMemberId: booking.memberId,
          checkIn: newCheckIn,
          checkOut: newCheckOut,
          guests: policyAdjustedGuestsForPricing,
          seasons: seasonRateData,
          // The one gated value hoisted above (#2756 read-once, #2770 gate) —
          // the same object the in-progress planner was handed, so the two
          // branches cannot price a night differently.
          groupDiscount,
          seasonYear,
          skipAuthorization,
          subscriptionLockoutMode,
        });
  } catch (error) {
    if (error instanceof MembershipTypeBookingPolicyError) {
      throw error;
    }
    throw new ApiError("No season rate found for the requested dates", 400);
  }

  const newTotalPriceCents = priceBreakdown.totalPriceCents;
  const guestNightRates = inProgressPlan
    ? []
    : guestsForPricing.map((guest, index) => ({
        memberId: guest.memberId ?? null,
        bookingGuestId: guest.bookingGuestId ?? null,
        isMember: guest.isMember,
        perNightRates: priceBreakdown.guests[index]?.perNightCents ?? [],
        // Dates the positional rates so internal work-party promos restrict
        // the discount to the event's night window — correct for gaps too.
        firstNight: guest.stayStart ?? newCheckIn,
        nightDates: priceBreakdown.guests[index]?.nightDates ?? [],
      }));

  return {
    inProgressPlan,
    capacityOverridden,
    newTotalPriceCents,
    priceBreakdown,
    guestNightRates,
    // #2978 review: read off the rated rows the pricing engine was handed, so
    // "who carries the flag" and "who was charged the member rate" can only ever
    // be the same answer. Empty on the in-progress branch, whose prices come
    // from the plan rather than these rows — and where the election is refused
    // outright (`OTHER_LODGE_RATE_IN_PROGRESS_MESSAGE`), so nothing is written
    // there anyway.
    otherLodgeRatedGuestIds: new Set(
      inProgressPlan
        ? []
        : policyAdjustedGuestsForPricing
            .filter(
              (guest) =>
                guest.rateSource === "OTHER_LODGE_MEMBER" &&
                Boolean(guest.bookingGuestId),
            )
            .map((guest) => guest.bookingGuestId as string),
    ),
  };
}

export type PromoChangeResult = {
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  promoRemoved: boolean;
  promoChanged: boolean;
  // #2390: set only when a usage cap stopped the promotion reaching somebody on
  // the repriced booking; null means everyone it applies to is covered.
  promoCoverage: PromoCoverageNotice | null;
};

function promoRequiresStoredGuestTargets(
  promo: PromoCode & { assignments: Array<{ memberId: string }> }
) {
  return promo.assignments.length > 0 && promo.assignedMembersOnlyOwnNights === false;
}

function selectedIndexesForStoredGuestTargets(
  redemption: LoadedPromoRedemption,
  guestNightRates: Array<{ bookingGuestId?: string | null }>
) {
  if (!promoRequiresStoredGuestTargets(redemption.promoCode)) {
    return undefined;
  }

  const targetIds = new Set((redemption.guestTargets ?? []).map((target) => target.bookingGuestId));
  if (targetIds.size === 0) {
    return guestNightRates.map((_, index) => index);
  }

  return guestNightRates
    .map((guest, index) => (guest.bookingGuestId && targetIds.has(guest.bookingGuestId) ? index : -1))
    .filter((index) => index >= 0);
}

function targetBookingGuestIdsForSelectedIndexes(
  guestNightRates: Array<{ bookingGuestId?: string | null }>,
  selectedGuestIndexes: number[] | undefined
) {
  if (!selectedGuestIndexes) return undefined;
  return selectedGuestIndexes
    .map((index) => guestNightRates[index]?.bookingGuestId)
    .filter((id): id is string => Boolean(id));
}

/**
 * Resolve a request's promo beneficiaries to positional indexes over the
 * priced guest list (#2266, MED-4).
 *
 * EXISTING guests are bound by `bookingGuestId`, never by position: the
 * pricing order is [remaining guests..., added guests...] as of APPLY time,
 * so a positional index chosen at preview time would be re-bound to whatever
 * that list happens to be when the save lands — a concurrent edit by another
 * session between preview and save would silently redeem the discount for
 * the wrong guest. An id that no longer resolves refuses loudly instead.
 *
 * TO-BE-ADDED guests have no id yet, so they alone remain positional —
 * relative to this same request's `addGuests` array, which nothing concurrent
 * can reorder.
 *
 * Shared by the apply path (applyPromoCodeChanges) and the modify-quote
 * preview so the two can never disagree about who a code covers.
 */
export function resolvePromoBeneficiarySelection({
  guestNightRates,
  addedGuestCount,
  promoGuestIds,
  promoAddedGuestIndexes,
}: {
  /** Priced guests in apply order: remaining (with ids) then added (no ids). */
  guestNightRates: Array<{ bookingGuestId?: string | null }>;
  /** How many TO-BE-ADDED guests sit at the tail of guestNightRates. */
  addedGuestCount: number;
  promoGuestIds?: string[];
  promoAddedGuestIndexes?: number[];
}): number[] | undefined {
  if (!promoGuestIds?.length && !promoAddedGuestIndexes?.length) {
    return undefined;
  }

  const indexByGuestId = new Map<string, number>();
  guestNightRates.forEach((guest, index) => {
    if (guest.bookingGuestId) indexByGuestId.set(guest.bookingGuestId, index);
  });

  const selected = new Set<number>();
  for (const guestId of promoGuestIds ?? []) {
    const index = indexByGuestId.get(guestId);
    if (index === undefined) {
      throw new ApiError(
        "A guest selected for the promo code is no longer on this booking — refresh and re-apply the code",
        400,
      );
    }
    selected.add(index);
  }

  const addedStartIndex = guestNightRates.length - addedGuestCount;
  for (const addedIndex of promoAddedGuestIndexes ?? []) {
    if (
      !Number.isInteger(addedIndex) ||
      addedIndex < 0 ||
      addedIndex >= addedGuestCount
    ) {
      throw new ApiError(
        "A guest selected for the promo code is not part of this change",
        400,
      );
    }
    selected.add(addedStartIndex + addedIndex);
  }

  return [...selected].sort((a, b) => a - b);
}

export async function applyPromoCodeChanges(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    input,
    inProgressPlan,
    newCheckIn,
    newTotalPriceCents,
    guestNightRates,
    todayAtClub,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    input: BatchModifyInput;
    inProgressPlan: BookingEditGuestRangePlan | null;
    newCheckIn: Date;
    newTotalPriceCents: number;
    guestNightRates: Array<{
      bookingGuestId?: string | null;
      memberId: string | null;
      isMember: boolean;
      perNightRates: number[];
    }>;
    /**
     * The club's own calendar day (#3123, `INV-CONFIG-002`), resolved by the
     * caller BEFORE it opened the transaction whose client arrives as `tx`.
     *
     * REQUIRED. `INV-LOCK-004` names the club timezone as one of only two reads
     * that cannot take a transaction client, and every caller of this function
     * holds `pg_advisory_xact_lock(1)` plus the per-lodge capacity key by the
     * time it gets here. It decides the promotion's validity window, so a day
     * from the container's zone instead of the club's could refuse a live
     * promotion or honour an expired one.
     */
    todayAtClub: CalendarDate;
  },
): Promise<PromoChangeResult> {
  if (inProgressPlan) {
    return {
      newDiscountCents: inProgressPlan.newDiscountCents,
      newPromoAdjustmentCents: inProgressPlan.newPromoAdjustmentCents,
      promoRemoved: false,
      promoChanged: false,
      // An in-progress plan reuses prices already agreed; it re-runs no cap.
      promoCoverage: null,
    };
  }

  let newDiscountCents = 0;
  let newPromoAdjustmentCents = 0;
  let promoRemoved = false;
  let promoChanged = false;
  let promoCoverage: PromoCoverageNotice | null = null;
  const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));

  // Row-lock every promo code whose usage caps this transaction may charge or
  // refund, BEFORE the first cap read and the first counter write (#2299).
  // Booking creation has locked its promo row for a long time; none of the four
  // modification paths did, so two concurrent modifications could both pass a
  // "one use left" check. (The other three now take the same lock via
  // `lockAndRefreshPromoCodeUsage`; this one may touch TWO codes, so it uses the
  // multi-id form.) `lockPromoCodeRowsForUpdate` sorts the ids, so the outgoing
  // and incoming codes of a swap are always taken in the same global order and
  // no two transactions can build a cycle.
  const incomingPromoCodeId =
    input.promoCode && !input.removePromoCode
      ? (
          await tx.promoCode.findUnique({
            where: { code: input.promoCode.toUpperCase().trim() },
            select: { id: true },
          })
        )?.id
      : undefined;
  await lockPromoCodeRowsForUpdate(tx, [
    booking.promoRedemption?.promoCodeId,
    incomingPromoCodeId,
  ]);

  if (input.removePromoCode && booking.promoRedemption) {
    await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
    promoRemoved = true;
  }

  if (input.promoCode && !input.removePromoCode) {
    if (booking.promoRedemption && !promoRemoved) {
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
      promoRemoved = true;
    }

    // Re-read under the lock taken above, so the caps this validation sees are
    // the caps the redemption below consumes.
    const promoCode = await tx.promoCode.findUnique({
      where: { code: input.promoCode.toUpperCase().trim() },
      include: {
        assignments: { select: { memberId: true } },
        lodges: { select: { lodgeId: true } },
      },
    });

    // Internal promos (work party events) cannot be entered as codes.
    if (!promoCode || promoCode.internal) {
      throw new ApiError("Promo code not found", 400);
    }

    const assignedMemberIds = promoCode.assignments.length
      ? promoCode.assignments.map((assignment) => assignment.memberId)
      : null;
    const application = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        memberId: booking.memberId,
        bookingCheckIn: newCheckIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      assignedMemberIds,
      {
        excludeBookingId: bookingId,
        db: tx,
        // #2266 (MED-4): existing beneficiaries arrive bound by bookingGuestId
        // and are resolved against THIS transaction's priced guest list, so a
        // concurrent edit can never re-point the discount; stale ids 400.
        selectedGuestIndexes: resolvePromoBeneficiarySelection({
          guestNightRates,
          addedGuestCount: input.addGuests?.length ?? 0,
          promoGuestIds: input.promoGuestIds,
          promoAddedGuestIndexes: input.promoAddedGuestIndexes,
        }),
        lodgeId: bookingLodgeId,
        // #3123 — resolved by the caller before this transaction opened.
        todayAtClub,
      },
    );
    if (application.error || !application.discount) {
      throw new ApiError(application.error ?? "Promo code could not be applied", 400);
    }

    const promoResult = application.discount;
    newDiscountCents = promoResult.discountCents;
    newPromoAdjustmentCents = promoResult.priceAdjustmentCents;

    if (shouldPersistPromoRedemption(promoResult)) {
      await redeemPromoCode(
        tx,
        promoCode.id,
        bookingId,
        booking.memberId,
        newDiscountCents,
        newPromoAdjustmentCents,
        promoResult.freeNightsUsed,
        promoResult.eligibleGuestCount,
        promoResult.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
        bookingLodgeId,
      );
    }
    promoChanged = true;
  } else if (
    !input.removePromoCode &&
    !promoRemoved &&
    booking.promoRedemption?.promoCode
  ) {
    // The lock is already held (taken above for both codes of a possible swap),
    // but this snapshot was loaded with the booking, BEFORE it — so re-read the
    // usage counter under the lock. Locking and then deciding against a number
    // read outside the lock would leave the race open (#2299).
    const promo = await lockAndRefreshPromoCodeUsage(
      tx,
      booking.promoRedemption.promoCode
    );
    const selectedGuestIndexes = selectedIndexesForStoredGuestTargets(
      booking.promoRedemption,
      guestNightRates
    );
    const application = await validateAndCalculatePromoDiscount(
      promo,
      {
        memberId: booking.memberId,
        bookingCheckIn: newCheckIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      promo.assignments.length > 0
        ? promo.assignments.map((assignment) => assignment.memberId)
        : null,
      {
        excludeBookingId: bookingId,
        db: tx,
        selectedGuestIndexes,
        lodgeId: bookingLodgeId,
        // #2390: the reprice branch keeps the code the booking already has, so
        // a cap must narrow who it covers rather than refuse the whole edit.
        // The swap branch above deliberately does NOT do this: there the member
        // is applying a code, nobody holds a discount from it yet, and "this
        // code is full" is the honest answer.
        capOverflow: "coverExisting",
        // #3123 — resolved by the caller before this transaction opened.
        todayAtClub,
      },
    );

    if (application.error || !application.discount) {
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
      promoRemoved = true;
    } else {
      const promoResult = application.discount;
      newDiscountCents = promoResult.discountCents;
      newPromoAdjustmentCents = promoResult.priceAdjustmentCents;
      promoCoverage = await describePromoCapCoverage(tx, {
        promoCode: promo.code,
        capCoverage: application.capCoverage,
      });

      await replacePromoRedemptionAllocations(
        tx,
        booking.promoRedemption,
        newDiscountCents,
        newPromoAdjustmentCents,
        promoResult.freeNightsUsed,
        promoResult.eligibleGuestCount,
        promoResult.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
      );
    }
  }

  return {
    newDiscountCents,
    newPromoAdjustmentCents,
    promoRemoved,
    promoChanged,
    promoCoverage,
  };
}

/**
 * `db` is REQUIRED and reads the cancellation policy set: this module is
 * transaction-scoped and imports no module-level client, so a default would hide
 * a second pooled connection under the caller's locks. `INV-LOCK-004`; see
 * `CancellationPolicyDb` in `cancellation.ts`.
 */
export async function calculateModificationChangeFee({
  booking,
  newCheckIn,
  checkInChanged,
  skipBookingLifecycleRules,
  db,
  todayAtClub,
}: {
  booking: LoadedBookingForModify;
  newCheckIn: Date;
  checkInChanged: boolean;
  skipBookingLifecycleRules: boolean;
  db: CancellationPolicyDb;
  /**
   * The club's own calendar day (#3123), resolved by the caller BEFORE it opened
   * the transaction `db` belongs to — `INV-LOCK-004`, the same rule that makes
   * `db` required here. It is the late-notice change fee's tier boundary, so
   * the container's day instead of the club's charged a member the wrong fee
   * band at the edge.
   */
  todayAtClub: CalendarDate;
}): Promise<number> {
  if (skipBookingLifecycleRules || !checkInChanged) {
    return 0;
  }
  // #2266: no change fee on a DRAFT — nothing has been committed to, exactly
  // like moving the dates in the wizard before saving. Member draft edits do
  // not take the admin skip above, so the guard must be explicit.
  if (booking.status === BookingStatus.DRAFT) {
    return 0;
  }
  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, db);
  const feeResult = calculateChangeFee({
    // #3123 — one club day for both operands, so the old and new day-counts
    // cannot be measured from two different todays.
    daysUntilOriginalCheckIn: daysUntilDate(booking.checkIn, todayAtClub),
    daysUntilNewCheckIn: daysUntilDate(newCheckIn, todayAtClub),
    originalFinalPriceCents: booking.finalPriceCents,
    policyRules: policy,
  });
  return feeResult.feeCents;
}

export async function applyGuestChanges(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    newCheckIn,
    newCheckOut,
    removedGuests,
    remainingGuests,
    proposedRemainingGuests,
    normalizedAddGuests,
    guestNameUpdates,
    guestMemberLinks,
    priceBreakdown,
    inProgressPlan,
    otherLodgeElection,
    otherLodgeRatedGuestIds,
  }: {
    bookingId: string;
    newCheckIn: Date;
    newCheckOut: Date;
    removedGuests: BookingGuest[];
    remainingGuests: BookingGuest[];
    proposedRemainingGuests: ProposedRemainingGuest[];
    // Carries the MG2 consent columns straight from `prepareGuestPlan` (#2307).
    normalizedAddGuests:
      | Array<BookingGuestInput & MemberGuestConsentGuestFields>
      | undefined;
    guestNameUpdates?: ResolvedGuestNameUpdate[];
    // #2337: the member identity (and any consent columns) to stamp onto each
    // linked EXISTING placeholder row, keyed by guestId. The row is re-rated by
    // the pricing pass above; this write records who it is now FOR.
    guestMemberLinks?: Map<
      string,
      {
        memberId: string;
        firstName?: string | null;
        lastName?: string | null;
        consentColumns?: MemberGuestConsentColumns;
      }
    >;
    priceBreakdown: PricingResult["priceBreakdown"];
    inProgressPlan: BookingEditGuestRangePlan | null;
    /**
     * The resolved other-club rate election (Other Lodges epic), straight off the
     * plan that priced these rows. Optional so this function's existing unit
     * tests keep compiling; absent means "no election", which writes no flag.
     */
    otherLodgeElection?: OtherLodgeRateElection;
    /**
     * Who the pricing pass actually rated as an other-lodge member
     * (`PricingResult.otherLodgeRatedGuestIds`, #2978 review). A tick pricing did
     * NOT honour is stored as `false`, not as the officer asked — the flag is a
     * record of what was charged, and a `true` the money never followed is the
     * one state it must never hold. Absent is treated as "nothing was rated",
     * which is correct for the existing unit tests that pass no election either.
     */
    otherLodgeRatedGuestIds?: ReadonlySet<string>;
  },
): Promise<{ createdGuests: BookingGuest[] }> {
  const createdGuests: BookingGuest[] = [];
  const nameUpdatesByGuestId = new Map(
    (guestNameUpdates ?? []).map((update) => [update.guestId, update]),
  );
  const linkByGuestId = guestMemberLinks ?? new Map();

  type BreakdownGuest = { nightDates: Date[]; perNightCents: number[] };

  // Re-sync a guest's BookingGuestNight rows to the priced nights (issue #713),
  // and return the matching stayStart/stayEnd envelope. Called on every guest
  // write so a guest's gaps are persisted and stale nights never linger.
  //
  // #2736: that promise used to be broken on the IN-PROGRESS branch below, which
  // is the one place the priced nights did not come from a real night set — the
  // plan expanded its envelope, so this deleted a sparse guest's rows and wrote
  // back a continuous run, filling the gap for good. The plan now carries the
  // night list (INV-MOD-025) and this is the only writer that needs to know.
  const syncGuestNights = async (
    bookingGuestId: string,
    bg: BreakdownGuest | undefined,
    fallbackStart: Date,
    fallbackEnd: Date,
  ): Promise<{ stayStart: Date; stayEnd: Date }> => {
    await tx.bookingGuestNight.deleteMany({ where: { bookingGuestId } });
    const nightDates = bg?.nightDates ?? [];
    if (nightDates.length > 0) {
      await tx.bookingGuestNight.createMany({
        data: nightDates.map((stayDate, k) => ({
          bookingGuestId,
          stayDate,
          priceCents: bg?.perNightCents[k] ?? 0,
        })),
      });
      return {
        stayStart: nightDates[0],
        stayEnd: addDaysDateOnly(nightDates[nightDates.length - 1], 1),
      };
    }
    return { stayStart: fallbackStart, stayEnd: fallbackEnd };
  };

  if (inProgressPlan) {
    const existingCount = inProgressPlan.proposedExistingGuests.length;
    for (let e = 0; e < existingCount; e++) {
      const entry = inProgressPlan.proposedExistingGuests[e];
      const nameUpdate = nameUpdatesByGuestId.get(entry.guest.id);
      // #2337: stamp the member identity onto a linked existing row here too, for
      // identity consistency if a link ever rides the in-progress path (the
      // re-rate itself lives on the recalculate path, which prices from
      // guestsForPricing rather than this plan).
      const link = linkByGuestId.get(entry.guest.id);
      const envelope = await syncGuestNights(
        entry.guest.id,
        priceBreakdown.guests[e],
        entry.stayStart,
        entry.stayEnd,
      );
      await tx.bookingGuest.update({
        where: { id: entry.guest.id },
        data: {
          ...(nameUpdate
            ? {
                firstName: nameUpdate.firstName,
                lastName: nameUpdate.lastName,
              }
            : {}),
          ...(link
            ? {
                isMember: true,
                memberId: link.memberId,
                // Display the member's name, like an added member guest; keep the
                // placeholder name only if the member record has none.
                ...(link.firstName && link.lastName
                  ? { firstName: link.firstName, lastName: link.lastName }
                  : {}),
                ...(link.consentColumns ?? {}),
              }
            : {}),
          stayStart: envelope.stayStart,
          stayEnd: envelope.stayEnd,
          priceCents: entry.priceCents,
        },
      });
    }

    for (let a = 0; a < inProgressPlan.proposedAddedGuests.length; a++) {
      const entry = inProgressPlan.proposedAddedGuests[a];
      const g = entry.guest;
      const guest = await tx.bookingGuest.create({
        data: {
          bookingId,
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier,
          isMember: g.isMember,
          memberId: g.memberId || null,
          stayStart: entry.stayStart,
          stayEnd: entry.stayEnd,
          priceCents: entry.priceCents,
          // Persist the resolved rate-type snapshot on the added guest (#1930,
          // E4).
          rateMembershipTypeId: g.rateMembershipTypeId,
          // Member-guest consent (MG2 #2307), decided by
          // `buildMemberGuestConsentWrite` and spread only when present, so a
          // family-scope or non-member guest writes exactly what it wrote before.
          ...(g.memberGuestConsent ?? {}),
        },
      });
      const envelope = await syncGuestNights(
        guest.id,
        priceBreakdown.guests[existingCount + a],
        entry.stayStart,
        entry.stayEnd,
      );
      if (
        envelope.stayStart.getTime() !== guest.stayStart.getTime() ||
        envelope.stayEnd.getTime() !== guest.stayEnd.getTime()
      ) {
        await tx.bookingGuest.update({
          where: { id: guest.id },
          data: { stayStart: envelope.stayStart, stayEnd: envelope.stayEnd },
        });
      }
      createdGuests.push(guest);
    }

    return { createdGuests };
  }

  for (const guest of removedGuests) {
    await tx.choreAssignment.deleteMany({
      where: { bookingGuestId: guest.id },
    });
    // BookingGuestNight rows cascade-delete with the guest.
    await tx.bookingGuest.delete({ where: { id: guest.id } });
  }

  const addedGuestStartIndex = remainingGuests.length;
  const addList = normalizedAddGuests ?? [];
  for (let i = 0; i < addList.length; i++) {
    const g = addList[i];
    const guestPriceIndex = addedGuestStartIndex + i;
    const bg = priceBreakdown.guests[guestPriceIndex];
    const guest = await tx.bookingGuest.create({
      data: {
        bookingId,
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId || null,
        stayStart: g.stayStart ?? newCheckIn,
        stayEnd: g.stayEnd ?? newCheckOut,
        priceCents: bg.priceCents,
        // Persist the resolved rate-type snapshot on the added guest (#1930,
        // E4).
        rateMembershipTypeId: (bg as { rateMembershipTypeId?: string | null })
          .rateMembershipTypeId,
        // Member-guest consent (MG2 #2307) — see the in-progress branch above.
        ...(g.memberGuestConsent ?? {}),
      },
    });
    const envelope = await syncGuestNights(
      guest.id,
      bg,
      newCheckIn,
      newCheckOut,
    );
    if (
      envelope.stayStart.getTime() !== guest.stayStart.getTime() ||
      envelope.stayEnd.getTime() !== guest.stayEnd.getTime()
    ) {
      await tx.bookingGuest.update({
        where: { id: guest.id },
        data: { stayStart: envelope.stayStart, stayEnd: envelope.stayEnd },
      });
    }
    createdGuests.push(guest);
  }

  for (let i = 0; i < remainingGuests.length; i++) {
    const proposedRange = proposedRemainingGuests[i];
    const nameUpdate = nameUpdatesByGuestId.get(remainingGuests[i].id);
    // #2337: a placeholder→member link stamps the member identity onto this
    // existing row (today this loop wrote only names here). The row was already
    // repriced at the member rate above via its cleared lockedNightPrices; this
    // records who it is FOR, plus any beyond-family consent columns.
    const link = linkByGuestId.get(remainingGuests[i].id);
    const envelope = await syncGuestNights(
      remainingGuests[i].id,
      priceBreakdown.guests[i],
      proposedRange?.stayStart ?? newCheckIn,
      proposedRange?.stayEnd ?? newCheckOut,
    );
    await tx.bookingGuest.update({
      where: { id: remainingGuests[i].id },
      data: {
        ...(nameUpdate
          ? {
              firstName: nameUpdate.firstName,
              lastName: nameUpdate.lastName,
            }
          : {}),
        ...(link
          ? {
              isMember: true,
              memberId: link.memberId,
              // #2337: display the member's canonical name, like an added member
              // guest and like the in-progress branch above; keep the "Guest N"
              // placeholder name only when the member record carries none. Without
              // this the row stays "Guest N" while flagged as the member, and the
              // post-commit Xero name-sync pushes the stale placeholder onto the
              // invoice.
              ...(link.firstName && link.lastName
                ? { firstName: link.firstName, lastName: link.lastName }
                : {}),
              ...(link.consentColumns ?? {}),
            }
          : {}),
        stayStart: envelope.stayStart,
        stayEnd: envelope.stayEnd,
        priceCents: priceBreakdown.guests[i].priceCents,
        // Other Lodges epic: the tick this row now carries. Written ONLY for the
        // guests whose flag this request actually changed, so an unrelated edit
        // never rewrites a settled row — and written here, in the same update as
        // the price it produced, so the flag and the money can never disagree.
        //
        // #2978 review: `true` is conditional on PRICING having resolved this row
        // to the other-lodge member rate, not merely on the election having asked
        // for it. The two fences read different inputs — the election is judged
        // against the STORED booking, pricing against the PROPOSED rows, which
        // `linkGuestToMember` has already rewritten — so a request that links a
        // placeholder to a member AND ticks it used to store `true` on a member
        // of this club. Unticking is unconditional in the other direction: a
        // request that clears somebody's flag always clears it, or a stale flag
        // could never be removed.
        ...(otherLodgeElection?.repriceGuestIds.has(remainingGuests[i].id)
          ? {
              otherLodgeMember:
                otherLodgeElection.flaggedGuestIds.has(
                  remainingGuests[i].id,
                ) &&
                (otherLodgeRatedGuestIds?.has(remainingGuests[i].id) ?? false),
            }
          : {}),
        // Overwrite the rate-type snapshot on the full-reprice path (#1930,
        // E4) — but ONLY when this guest kept no locked night, or the newly
        // resolved code would be posted over member-rate nights too (#2543).
        // The in-progress-edit path builds guests without a snapshot, so this is
        // undefined there as well and Prisma leaves the stored snapshot
        // untouched. See `rateSnapshotUpdateForRepricedGuest`.
        rateMembershipTypeId: rateSnapshotUpdateForRepricedGuest(
          priceBreakdown.guests[i] as {
            rateMembershipTypeId?: string | null;
            nightDates?: Date[];
          },
          link ||
            otherLodgeElection?.repriceGuestIds.has(remainingGuests[i].id)
            ? []
            : lockedNightPricesForGuest(proposedRange?.guest ?? {}),
        ),
      },
    });
  }

  return { createdGuests };
}

export async function applyChoreCleanup(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    newCheckIn,
    newCheckOut,
    datesChanged,
    rosterDatesAlreadyLocked = false,
  }: {
    bookingId: string;
    newCheckIn: Date;
    newCheckOut: Date;
    datesChanged: boolean;
    rosterDatesAlreadyLocked?: boolean;
  },
): Promise<string[]> {
  let choreWarnings: string[] = [];
  if (datesChanged) {
    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      bookingId,
      newCheckIn,
      newCheckOut,
      { rosterDatesAlreadyLocked },
    );
    choreWarnings = result.choreWarnings;
  }
  const rangeCleanup = await cleanupChoreAssignmentsForGuestStayRanges(
    tx,
    bookingId,
    { rosterDatesAlreadyLocked },
  );
  return [...choreWarnings, ...rangeCleanup.choreWarnings];
}
