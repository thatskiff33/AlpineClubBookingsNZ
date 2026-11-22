/**
 * What the Bookings & Beds setup officer actions return (ALP-719,
 * `INV-MCP-006`): seasons and their hut rates, booking policies, age groups,
 * member-guest and booking-request settings. The catalogue entry and the
 * route's `connectionJson` both read these (`INV-SSOT`).
 *
 * Kept: what an officer's AI app needs to read and change the setting.
 * Dropped: row timestamps, child-row ids, raw columns a derived field
 * already states, and who last saved a setting (another member's id).
 *
 * The three list routes answer the browser a bare array; a connection's
 * answer must be an object, so each route sends a connection the list under
 * one key (`seasons`, `policies`, `periods`).
 *
 * Types only from the route modules: nothing here reaches the database.
 */
import type {
  AdultMemberHostingPolicy,
  BookingPeriod,
  GroupDiscountSetting,
  MembershipTypeSeasonRate,
  MinimumStayPolicy,
  Season,
} from "@prisma/client";

import type { AgeTierSettingData } from "@/lib/age-tier";
import type { getBookingRequestSettings } from "@/lib/booking-request";
import type { clubWideDefaults } from "@/lib/booking-policy-cancellation-schema";
import type { NormalizedCancellationRule } from "@/lib/cancellation-rules";
import { connectionShapeFor } from "@/lib/connection-projection";
import type { normalizeMemberGuestSettings } from "@/lib/member-guest-settings";
import type {
  AdultMemberHostScopeSet,
  AdultMemberHostingSettingSource,
  EffectiveAdultMemberHostingMode,
} from "@/lib/policies/adult-member-hosting";

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

type SeasonAnswer = Season & { membershipTypeRates: MembershipTypeSeasonRate[] };

// Nested shapes are plain constants, checked where a typed shape uses them.
const SEASON_SHAPE = {
  id: true,
  name: true,
  type: true,
  startDate: true,
  endDate: true,
  active: true,
  flatWholeLodgeNightCents: true,
  lodgeId: true,
  membershipTypeRates: { membershipTypeId: true, ageTier: true, pricePerNightCents: true },
} as const;

export const ADMIN_SEASON_CONNECTION_SHAPE = connectionShapeFor<SeasonAnswer>(SEASON_SHAPE);

export const ADMIN_SEASON_LIST_CONNECTION_SHAPE = connectionShapeFor<{ seasons: SeasonAnswer[] }>({
  seasons: SEASON_SHAPE,
});

/** A delete that answers `{ success: true }`: seasons and booking periods. */
export const ADMIN_SETUP_DELETED_CONNECTION_SHAPE = connectionShapeFor<{ success: boolean }>({
  success: true,
});

// ---------------------------------------------------------------------------
// Booking periods
// ---------------------------------------------------------------------------

/** A period with its stored rules read as rules (the column is JSON). */
type BookingPeriodAnswer = Omit<BookingPeriod, "cancellationRules"> & {
  cancellationRules: NormalizedCancellationRule[];
};

const CANCELLATION_RULE_SHAPE = {
  daysBeforeStay: true,
  refundPercentage: true,
  creditRefundPercentage: true,
  fixedFeeCents: true,
  creditFixedFeeCents: true,
} as const;

const BOOKING_PERIOD_SHAPE = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  nonMemberHoldEnabled: true,
  nonMemberHoldDays: true,
  cancellationRules: CANCELLATION_RULE_SHAPE,
  active: true,
  lodgeId: true,
} as const;

export const ADMIN_BOOKING_PERIOD_CONNECTION_SHAPE = connectionShapeFor<BookingPeriodAnswer>(BOOKING_PERIOD_SHAPE);

export const ADMIN_BOOKING_PERIOD_LIST_CONNECTION_SHAPE = connectionShapeFor<{
  periods: BookingPeriodAnswer[];
}>({
  periods: BOOKING_PERIOD_SHAPE,
});

// ---------------------------------------------------------------------------
// Minimum stay
// ---------------------------------------------------------------------------

const MINIMUM_STAY_POLICY_SHAPE = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  triggerDays: true,
  minimumNights: true,
  capacityMode: true,
  active: true,
  version: true,
  lodgeId: true,
} as const;

export const ADMIN_MINIMUM_STAY_POLICY_CONNECTION_SHAPE =
  connectionShapeFor<MinimumStayPolicy>(MINIMUM_STAY_POLICY_SHAPE);

export const ADMIN_MINIMUM_STAY_POLICY_LIST_CONNECTION_SHAPE = connectionShapeFor<{
  policies: MinimumStayPolicy[];
}>({
  policies: MINIMUM_STAY_POLICY_SHAPE,
});

/** `policy` is absent when the policy was already inactive. */
export const ADMIN_MINIMUM_STAY_POLICY_DEACTIVATED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  policy?: MinimumStayPolicy;
}>({
  success: true,
  policy: MINIMUM_STAY_POLICY_SHAPE,
});

// ---------------------------------------------------------------------------
// Cancellation policy
// ---------------------------------------------------------------------------

type CancellationPolicySaved = { rules: NormalizedCancellationRule[] } & ReturnType<typeof clubWideDefaults>;

