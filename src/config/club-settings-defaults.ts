/**
 * Effective defaults for the club-wide settings singletons whose read paths
 * SYNTHESISE a value when the `id = "default"` row has never been saved.
 *
 * These are the values the APP reads on a miss. They are not necessarily what a
 * freshly INSERTed Prisma row would default to, so keep them in step with the
 * read sites that consume them rather than with `prisma/schema.prisma`.
 *
 * Kept here — a pure leaf with no imports — for two reasons:
 *
 * 1. One source of truth. Each value below used to be an inline `?? x` at its
 *    own read site, or a constant inside a larger settings module. The
 *    config-transfer exporter now has to emit the same effective value for a
 *    club that never saved the row (#2171), and a second hand-written copy is
 *    exactly how the two would drift apart. A test fails if a singleton spec
 *    leaves an exported field without a declared default, which only works
 *    while there is exactly one place to declare it.
 * 2. It sits with its neighbours. `src/config/` is already where the
 *    equivalent shared defaults live — `DEFAULT_MODULE_SETTINGS`
 *    (`modules.ts`) and `DEFAULT_MEMBER_FIELDS_SETTINGS` (`member-fields.ts`),
 *    both of which the same exporter reads — so a value-only leaf here needs no
 *    new convention.
 *
 * What this is NOT is a prisma firewall: `src/lib/config-transfer/**` already
 * reaches `@/lib/prisma` transitively (its site-content / lodge-ops categories
 * import `@/lib/page-content-html`, which imports prisma), so moving these
 * constants out of the getters' modules bought no import-graph purity. One
 * source of truth is the whole reason.
 *
 * Two singletons are deliberately absent, and that absence is load-bearing:
 * `ClubIdentitySettings` and `EmailMessageSetting` are made entirely of
 * NULLABLE OVERRIDE columns resolved through the deployment's own
 * `config/club.json` / environment fallback chain. "Never saved" there means
 * "no override" — which is exactly what their admin GETs synthesise — and the
 * fallback values themselves belong to the install, not to the club's
 * configuration, so they are not portable in a bundle.
 *
 * Module flags and member-field visibility keep their own long-standing homes:
 * `DEFAULT_MODULE_SETTINGS` (`src/config/modules.ts`) and
 * `DEFAULT_MEMBER_FIELDS_SETTINGS` (`src/config/member-fields.ts`).
 */

/** `BookingDefaults` — read by `getNonMemberHoldPolicy` and `getWaitlistCrossLodgeOrder`. */
export const DEFAULT_BOOKING_DEFAULTS = {
  nonMemberHoldEnabled: true,
  nonMemberHoldDays: 7,
  waitlistCrossLodgeOrder: "OWN_LODGE_FIRST",
} as const;

/** `BedAllocationSettings` — read by `resolveAutoAllocationEnabled` and the admin surface. */
export const BED_ALLOCATION_PRIORITY_VOCABULARY = [
  "BOOKING_COHESION",
  "STAY_CONTINUITY",
  "REQUESTED_ROOM",
  "FAMILY_COHESION",
] as const;

export const DEFAULT_BED_ALLOCATION_SETTINGS = {
  autoAllocationEnabled: true,
  allocationPriorityOrder: BED_ALLOCATION_PRIORITY_VOCABULARY,
} as const;

/** `BookingRequestSettings` — read by `getBookingRequestSettings`. */
export const DEFAULT_BOOKING_REQUEST_SETTINGS = {
  showPricingToNonMembers: false,
  quoteResponseTtlDays: 14,
  quoteReminderLeadDays: 3,
  attendeeConfirmationLeadDays: 14,
  attendeeConfirmationReminderDays: 3,
} as const;

/**
 * `MemberGuestSettings` — the "+ Add Member Guest" policy singleton (#2306,
 * epic #2305), read by `loadMemberGuestSettings`. These match the schema column
 * defaults, which a test asserts against `prisma/schema.prisma`.
 *
 * `approvalRequired` true is owner decision D-3; `pendingHoldExpiryDays` 7
 * (bounds 1..60) is the 30 Jul confirm-by-objection default. Both TRAVEL in
 * config transfer (D-18).
 *
 * The two `openMemberSearch*` values are declared here so the singleton has one
 * source of truth for "what the app reads on a miss", but they deliberately do
 * NOT travel — see the `excluded` block on the `member-guest-settings` spec in
 * `config-transfer/categories/club-settings.ts`. Both are inert in this release:
 * nothing reads them until MG3.
 */
export const DEFAULT_MEMBER_GUEST_SETTINGS = {
  approvalRequired: true,
  pendingHoldExpiryDays: 7,
  openMemberSearchEnabled: false,
  openMemberSearchIncludesMinors: false,
} as const;

