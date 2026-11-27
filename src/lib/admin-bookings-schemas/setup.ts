/**
 * The request schemas of the Bookings & Beds setup routes: seasons, booking
 * policies (minimum stay, booking periods, group discount, adult-member
 * hosting), age groups, member-guest and booking-request settings (ALP-719,
 * `INV-MCP-006`).
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). No database or server
 * imports, so the catalogue can load it. The Cancellation policy body stays in
 * `booking-policy-cancellation-schema.ts`, its existing pure home.
 *
 * A schema with a refinement is still a `z.object` (zod 4 keeps the checks on
 * the object), so the catalogue offers the route's own schema; only its
 * fields reach the app's description, and the route remains the authority
 * for the cross-field rules.
 */
import { z } from "zod";

import {
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
} from "@/config/club-settings-defaults";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { cancellationTierSchema, nonMemberHoldDaysSchema } from "@/lib/booking-policy-cancellation-schema";
import { hasDuplicateCancellationThresholds } from "@/lib/cancellation-rules";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";
import { membershipTypeSeasonRateInputSchema } from "@/lib/season-rate-editor";

// ---------------------------------------------------------------------------
// Lodge scope of a policy read
// ---------------------------------------------------------------------------

/**
 * `?lodgeId=` on the policy reads (cancellation, minimum stay, booking
 * periods, adult-member hosting). Exact partition: omitted reads the
 * club-wide rules, a lodge id reads that lodge's override set. Not `.min(1)`,
 * so an empty value reads as the routes always have.
 */
export const adminPolicyLodgeQuerySchema = z.object({
  lodgeId: z
    .string()
    .optional()
    .describe("A lodge id from `list_lodges` to read that lodge's override; omit for the club-wide rules."),
});

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

/** `?lodgeId=` on the season list: omitted lists every lodge's seasons. */
export const adminSeasonsQuerySchema = z.object({
  lodgeId: z
    .string()
    .optional()
    .describe("A lodge id from `list_lodges` to list only that lodge's seasons; omit for every lodge."),
});

const SEASON_RATES_DESCRIPTION =
  "Nightly hut rates in integer cents (GST inclusive), one row per membership type and, where the type uses age groups, per age tier (`ageTier` null for a flat type).";

// Rates are keyed by membership type (#1930, E4); the legacy boolean-keyed
// SeasonRate table was dropped by #2129 step 2.
export const seasonCreateBodySchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["WINTER", "SUMMER"]),
  startDate: dateOnlyStringSchema.describe("First night of the season, `YYYY-MM-DD`."),
  endDate: dateOnlyStringSchema.describe("Season end, `YYYY-MM-DD`; after `startDate`."),
  active: z.boolean().default(true),
  membershipTypeRates: membershipTypeSeasonRateInputSchema.describe(SEASON_RATES_DESCRIPTION),
  // Flat whole-lodge night rate for this season, in integer cents (#2338).
  // Nullable/optional: null or omitted means "no flat rate", so a whole-lodge
  // approval prices per guest as before.
  flatWholeLodgeNightCents: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe("Flat whole-lodge night rate in integer cents; null or omitted for none."),
  lodgeId: z.string().min(1).optional().describe("The lodge, from `list_lodges`; omitted means the default lodge."),
});

// Rates keyed by membership type (#1930, E4); legacy SeasonRate is gone (#2129).
export const seasonUpdateBodySchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(["WINTER", "SUMMER"]).optional(),
  startDate: dateOnlyStringSchema.optional().describe("First night of the season, `YYYY-MM-DD`."),
  endDate: dateOnlyStringSchema.optional().describe("Season end, `YYYY-MM-DD`; after `startDate`."),
  active: z.boolean().optional(),
  membershipTypeRates: membershipTypeSeasonRateInputSchema
    .optional()
    .describe(`${SEASON_RATES_DESCRIPTION} Replaces every rate of the season; omit to keep them.`),
  // Flat whole-lodge night rate in integer cents (#2338). Nullable so the Hut
  // Fees editor can CLEAR it (null); omitted leaves it untouched — the
  // windows-only /admin/seasons PUT never sends it, so a window edit never wipes
  // a configured flat rate. Flows through `...seasonData` into the update.
  flatWholeLodgeNightCents: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe("Flat whole-lodge night rate in integer cents; null clears it, omitted keeps it."),
});

// ---------------------------------------------------------------------------
// Booking periods
// ---------------------------------------------------------------------------

const BOOKING_PERIOD_RULES_DESCRIPTION =
  "Cancellation tiers: from `daysBeforeStay` days before arrival, the card refund `refundPercentage` and fee `fixedFeeCents` (cents), and the credit refund equivalents. Day thresholds must be unique.";