const CANCELLATION_POLICY_SAVED_FIELDS = {
  rules: CANCELLATION_RULE_SHAPE,
  nonMemberHoldEnabled: true,
  nonMemberHoldDays: true,
  waitlistCrossLodgeOrder: true,
  linkedMoveChargesBothChangeFees: true,
  lateCaptureRefundNeedsApproval: true,
  preArrivalReminderDays: true,
  additionalPaymentReminderDays: true,
  policyExceptionHoldDays: true,
} as const;

/** The save's echo: the partition's rules and the club-wide defaults. */
export const ADMIN_CANCELLATION_POLICY_SAVED_CONNECTION_SHAPE =
  connectionShapeFor<CancellationPolicySaved>(CANCELLATION_POLICY_SAVED_FIELDS);

/** The read: as the save's echo, plus the partition it read. */
export const ADMIN_CANCELLATION_POLICY_CONNECTION_SHAPE = connectionShapeFor<
  CancellationPolicySaved & { lodgeId: string | null }
>({
  ...CANCELLATION_POLICY_SAVED_FIELDS,
  lodgeId: true,
});

// ---------------------------------------------------------------------------
// Group discount
// ---------------------------------------------------------------------------

const GROUP_DISCOUNT_SAVED_FIELDS = {
  minGroupSize: true,
  summerOnly: true,
  enabled: true,
  applyToEdits: true,
  rateMembershipTypeId: true,
} as const;

/** The save answers the stored row. */
export const ADMIN_GROUP_DISCOUNT_SAVED_CONNECTION_SHAPE =
  connectionShapeFor<GroupDiscountSetting>(GROUP_DISCOUNT_SAVED_FIELDS);

/** The read adds whether the club has ever saved the policy. */
export const ADMIN_GROUP_DISCOUNT_CONNECTION_SHAPE = connectionShapeFor<
  GroupDiscountSetting & { configured: boolean }
>({
  ...GROUP_DISCOUNT_SAVED_FIELDS,
  configured: true,
});

// ---------------------------------------------------------------------------
// Adult-member hosting
// ---------------------------------------------------------------------------

/**
 * The route's GET and save body: the scope's row (or the synthesised default),
 * its scope set, and what is in force there. The save builds its body as this
 * type (`savedPolicyBody`).
 */
export type AdultMemberHostingAnswer = AdultMemberHostingPolicy & {
  hostScopes: AdultMemberHostScopeSet | null;
  configured: boolean;
  effective: {
    mode: EffectiveAdultMemberHostingMode;
    modeSource: AdultMemberHostingSettingSource;
    hostScopes: AdultMemberHostScopeSet;
    hostScopeSource: AdultMemberHostingSettingSource;
    preview: string;
  };
};

const HOST_SCOPES_SHAPE = {
  sameBooking: true,
  sameBookingOwner: true,
  sameGroupTrip: true,
} as const;

export const ADMIN_ADULT_MEMBER_HOSTING_CONNECTION_SHAPE = connectionShapeFor<AdultMemberHostingAnswer>({
  id: true,
  scopeKey: true,
  lodgeId: true,
  mode: true,
  capacityMode: true,
  hostScopes: HOST_SCOPES_SHAPE,
  version: true,
  configured: true,
  effective: {
    mode: true,
    modeSource: true,
    hostScopes: HOST_SCOPES_SHAPE,
    hostScopeSource: true,
    preview: true,
  },
});

// ---------------------------------------------------------------------------
// Age groups
// ---------------------------------------------------------------------------

export const ADMIN_AGE_TIER_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<{
  settings: AgeTierSettingData[];
}>({
  settings: {
    tier: true,
    label: true,
    minAge: true,
    maxAge: true,
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: true,
    sortOrder: true,
  },
});

// ---------------------------------------------------------------------------
// Booking-request and member-guest settings
// ---------------------------------------------------------------------------

export const ADMIN_BOOKING_REQUEST_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<
  Awaited<ReturnType<typeof getBookingRequestSettings>>
>({
  showPricingToNonMembers: true,
  quoteResponseTtlDays: true,
  quoteReminderLeadDays: true,
  attendeeConfirmationLeadDays: true,
  attendeeConfirmationReminderDays: true,
});

/** The member-guest card's payload: the route builds its answer as this type. */
export type MemberGuestSettingsAnswer = {
  settings: ReturnType<typeof normalizeMemberGuestSettings>;
  updatedAt: string | null;
  updatedByMemberId: string | null;
  access: "manage" | "view";
  bounds: { pendingHoldExpiryDaysMin: number; pendingHoldExpiryDaysMax: number };
};

export const ADMIN_MEMBER_GUEST_SETTINGS_CONNECTION_SHAPE = connectionShapeFor<MemberGuestSettingsAnswer>({
  settings: {
    approvalRequired: true,
    pendingHoldExpiryDays: true,
    openMemberSearchEnabled: true,
    openMemberSearchIncludesMinors: true,
  },
  updatedAt: true,
  access: true,
  bounds: { pendingHoldExpiryDaysMin: true, pendingHoldExpiryDaysMax: true },
});