/**
 * Inclusive bounds for `pendingHoldExpiryDays`, mirroring `quoteResponseTtlDays`.
 *
 * Declared in this dependency-free leaf, not in `src/lib/member-guest-settings.ts`,
 * so the config-transfer spec can reference the same two numbers its validator
 * enforces without pulling the Prisma client into the category module. MG2's
 * admin route reads them too.
 */
export const MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN = 1;
export const MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX = 60;

/** `InternetBankingPaymentSettings` — read by `loadInternetBankingPaymentSettings`. */
export const DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS = {
  holdBedSlots: false,
  holdDays: 3,
  minimumDaysBeforeCheckIn: 0,
} as const;

/** `GroupDiscountSetting` — synthesised by the group-discount admin GET (#2142). */
export const DEFAULT_GROUP_DISCOUNT_SETTING = {
  minGroupSize: 5,
  summerOnly: true,
  enabled: false,
} as const;

/** `MembershipNominationSettings` — read by `normalizeMembershipNominationSettings`. */
export const DEFAULT_MEMBERSHIP_NOMINATION_SETTINGS = {
  gateEnabled: false,
  minimumMembershipMonths: 12,
  minimumNights: 6,
  requiredSignOffs: 2,
  /** No grandfather cutoff: everyone is subject to the gate once it is enabled. */
  gateEffectiveFrom: null,
} as const;

/** `MembershipLockoutSettings` — read by `normalizeMembershipLockoutSettings`. */
export const DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS = {
  /**
   * #2543 three-way lockout policy. HARD_BLOCK is the safe default — it is
   * exactly the behaviour the old `enabled: true` boolean produced, so a fresh
   * install and every existing club start where they already were. It matches the
   * database default, which the migration set when it made the column mandatory
   * and dropped the boolean (#2561).
   */
  mode: "HARD_BLOCK",
  /** Null = follow the connected Xero organisation's accounting financial year. */
  financialYearEndMonthOverride: null,
  textFallbackEnabled: true,
  useFeeScheduleItemCodes: false,
} as const;

/**
 * `PublicContentSettings` — the values the public read paths synthesise when the
 * `id = "default"` row is absent (#2200). Every double-opt-in visibility gate is
 * OFF on a miss (`isPublicContentEnabled` returns `settings?.[gate] === true`,
 * `src/lib/public-page-content-tokens.ts`) and, since #2430, so is the public
 * "Book Now" button: a fresh install advertises no public booking CTA until an
 * admin ticks it on (`getBookNowVariants`, `src/lib/book-now-config.ts`). Absence
 * is the ONLY thing this constant governs — at read time a stored row always
 * wins, saved-true and saved-false alike. What switched EXISTING clubs off is
 * the one-off backfill in
 * `20260802100000_public_book_now_default_off` (owner decision on PR #2466,
 * widening #2430 from "fresh installs" to "every club"), not this constant.
 * Only the portable policy fields
 * are declared here — `bookNowTarget`/`bookNowPageId` are instance-local (they
 * reference a specific install's `PageContent` id) and never travel, so they
 * have no effective-default to carry. These match the schema column defaults, which is
 * asserted against `prisma/schema.prisma` by a config-transfer test.
 */
export const DEFAULT_PUBLIC_CONTENT_SETTINGS = {
  membershipTypes: false,
  entranceFees: false,
  hutFees: false,
  bookingPolicySummary: false,
  cancellationPolicy: false,
  annualFees: false,
  showBookNow: false,
  committeePhotoDisplay: "NONE",
} as const;

/**
 * `MembershipSubscriptionBillingSettings` — the effective club billing policy a
 * missing `id = "default"` row synthesises (#2200). `invoiceDueDays` is read by
 * `getSubscriptionBillingDueDays` and `familyBillingMode` by `getFamilyBillingMode`
 * (`src/lib/authoritative-fees.ts`), both `?? default`. A test asserts
 * `familyBillingMode` equals `DEFAULT_FAMILY_BILLING_MODE` and that both values
 * match the schema column defaults, so the three sources cannot drift. Both are
 * portable club policy with no provider/tenant coupling.
 */
export const DEFAULT_MEMBERSHIP_SUBSCRIPTION_BILLING_SETTINGS = {
  invoiceDueDays: 30,
  familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER",
} as const;

/** `MembershipCancellationSetting` — read by `normalizeMembershipCancellationSettings`. */
export const DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS = {
  warningText:
    "Cancelling membership removes member booking access once approved. Existing bookings, credits, refunds, and unpaid invoices still need separate committee review.",
  rejoinProcessText:
    "Former members can reapply through the normal membership process. The committee will confirm any outstanding balances and restore access only after the rejoin process is approved.",
  xeroArchiveContactsOnCancellation: false,
} as const;