export const bookingPeriodCreateBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    startDate: dateOnlyStringSchema.describe("First night the period covers, `YYYY-MM-DD`."),
    endDate: dateOnlyStringSchema.describe("Period end, `YYYY-MM-DD`; after `startDate`."),
    nonMemberHoldEnabled: z.boolean().optional(),
    nonMemberHoldDays: nonMemberHoldDaysSchema,
    cancellationRules: z
      .array(cancellationTierSchema)
      .min(1)
      .describe(BOOKING_PERIOD_RULES_DESCRIPTION),
    active: z.boolean().optional(),
    // Per-lodge override partition (ADR-001 resolved question 3). Omitted =
    // club-wide (null lodgeId). Any rows for a lodge REPLACE the club-wide
    // set at runtime for that lodge.
    lodgeId: z
      .string()
      .min(1)
      .optional()
      .describe("A lodge id from `list_lodges` for a lodge override; omit for club-wide."),
  })
  .superRefine((data, ctx) => {
    if (hasDuplicateCancellationThresholds(data.cancellationRules)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cancellationRules"],
        message: "Cancellation rule day thresholds must be unique",
      });
    }
  });

export const bookingPeriodUpdateBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    startDate: dateOnlyStringSchema.optional().describe("First night the period covers, `YYYY-MM-DD`."),
    endDate: dateOnlyStringSchema.optional().describe("Period end, `YYYY-MM-DD`; after `startDate`."),
    nonMemberHoldEnabled: z.boolean().optional(),
    nonMemberHoldDays: nonMemberHoldDaysSchema.optional(),
    cancellationRules: z
      .array(cancellationTierSchema)
      .min(1)
      .optional()
      .describe(`${BOOKING_PERIOD_RULES_DESCRIPTION} Replaces every tier; omit to keep them.`),
    active: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.cancellationRules && hasDuplicateCancellationThresholds(data.cancellationRules)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cancellationRules"],
        message: "Cancellation rule day thresholds must be unique",
      });
    }
  });

// ---------------------------------------------------------------------------
// Minimum stay
// ---------------------------------------------------------------------------

const TRIGGER_DAYS_DESCRIPTION =
  "Days of the week whose arrival triggers the rule: 0 Sunday to 6 Saturday.";
const MINIMUM_STAY_VERSION_DESCRIPTION =
  "The policy's `version` as last read from `list_minimum_stay_policies`; a changed policy is refused with 409.";

export const minimumStayCreateBodySchema = z.object({
  name: z.string().min(1).max(200),
  startDate: dateOnlyStringSchema.describe("First night the policy covers, `YYYY-MM-DD`."),
  endDate: dateOnlyStringSchema.describe("Policy end, `YYYY-MM-DD`; after `startDate`."),
  triggerDays: z
    .array(z.number().int().min(0).max(6))
    .min(1, "At least one trigger day is required")
    .describe(TRIGGER_DAYS_DESCRIPTION),
  minimumNights: z.number().int().min(2, "Minimum nights must be at least 2"),
  capacityMode: z
    .enum(["HOLD", "NO_HOLD"])
    .describe("Whether a booking asking for an exception holds its beds while it waits."),
  active: z.boolean().optional(),
  // Per-lodge override partition (ADR-001 resolved question 3). Omitted =
  // club-wide (null lodgeId). Any rows for a lodge REPLACE the club-wide
  // set at runtime for that lodge.
  lodgeId: z
    .string()
    .min(1)
    .optional()
    .describe("A lodge id from `list_lodges` for a lodge override; omit for club-wide."),
});

export const minimumStayUpdateBodySchema = z.object({
  version: z.number().int().positive().describe(MINIMUM_STAY_VERSION_DESCRIPTION),
  name: z.string().min(1).max(200).optional(),
  startDate: dateOnlyStringSchema.optional().describe("First night the policy covers, `YYYY-MM-DD`."),
  endDate: dateOnlyStringSchema.optional().describe("Policy end, `YYYY-MM-DD`; after `startDate`."),
  triggerDays: z.array(z.number().int().min(0).max(6)).min(1).optional().describe(TRIGGER_DAYS_DESCRIPTION),
  minimumNights: z.number().int().min(2).optional(),
  capacityMode: z.enum(["HOLD", "NO_HOLD"]).optional(),
  active: z.boolean().optional(),
});

export const minimumStayDeleteBodySchema = z.object({
  version: z.number().int().positive().describe(MINIMUM_STAY_VERSION_DESCRIPTION),
});

