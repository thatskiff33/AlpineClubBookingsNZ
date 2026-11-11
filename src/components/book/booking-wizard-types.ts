import type { AgeTier } from "@prisma/client";
import { buildProfilePathWithReturnTo } from "@/lib/internal-return-path";

export interface FamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  relationship: "self" | "partner" | "dependent";
  canLogin?: boolean;
  canBeBooked?: boolean;
  missingFields?: string[];
  needsOwnLoginConfirmation?: boolean;
  canCurrentUserConfirmDetails?: boolean;
  pendingRequestStatus?: string | null;
  pendingRequests?: Array<{
    id: string;
    type: string;
    status: string;
    familyGroupId: string;
  }>;
  pendingRequestFamilyGroupIds?: string[];
  bookableFamilyGroupIds?: string[];
  action?:
    | "complete_details"
    | "own_login_required"
    | "pending_admin_approval"
    | "contact_admin"
    | null;
}

export interface RoomOption {
  id: string;
  name: string;
  bedCount: number;
}

export interface PriceQuote {
  guests: {
    ageTier: string;
    isMember: boolean;
    nights: number;
    priceCents: number;
    perNightCents?: number[];
    nightDates?: string[];
  }[];
  totalPriceCents: number;
  availableCreditCents?: number;
  // The deferred non-member "guest portion" in integer cents (#2003): the
  // non-member subset priced the way booking-create charges the split child
  // (group discount qualifies only when the subset itself meets minGroupSize).
  // The review-step banner shows this figure so its "about $X" equals what is
  // actually deferred. Null when there are no non-member guests; absent only on
  // an old cached response predating the field, where the banner falls back to
  // summing the whole-party non-member rows.
  deferredGuestPortionCents?: number | null;
  // The member-facing sentence explaining that a membership subscription on this
  // booking is unpaid, so member rates are not available for those nights
  // (#2543). Built SERVER-side by `formatUnpaidSubscriptionRateReason` and
  // returned by POST /api/bookings/quote, so the review step renders it
  // VERBATIM — never re-worded, never rebuilt client-side. Null whenever nobody
  // on the party is being repriced (the club is not in NON_MEMBER_PRICING, or
  // every subscription is settled); absent only on an old cached response
  // predating the field, which the review step treats exactly as null.
  subscriptionMemberRateNotice?: string | null;
  // True when saving this party WOULD be refused for having no paid-up adult
  // member staying on it (#2543). The quote reports it so the review step can
  // warn BEFORE the member fills in the rest of the wizard, rather than letting
  // them hit the refusal on submit. Advisory only: the server owns the refusal
  // and a Booking Officer can approve an override, so it never gates the button.
  // Absent only on an old cached response predating the field, which the review
  // step treats exactly as false.
  //
  // Set INDEPENDENTLY of `subscriptionMemberRateNotice`, and one combination is
  // the whole reason to say so: owner decision 3 Aug 2026 fires the requirement
  // when the person BOOKING has an unpaid subscription, whether or not they stay,
  // so a party of non-members booked by an unfinancial member returns this flag
  // true with a null notice — nothing was repriced, and there is no price to
  // explain. Do not treat the notice as a precondition for showing the warning.
  paidUpAdultMemberMissing?: boolean;
  nonMemberHoldDecision?: {
    enabled: boolean;
    holdDays: number;
    source: "default" | "period";
    daysUntilCheckIn: number;
    shouldBePending: boolean;
    status: string;
  };
}

export interface WorkPartyEvent {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string;
  discountPercent: number;
  lodgeName: string | null;
}

export type BookingPaymentMethod = "stripe" | "internet_banking";

export type BookingWizardStep = "dates" | "guests" | "review" | "pay";

export type GroupPaymentMode = "EACH_PAYS_OWN" | "ORGANISER_PAYS";

export interface CreatedBooking {
  id: string;
  status: string;
  amountCents: number;
  returnUrl: string;
}

export interface AvailablePromoCode {
  code: string;
  description: string | null;
  type: string;
  percentOff: number | null;
  valueCents: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: string | null;
}

export const PROFILE_FAMILY_GROUP_RETURN_TO_BOOK = buildProfilePathWithReturnTo(
  "/book",
  "family-group",
);

/** The club's three subscription-lockout regimes (#2543), mirroring Prisma. */
export type SubscriptionLockoutMode =
  | "NO_BLOCK"
  | "HARD_BLOCK"
  | "NON_MEMBER_PRICING";

const SUBSCRIPTION_LOCKOUT_MODES: readonly SubscriptionLockoutMode[] = [
  "NO_BLOCK",
  "HARD_BLOCK",
  "NON_MEMBER_PRICING",
];

/** What the wizard's unpaid-subscription banner needs to say the true thing. */
export interface SubscriptionLockoutView {
  mode: SubscriptionLockoutMode;
  /** The server's own "why you are priced as a non-member" sentence, verbatim. */
  memberRateNotice: string | null;
}

/**
 * Read the lockout regime off a `GET /api/member/subscription-status` response
 * (#2543).
 *
 * WHY THIS VALIDATES RATHER THAN CASTS: the same unpaid subscription means three
 * different things to a member depending on the club's mode, and the wizard
 * banner has to pick one sentence. Under HARD_BLOCK they cannot book; under
 * NON_MEMBER_PRICING they can, at non-member rates; under NO_BLOCK the
 * subscription does not gate booking at all. An unrecognised or absent mode —
 * an older cached response predating the field — resolves to HARD_BLOCK, the
 * migration-safe server default, so a stale response can never silently drop a
 * warning that is still true. Failing the other way would tell a locked-out
 * member they may book.
 *
 * `memberRateNotice` is the server's sentence and is passed through untouched;
 * anything that is not a non-empty string becomes null, and the banner then
 * simply omits the explanation rather than inventing one.
 */
export function readSubscriptionLockoutView(
  status: unknown,
): SubscriptionLockoutView {
  const source = (status ?? {}) as {
    subscriptionLockoutMode?: unknown;
    memberRateNotice?: unknown;
  };
  const rawMode = source.subscriptionLockoutMode;
  const mode = SUBSCRIPTION_LOCKOUT_MODES.includes(
    rawMode as SubscriptionLockoutMode,
  )
    ? (rawMode as SubscriptionLockoutMode)
    : "HARD_BLOCK";
  const rawNotice = source.memberRateNotice;
  return {
    mode,
    memberRateNotice:
      typeof rawNotice === "string" && rawNotice.length > 0 ? rawNotice : null,
  };
}