// ---------------------------------------------------------------------------
// Group discount
// ---------------------------------------------------------------------------

export const groupDiscountBodySchema = z.object({
  minGroupSize: z.number().int().min(2).max(200),
  summerOnly: z.boolean(),
  enabled: z.boolean(),
  // #2770 (INV-MOD-026): whether a later edit earns the discount on the nights
  // it newly buys.
  //
  // OPTIONAL, and the failure modes are why. A body that predates the column —
  // an admin tab left open across the deploy, or any scripted caller — would be
  // rejected outright by a required field, losing the whole policy save over a
  // key it has never heard of. Optional cannot silently re-arm the switch
  // either: `update` is `parsed.data`, and an absent optional key is simply not
  // in that object, so Prisma leaves the column exactly as the club set it. On
  // `create` the column's own `@default(true)` applies. Absent therefore means
  // "do not touch this", which is the strictly safer of the two behaviours for a
  // field that decides what a member is charged.
  //
  // Note the deliberate asymmetry with `EditTimeGroupDiscountSettingLike`, where
  // the same field is REQUIRED: there it is being READ to price a booking, and an
  // absent value would silently withhold a discount the club left on. Here it is
  // being WRITTEN, and absent means unchanged.
  applyToEdits: z
    .boolean()
    .optional()
    .describe("Whether a later edit earns the discount on the nights it adds; omit to leave it unchanged."),
});

// ---------------------------------------------------------------------------
// Adult-member hosting
// ---------------------------------------------------------------------------

/**
 * The host-qualification scope set as the card sends it (#2569 §2).
 *
 * `null` is the explicit `Inherit club host scopes` option — for a LODGE it means
 * "follow whatever the club decides", and for the CLUB it means "we have not
 * decided", which resolves to the built-in same-booking-only default. It is stored
 * as both columns NULL, which the database CHECK holds together.
 *
 * ABSENT is treated as `null` as well, so a caller that predates #2569 (and the
 * route tests written against it) keeps its exact meaning: no scope decision on
 * this row.
 *
 * STRICT, so a body naming a scope this build does not have — including the two
 * the owner removed from the model (#2575, #2576) — is a 400 rather than a silently
 * dropped key that would save a set the operator did not choose.
 *
 * `sameGroupTrip` (#3037) is OPTIONAL rather than required, and only that field
 * is. Strictness is about unknown keys and is unweakened; what optionality buys
 * is a blue/green window in which a browser tab loaded from the previous colour
 * can still save a policy, naming only the two fields it knows.
 *
 * OPTIONAL, NOT `.default(false)`, and the difference is a real bug rather than
 * a style preference. A default makes an ABSENT field indistinguishable from an
 * explicit `false`, so an old-colour tab saving an unrelated change — the mode,
 * the capacity mode — would silently turn Group Trip cover OFF on a row a
 * different admin had turned it on for. The compare-and-swap `version` does not
 * stop that: the old-colour tab reads the row through a GET that simply does not
 * select this column, so it can hold the CURRENT version quite legitimately, the
 * CAS passes, and the default writes the field the body could not express.
 * Absent therefore means "this writer expressed no view", and the handler leaves
 * the stored value alone; on a CREATE it stores NULL, which reads as OFF and is
 * exactly what the previous colour would have written itself.
 *
 * The reverse direction is closed by strictness rather than by this field: a
 * NEW-colour body routed to an OLD-colour instance names a key that build's
 * `.strict()` does not know, and is a 400 — a visible refusal, not a silent drop.
 */
const hostScopesSchema = z
  .object({
    sameBooking: z.boolean(),
    sameBookingOwner: z.boolean(),
    sameGroupTrip: z.boolean().optional(),
  })
  .strict()
  .nullable();

export const adultMemberHostingBodySchema = z.object({
  mode: z
    .enum(["INHERIT", "DISABLED", "ADMIN_REVIEW_REQUIRED", "ENFORCED"])
    .describe("INHERIT (a lodge only) follows the club-wide setting."),
  hostScopes: hostScopesSchema
    .optional()
    .describe("Which adult members count as hosts; null or omitted inherits the club's choice. At least one must be true."),
  // Required on EVERY write, with no server-side default (epic decision D-R6:
  // capacity mode is per policy and explicit for new policies). The column has
  // no database default either, so there is nowhere for an unstated value to
  // come from.
  capacityMode: z
    .enum(["HOLD", "NO_HOLD"])
    .describe("Whether a booking awaiting review holds its beds while it waits."),
  // The revision the editor loaded. Absent means "I believe no row exists yet";
  // present means "I am updating the row I read". Either belief being wrong is a
  // 409, never a blind overwrite of a concurrent admin or a configuration
  // import.
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The `version` from `get_adult_member_hosting_policy`; omit only when it reported `configured: false`."),
  lodgeId: z
    .string()
    .min(1)
    .optional()
    .describe("A lodge id from `list_lodges` for a lodge override; omit for club-wide."),
});

// ---------------------------------------------------------------------------
// Age groups
// ---------------------------------------------------------------------------

export const ageTierSettingsBodySchema = z.object({
  settings: z
    .array(
      z.object({
        // NOT_APPLICABLE is the organisation/school tier (#1440): it has no
        // age range, no Xero group, and no subscription rule, so it never
        // gets a settings row.
        tier: ageTierEnum.refine((tier) => tier !== "NOT_APPLICABLE", {
          message: "The N/A age tier is not configurable",
        }),
        minAge: z.number().int().min(0),
        maxAge: z.number().int().min(0).nullable(),
        label: z.string().min(1).max(100),
        subscriptionRequiredForBooking: z.boolean(),
        familyGroupRequestCreateMemberAllowed: z.boolean(),
        sortOrder: z.number().int().min(0),
      }),
    )
    .min(1)
    .describe(
      "Every age group the club keeps, which together must cover every age from 0 with ADULT the only open-ended (`maxAge` null) group. A group left out is removed, refused while anyone is still in it.",
    ),
});

// ---------------------------------------------------------------------------
// Booking-request settings
// ---------------------------------------------------------------------------

export const bookingRequestSettingsBodySchema = z
  .object({
    showPricingToNonMembers: z.boolean(),
    quoteResponseTtlDays: z.number().int().min(1).max(60),
    quoteReminderLeadDays: z.number().int().min(0).max(30),
    attendeeConfirmationLeadDays: z.number().int().min(0).max(90),
    attendeeConfirmationReminderDays: z.number().int().min(1).max(30),
  })
  .refine((value) => value.quoteReminderLeadDays < value.quoteResponseTtlDays, {
    message: "The reminder lead time must be shorter than the quote response window.",
    path: ["quoteReminderLeadDays"],
  });

// ---------------------------------------------------------------------------
// Member-guest settings
// ---------------------------------------------------------------------------

/**
 * One plain-English sentence covers every way `pendingHoldExpiryDays` can be
 * wrong — a string, a fraction, null, 0, 61 — because from an admin's point of
 * view they are all the same mistake, and the field-level zod defaults ("Invalid
 * input", "Too small: expected number to be >=1") are not sentences an operator
 * should ever be shown.
 */
const PENDING_HOLD_EXPIRY_DAYS_MESSAGE =
  `Hold expiry must be a whole number of days between ` +
  `${MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN} and ` +
  `${MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX}.`;

function booleanField(name: string) {
  // Strict booleans: no "true"/1/"on" coercion. A card that posts a string has a
  // bug worth surfacing, and silently coercing it would let a typo turn a
  // privacy toggle on.
  return z.boolean({ error: `${name} must be true or false.` });
}

// All four fields are required, as on the precedent route: the card owns the
// whole form and posts it whole, so there is no partial-update shape to merge
// and no read-modify-write race to reason about. `.strict()` REJECTS unknown
// keys with a 400 rather than ignoring them, which is what stops a renamed or
// mistyped field from looking like a successful save.
export const memberGuestSettingsBodySchema = z
  .object({
    // D-3: ask-first is the shipped default; notify-only is an explicit opt-down
    // by the club's admin, never a value that arrives by accident.
    approvalRequired: booleanField("Approval required"),
    pendingHoldExpiryDays: z
      .number({ error: PENDING_HOLD_EXPIRY_DAYS_MESSAGE })
      .int(PENDING_HOLD_EXPIRY_DAYS_MESSAGE)
      .min(MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN, PENDING_HOLD_EXPIRY_DAYS_MESSAGE)
      .max(MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX, PENDING_HOLD_EXPIRY_DAYS_MESSAGE),
    // The two privacy toggles. Turning the first on makes the club's membership
    // name list browsable to anyone who can start a booking; the second decides
    // whether children appear in that list. Both ship OFF, and per owner
    // decision D-18 neither ever travels in a config bundle — an import must not
    // be able to widen a target club's member privacy. This route is therefore
    // the ONLY way either value can change, which is why the audit entry
    // records both before and after.
    openMemberSearchEnabled: booleanField("Open member search").describe(
      "Lets anyone starting a booking browse the club's member name list.",
    ),
    openMemberSearchIncludesMinors: booleanField("Include minors in open member search").describe(
      "Whether children appear in that list.",
    ),
  })
  .strict();
