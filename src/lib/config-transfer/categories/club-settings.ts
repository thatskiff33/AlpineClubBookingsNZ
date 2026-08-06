import { strToU8, strFromU8 } from "fflate";
import { Prisma } from "@prisma/client";

import {
  DEFAULT_BED_ALLOCATION_SETTINGS,
  DEFAULT_BOOKING_DEFAULTS,
  DEFAULT_BOOKING_REQUEST_SETTINGS,
  DEFAULT_GROUP_DISCOUNT_SETTING,
  DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS,
  DEFAULT_MEMBER_GUEST_SETTINGS,
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
  DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS,
  DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS,
  DEFAULT_MEMBERSHIP_NOMINATION_SETTINGS,
  DEFAULT_MEMBERSHIP_SUBSCRIPTION_BILLING_SETTINGS,
  DEFAULT_PUBLIC_CONTENT_SETTINGS,
} from "@/config/club-settings-defaults";
import { DEFAULT_MEMBER_FIELDS_SETTINGS } from "@/config/member-fields";
import { DEFAULT_LOGIN_SECURITY_POLICY } from "@/lib/password-policy";
import {
  BedAllocationSettingsValidationError,
  parseBedAllocationPriorityOrder,
} from "@/lib/bed-allocation-settings";
import {
  CLUB_MODULE_SETTINGS_COLUMN_SELECT,
  DEFAULT_MODULE_SETTINGS,
} from "@/config/modules";
import type { BundleEntry } from "../bundle";
import { registerEntity } from "../registry";
import { prismaEnumValues } from "../values";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  changedFields,
  hashRow,
  planActionFor,
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
  type ReadDb,
  type TxDb,
} from "../import-types";

// club-settings category: the club-wide singleton settings rows (id="default"),
// serialised one JSON file each. Generic (spec-driven) so adding a settings row
// is a one-line change. See ADR-001/002.

/** Minimal delegate shape for a singleton settings model. */
interface SingletonDelegate {
  findUnique(args: {
    where: { id: string };
    select?: Record<string, boolean>;
  }): Promise<Record<string, unknown> | null>;
  upsert(args: {
    where: { id: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<unknown>;
}

/**
 * Per-field dry-run constraints for a singleton (#2200). These mirror the
 * admin-API bounds that config transfer would otherwise bypass, so a hand-edited
 * value out of the admin's allowed range fails the PLAN (dry-run) instead of the
 * write. `required` fills the gap left by Prisma 7's DMMF stripping `isRequired`
 * (so `parseSingleton` can no longer read non-nullability from the schema): a
 * PRESENT `null` on a required field is a plan error. `min`/`max` are inclusive
 * bounds for an Int field. Enum-typed fields are validated automatically against
 * the real Prisma enum, independent of this map.
 */
interface SingletonFieldConstraint {
  required?: boolean;
  min?: number;
  max?: number;
  /** Optional strict validator for structured fields Prisma's scalar check cannot cover. */
  validate?: (value: unknown) => string | null;
}

interface SingletonSpec {
  entity: string;
  /** Prisma delegate name, e.g. "bookingDefaults". */
  delegate: string;
  fields: string[];
  optInFields?: string[];
  /** Per-field dry-run bounds (see SingletonFieldConstraint). */
  constraints?: Record<string, SingletonFieldConstraint>;
  /**
   * Prisma columns on this model that DELIBERATELY never travel in a bundle,
   * each mapped to a one-line reason. Merged with COMMON_EXCLUDED_COLUMNS to
   * form the full per-model exclusion set the reverse drift guard checks (#2178):
   * every real column must be in `fields`, `optInFields`, or here, so a newly
   * added column fails the test until someone classifies it as should-travel or
   * deliberately-excluded, rather than silently never being exported.
   */
  excluded?: Record<string, string>;
  /**
   * Explicit Prisma `select` for reads of this singleton. Only set where a
   * shared select already exists (e.g. CLUB_MODULE_SETTINGS_COLUMN_SELECT) to
   * keep a retired-but-not-yet-dropped column out of the generated SQL — see
   * the doc comment on that constant. Other singletons keep a bare read.
   */
  select?: Record<string, boolean>;
  /**
   * The EFFECTIVE value of each field when the club has never saved this
   * singleton — i.e. what the app's own read path synthesises on a miss, which
   * is NOT always what a fresh Prisma row would default to. Exported in place
   * of the missing row (#2171) so the bundle carries the source club's
   * effective settings and an import reproduces them, instead of quietly
   * leaving the target's own values in place.
   *
   * Never write the values out here: import them from the same constant the
   * getter reads, so a changed default cannot leave the exporter behind.
   *
   * A field omitted from this record exports as `null`, which is only correct
   * for a NULLABLE OVERRIDE column whose real default lives in a lower fallback
   * layer. Returning `{}` is therefore a deliberate statement — see
   * `DEFAULTS_INTENTIONALLY_PARTIAL` — not an oversight.
   */
  defaults: () => Record<string, unknown>;
  /**
   * Last chance to make a bundle's fields CONSISTENT WITH EACH OTHER before they
   * are diffed and written (#2543).
   *
   * Needed only where a legacy bundle key encodes a decision the current column
   * spells differently, so a bundle can carry a shape the app's own writer could
   * never produce. Runs inside `parseSingleton`, i.e. on the one path both the
   * dry-run and the apply use, so the plan can never promise something different
   * from what lands.
   *
   * RUNS BEFORE THE FIELD VALIDATION LOOP, and that order is load-bearing: it is
   * what lets a derived field still carry `constraints.required`. Run afterwards, a
   * spec could not require the derived field at all — the loop would reject the
   * legacy shape before the hook had a chance to fill it in — so the field would
   * have to stay unconstrained and a `null` in a hand-edited bundle would sail past
   * the dry-run into a write-time Prisma exception. A hook therefore receives
   * UNVALIDATED input and must behave itself: derive only from a value it has
   * type-checked, and leave anything it does not recognise exactly as it found it,
   * so the loop below still gets to refuse it.
   */
  reconcile?: (incoming: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The singletons whose `defaults()` legitimately covers none (or only some) of
 * their fields. Both are made entirely of nullable OVERRIDE columns resolved
 * through the deployment's `config/club.json` / environment fallback chain, so
 * "never saved" means "no override" — exactly what their admin GETs synthesise
 * — and the fallback values belong to the install rather than to the club's
 * portable configuration. Guarded by a test so a genuinely under-specified new
 * singleton cannot join them silently.
 */
export const DEFAULTS_INTENTIONALLY_PARTIAL = new Set([
  "club-identity-settings",
  "email-message-setting",
]);

/**
 * Columns present on (most) singletons that are never portable club
 * configuration: the fixed singleton primary key, the audit FK to the member
 * who last saved on the SOURCE install (that id need not exist on the target),
 * and the row timestamps. They are excluded from every export by omission from
 * `fields`; enumerated here so the reverse drift guard (#2178) treats the
 * omission as a deliberate decision rather than an oversight. Kept as one shared
 * set so the exclusion mechanism stays uniform across all 12 singletons. A model
 * that lacks one of these columns (e.g. BookingDefaults has no timestamps) is
 * unaffected: the guard only requires columns ⊆ fields ∪ excluded, never the
 * reverse, so this can be a tolerant superset.
 */
export const COMMON_EXCLUDED_COLUMNS: Record<string, string> = {
  id: 'singleton primary key (always "default") — identity, not configuration',
  updatedByMemberId:
    "audit FK to the source install's member; the id need not exist on the target",
  createdAt: "row creation timestamp — instance-local bookkeeping",
  updatedAt: "row mutation timestamp — instance-local bookkeeping",
};

/** Full column-exclusion set for a singleton: the shared columns plus its own. */
export function excludedColumnsFor(spec: SingletonSpec): Record<string, string> {
  return { ...COMMON_EXCLUDED_COLUMNS, ...spec.excluded };
}

// DELIBERATELY NOT REGISTERED as a travelling singleton (#2211, epic decision):
// AiAssistantSettings (the AI spend-cap singleton, id="default"). The monthly
// budget is a deployment-specific operational spend control, not portable club
// configuration — a source club's cap should never silently reset a target's.
// A fresh import gets the schema default (NZ$10) and the target operator sets
// their own. (Recorded epic decision.)
//
// SAME DISPOSITION, DELIBERATELY, for AI Diagnostics (AID-2, #2371): none of the
// four Diagnostics tables travels. DiagnosticsSettings holds a deployment-local
// spend budget (same reasoning as AiAssistantSettings, and stricter — it defaults
// to NZ$0 hard-off so an import can never plant a spend cap a target did not
// choose). DiagnosticsUsageMonthly / DiagnosticsBudgetReservation /
// DiagnosticsUsageEvent are runtime metering/audit records, never configuration.
// The DEDICATED Anthropic credential lives in the encrypted IntegrationCredential
// store (provider "anthropic-diagnostics"), which is outside config-transfer
// entirely (secrets never travel — FORBIDDEN_FIELD_PATTERNS). So diagnostics
// configuration is NON-TRAVELLING end to end, and the module flag itself is
// excluded from the travelling module set below for the same per-deployment
// reason as magicLink/googleLogin.
export const SINGLETONS: SingletonSpec[] = [
  {
    entity: "club-module-settings",
    delegate: "clubModuleSettings",
    fields: [
      "kiosk", "chores", "financeDashboard", "waitlist", "xeroIntegration",
      "bedAllocation", "internetBankingPayments", "addressAutocomplete",
      "groupBookings", "lockers", "induction", "workParties", "promoCodes",
      "hutLeaders", "communications", "memberNotices", "skifieldConditions",
      "twoFactor", "analytics", "lobbyDisplay",
      // eventsCalendar SHOULD-TRAVEL (#2241): "does this club run an events
      // calendar?" is a plain club capability decision like communications or
      // memberNotices — no credential, no per-install auth choice — so it
      // travels with the other flags. Importing `true` onto a target is the
      // pre-#2241 behaviour (the calendar was always on), and importing `false`
      // only 404s the calendar surfaces; no calendar DATA travels in any case.
      "eventsCalendar",
      // aiAssistant SHOULD-TRAVEL (#2211): a capability toggle like xeroIntegration,
      // not an auth-provider decision like magicLink/googleLogin. Importing `true`
      // onto a target with no Anthropic key is harmless — the /api/help/chat route
      // degrades to a structured "not_configured" fallback, and curated page help
      // still renders. The deployment-specific spend cap does NOT travel — see the
      // note above the SINGLETONS array on not registering AiAssistantSettings.
      "aiAssistant",
      // memberGuests SHOULD-TRAVEL (#2306, epic #2305, owner decision D-18):
      // "may a member add another member as a guest?" is a club capability
      // decision like groupBookings or waitlist, not a per-install auth or
      // credential decision, so it travels with the other capability flags
      // above (a count is deliberately not quoted here: it went stale the
      // moment #2241 added eventsCalendar to the list). Importing
      // `true` onto a target is harmless in this release (the flag is inert)
      // and, once MG2 lands, still lands on the target's OWN policy singleton.
      // The two PRIVACY toggles that decide how a member is FOUND live on the
      // separate member-guest-settings singleton below and are excluded there.
      "memberGuests",
    ],
    excluded: {
      multiLodge:
        "retired-but-not-yet-dropped flag; kept out of every read via " +
        "CLUB_MODULE_SETTINGS_COLUMN_SELECT and awaiting a contract DROP (#139)",
      // OWNER JUDGEMENT (#2178): the two auth-provider sign-in toggles do not
      // travel today, unlike EVERY other module flag (incl. twoFactor,
      // analytics, xeroIntegration) which does. (This read "the other 19
      // module flags" until #2241; the count had already been overtaken twice
      // by #2211 and #2306, so it is stated without a number now.) Enabling an
      // authentication
      // method is a per-deployment security decision — so they are excluded.
      // NOT a safe one-line flip to should-travel: the login page renders the
      // magic-link form off the flag alone (no delivery-presence gate), and the
      // profile Google card renders off googleLogin alone — an imported `true`
      // on an unconfigured target would surface a visibly broken auth path.
      // Travelling either first requires a credential/delivery render gate.
      magicLink:
        "auth-provider sign-in toggle gated on deployment-local email-delivery " +
        "config; a per-install auth decision, not portable club config — OWNER JUDGEMENT (#2178)",
      googleLogin:
        "auth-provider sign-in toggle gated on deployment-local Google OAuth " +
        "credentials (GOOGLE_CLIENT_ID/SECRET); a per-install auth decision — OWNER JUDGEMENT (#2178)",
      // AI Diagnostics (AID-2, #2371): NON-TRAVELLING for the same class of reason
      // as magicLink/googleLogin. Enabling it advertises a PAID product that is
      // inert without a deployment-local dedicated Anthropic credential and a
      // positive spend budget (both non-travelling), so an imported `true` on an
      // unconfigured target would surface a not-ready paid surface the target
      // never opted into. A fresh import keeps the target's own value (default
      // OFF) and its admin turns it on deliberately after wiring the credential
      // and budget. See the note above the SINGLETONS array.
      aiDiagnostics:
        "SEPARATE admin-only PAID product gated on a deployment-local dedicated " +
        "Anthropic credential + positive spend budget (both non-travelling); a " +
        "per-install decision, not portable club config (AID-2, #2371)",
    },
    // Every travelling column is a non-null Boolean toggle (schema @default),
    // so a present null fails the dry-run (#2200 model-level nullability audit).
    // No numeric bounds: no route enforces a range on a boolean.
    constraints: {
      kiosk: { required: true },
      chores: { required: true },
      financeDashboard: { required: true },
      waitlist: { required: true },
      xeroIntegration: { required: true },
      bedAllocation: { required: true },
      internetBankingPayments: { required: true },
      addressAutocomplete: { required: true },
      groupBookings: { required: true },
      lockers: { required: true },
      induction: { required: true },
      workParties: { required: true },
      promoCodes: { required: true },
      hutLeaders: { required: true },
      communications: { required: true },
      memberNotices: { required: true },
      eventsCalendar: { required: true },
      skifieldConditions: { required: true },
      twoFactor: { required: true },
      analytics: { required: true },
      lobbyDisplay: { required: true },
      aiAssistant: { required: true },
      memberGuests: { required: true },
    },
    select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    defaults: () => DEFAULT_MODULE_SETTINGS,
  },
  {
    entity: "booking-defaults",
    delegate: "bookingDefaults",
    fields: ["nonMemberHoldEnabled", "nonMemberHoldDays", "waitlistCrossLodgeOrder"],
    // All three columns are non-null (@default); a present null fails the dry-run
    // (#2200). nonMemberHoldDays mirrors the admin route's 1–365 bound
    // (booking-policies/cancellation route: z.number().int().min(1).max(365)).
    // waitlistCrossLodgeOrder is enum-validated automatically.
    constraints: {
      nonMemberHoldEnabled: { required: true },
      nonMemberHoldDays: { required: true, min: 1, max: 365 },
      waitlistCrossLodgeOrder: { required: true },
    },
    excluded: {
      lodgeId:
        "soft-link FK for the phase-7 per-lodge conversion, unused by runtime " +
        "reads today; a source lodge id is not portable across installs",
    },
    defaults: () => DEFAULT_BOOKING_DEFAULTS,
  },
  {
    entity: "member-fields-settings",
    delegate: "memberFieldsSettings",
    fields: ["showTitle", "showGender", "showOccupation"],
    // All three columns are non-null Boolean (@default true); a present null
    // fails the dry-run (#2200). No route enforces a numeric range.
    constraints: {
      showTitle: { required: true },
      showGender: { required: true },
      showOccupation: { required: true },
    },
    defaults: () => DEFAULT_MEMBER_FIELDS_SETTINGS,
  },
  {
    entity: "bed-allocation-settings",
    delegate: "bedAllocationSettings",
    fields: ["autoAllocationEnabled", "allocationPriorityOrder"],
    // Both columns are non-null. The ordered list additionally shares the
    // runtime closed-vocabulary parser so config transfer cannot bypass it.
    constraints: {
      autoAllocationEnabled: { required: true },
      allocationPriorityOrder: {
        required: true,
        validate: (value) => {
          try {
            parseBedAllocationPriorityOrder(
              value,
              "allocationPriorityOrder",
              400,
            );
            return null;
          } catch (error) {
            return error instanceof BedAllocationSettingsValidationError
              ? error.message
              : "must be a valid bed-allocation priority order";
          }
        },
      },
    },
    excluded: {
      lodgeId:
        "legacy singleton's soft link to a source lodge is not portable across " +
        "installs; authoritative per-lodge settings travel with lodge-config",
    },
    defaults: () => DEFAULT_BED_ALLOCATION_SETTINGS,
    // Older singleton bundles predate configurable priority ordering. Their
    // present settings file means "restore allocation settings", so omission
    // of this one newer field intentionally restores the historical canonical
    // order. `autoAllocationEnabled` has no such exception and remains omitted.
    reconcile: (incoming) =>
      "allocationPriorityOrder" in incoming
        ? incoming
        : {
            ...incoming,
            allocationPriorityOrder: [
              ...DEFAULT_BED_ALLOCATION_SETTINGS.allocationPriorityOrder,
            ],
          },
  },
  {
    entity: "booking-request-settings",
    delegate: "bookingRequestSettings",
    fields: [
      "showPricingToNonMembers", "quoteResponseTtlDays", "quoteReminderLeadDays",
      "attendeeConfirmationLeadDays", "attendeeConfirmationReminderDays",
    ],
    // All non-null (@default); a present null fails the dry-run (#2200). Int
    // bounds mirror the admin route (booking-requests/settings): quoteResponseTtlDays
    // z.number().int().min(1).max(60), quoteReminderLeadDays min(0).max(30),
    // attendeeConfirmationLeadDays min(0).max(90), attendeeConfirmationReminderDays
    // min(1).max(30). The route's cross-field refine (reminder < ttl) is not a
    // per-field bound and is left to the admin-reviewed dry-run diff.
    constraints: {
      showPricingToNonMembers: { required: true },
      quoteResponseTtlDays: { required: true, min: 1, max: 60 },
      quoteReminderLeadDays: { required: true, min: 0, max: 30 },
      attendeeConfirmationLeadDays: { required: true, min: 0, max: 90 },
      attendeeConfirmationReminderDays: { required: true, min: 1, max: 30 },
    },
    excluded: {
      lodgeId:
        "soft-link FK for the phase-7 per-lodge conversion, unused by runtime " +
        "reads today; a source lodge id is not portable across installs",
    },
    defaults: () => DEFAULT_BOOKING_REQUEST_SETTINGS,
  },
  {
    // Member-guest policy singleton (#2306, epic #2305). OWNER DECISION D-18
    // (30 Jul) is a deliberate SPLIT, not "the whole model travels":
    //
    //  * approvalRequired and pendingHoldExpiryDays TRAVEL. They are portable
    //    club policy of exactly the BookingRequestSettings kind — "do we ask
    //    first?" and "how long do we hold the bed?" — and a target club that
    //    imports them can see and change both on its own settings page.
    //
    //  * openMemberSearchEnabled and openMemberSearchIncludesMinors NEVER
    //    travel. See `excluded` below: they are the same shape as the
    //    magicLink/googleLogin exclusions — a setting whose import would change
    //    the TARGET's posture without the target's admin deciding.
    entity: "member-guest-settings",
    delegate: "memberGuestSettings",
    fields: ["approvalRequired", "pendingHoldExpiryDays"],
    // Both are non-null (@default); a present null fails the dry-run (#2200).
    // The pendingHoldExpiryDays bounds are the 1..60 the owner confirmed on
    // #2305 (30 Jul, confirm-by-objection), mirroring quoteResponseTtlDays.
    // Taken from the shared constants rather than written as literals, so the
    // importer's bounds and MG2's admin-route validator cannot drift apart.
    constraints: {
      approvalRequired: { required: true },
      pendingHoldExpiryDays: {
        required: true,
        min: MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
        max: MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
      },
    },
    excluded: {
      // OWNER JUDGEMENT (#2306, D-18), the same class of call as the
      // magicLink/googleLogin exclusions above. This toggle decides whether the
      // club's membership NAME LIST becomes browsable to anyone who can start a
      // booking. Importing a source club's `true` would silently widen a target
      // club's member privacy posture without its admin ever choosing it, and
      // the target has no signal that its bundle just did that. A fresh import
      // therefore keeps the target's own value (default OFF), and its admin
      // opts in deliberately.
      openMemberSearchEnabled:
        "club privacy posture: turning it on makes the membership name list " +
        "browsable to any member who can start a booking; an import must never " +
        "widen a target club's member privacy without its own admin deciding — " +
        "OWNER JUDGEMENT (#2306, D-18)",
      // Same judgement, and strictly stronger: this one governs whether MINORS
      // appear in that browsable list. It must not be able to arrive in a
      // bundle. (Decision D-9 as ticked already makes any active member
      // resolvable by a shared household email, which is what makes this
      // sub-toggle load-bearing rather than cosmetic.)
      openMemberSearchIncludesMinors:
        "governs whether MINORS appear in the open member type-ahead; a child's " +
        "discoverability is never a value another club's bundle gets to set — " +
        "OWNER JUDGEMENT (#2306, D-18)",
    },
    defaults: () => DEFAULT_MEMBER_GUEST_SETTINGS,
  },
  {
    entity: "internet-banking-payment-settings",
    delegate: "internetBankingPaymentSettings",
    fields: ["holdBedSlots", "holdDays", "minimumDaysBeforeCheckIn"],
    // All non-null (@default); a present null fails the dry-run (#2200). Int
    // bounds mirror the admin route (internet-banking-settings): holdDays
    // z.number().int().min(1).max(30), minimumDaysBeforeCheckIn min(0).max(365).
    constraints: {
      holdBedSlots: { required: true },
      holdDays: { required: true, min: 1, max: 30 },
      minimumDaysBeforeCheckIn: { required: true, min: 0, max: 365 },
    },
    defaults: () => DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS,
  },
  {
    // DB-first club identity (E3 #1929). Singleton row id="default"; all fields
    // nullable and served through the runtime fallback chain, so exporting/
    // importing them moves only the admin-set overrides.
    entity: "club-identity-settings",
    delegate: "clubIdentitySettings",
    fields: ["name", "shortName", "hutLeaderLabel", "facebookUrl"],
    // No override saved = every column null, which is what the admin GET
    // synthesises. See DEFAULTS_INTENTIONALLY_PARTIAL.
    // No `constraints`: every column is nullable (String?), so null is a
    // legitimate value — nothing to require (#2200 nullability audit).
    defaults: () => ({}),
  },
  {
    entity: "email-message-setting",
    delegate: "emailMessageSetting",
    // lodgeName / lodgeTravelNote / doorCode were all dropped upstream (fork
    // #15, PR #1663): lodge identity (incl. the lodge door code) now resolves
    // from the Lodge row, so none are columns here — do not export/import them.
    // (The lodge's door code travels in lodge.json, opt-in.)
    fields: [
      "clubName", "bookingsName", "emailFromName", "supportEmail",
      "contactEmail", "publicUrl",
    ],
    // As club-identity-settings: these columns are nullable overrides on top of
    // the install's own club.json/env identity, and that identity is not
    // portable. See DEFAULTS_INTENTIONALLY_PARTIAL.
    // No `constraints`: every column is nullable (String?), so null is a
    // legitimate value — nothing to require (#2200 nullability audit).
    defaults: () => ({}),
  },
  {
    entity: "group-discount-setting",
    delegate: "groupDiscountSetting",
    fields: ["minGroupSize", "summerOnly", "enabled"],
    // All non-null (@default); a present null fails the dry-run (#2200).
    // minGroupSize mirrors the admin route (booking-policies/group-discount):
    // z.number().int().min(2).max(200). The route's additional
    // minGroupSize <= lodgeCapacity check is a dynamic capacity guard, not a
    // static bound, so it is not mirrored here.
    constraints: {
      minGroupSize: { required: true, min: 2, max: 200 },
      summerOnly: { required: true },
      enabled: { required: true },
    },
    excluded: {
      rateMembershipTypeId:
        "FK to a MembershipType row; an instance-local id that need not resolve " +
        "on the target, so the target keeps its own seeded default type",
    },
    defaults: () => DEFAULT_GROUP_DISCOUNT_SETTING,
  },
  {
    entity: "membership-nomination-settings",
    delegate: "membershipNominationSettings",
    fields: [
      "gateEnabled", "minimumMembershipMonths", "minimumNights",
      "requiredSignOffs", "gateEffectiveFrom",
    ],
    // gateEffectiveFrom is nullable (DateTime?) — null is a legitimate value, so
    // it carries no constraint. The other four are non-null (@default) and fail
    // the dry-run on a present null (#2200). Int bounds mirror the admin route
    // (membership-nomination-settings): minimumMembershipMonths
    // z.number().int().min(0).max(600), minimumNights min(0).max(3650),
    // requiredSignOffs min(1).max(10).
    constraints: {
      gateEnabled: { required: true },
      minimumMembershipMonths: { required: true, min: 0, max: 600 },
      minimumNights: { required: true, min: 0, max: 3650 },
      requiredSignOffs: { required: true, min: 1, max: 10 },
    },
    defaults: () => DEFAULT_MEMBERSHIP_NOMINATION_SETTINGS,
  },
  {
    entity: "membership-lockout-settings",
    delegate: "membershipLockoutSettings",
    // useFeeScheduleItemCodes (#2109) is portable paid-detection configuration —
    // it selects how a club's own Xero invoices are recognised as membership
    // payments (any fee-schedule item code vs the single subscription code), a
    // per-club billing preference exactly like `enabled`/`textFallbackEnabled`.
    // It was added after this list was written and had silently never travelled;
    // added here per the #2178 audit (should-travel).
    // #2543/#2561: `mode` replaced the legacy `enabled` boolean, and that COLUMN is
    // gone — so `enabled` is not a field here. It is still a BUNDLE KEY, though, and
    // that distinction is the whole of the hook below.
    fields: [
      "mode", "financialYearEndMonthOverride", "textFallbackEnabled",
      "useFeeScheduleItemCodes",
    ],
    // financialYearEndMonthOverride is nullable (Int?) — null (= follow Xero's
    // accounting year) is a legitimate value, so it carries no `required`; its
    // 1–12 month bound still applies when a value is present, mirroring the admin
    // route (membership-lockout-settings): z.number().int().min(1).max(12)
    // .nullable(). The two booleans are non-null (@default) and fail on a present
    // null (#2200).
    //
    // `mode` IS required, because its column is now NOT NULL (#2543/#2561) and
    // #2200's rule is that a present null on such a column fails the dry-run rather
    // than the write. It costs a pre-#2543 bundle nothing: `parseSingleton` skips an
    // ABSENT key before the null check (`if (!(field in record)) continue`), so
    // `required` can only ever fire on a key that is present and null — and a bundle
    // that carries `mode: null` alongside `enabled` has already had a real mode
    // derived for it by the `reconcile` hook below, which runs first. What is left
    // for this rule to catch is the shape nothing else can: `mode: null` with no
    // `enabled` key to derive from, in a hand-trimmed or partially-written file.
    // Without it that file passed the dry-run reporting a policy change and then
    // aborted the whole import transaction on `mode: null` against a non-nullable
    // enum — an unfiltered `create: { id: "default", ...data }` on a target with no
    // row, or the wholesale `update` overwrite mode performs.
    constraints: {
      financialYearEndMonthOverride: { min: 1, max: 12 },
      mode: { required: true },
      textFallbackEnabled: { required: true },
      useFeeScheduleItemCodes: { required: true },
    },
    defaults: () => DEFAULT_MEMBERSHIP_LOCKOUT_SETTINGS,
    // BUNDLE-FORMAT compatibility, which outlives the column (#2543/#2561).
    //
    // A bundle exported before #2543 carries `enabled` and no `mode`. The column it
    // was named after has been dropped, but the FILE still exists on operators'
    // disks and in their backups, and it still records a real decision: whether that
    // club gated bookings on unpaid subscriptions. So the key is read here and
    // mapped to the mode it means (`true -> HARD_BLOCK`, `false -> NO_BLOCK`), the
    // same mapping the migration applied to live rows.
    //
    // WHY A HOOK AND NOT A FIELD. Without this, `enabled` would be an unknown key:
    // `parseSingleton` only type-checks names in `fields`, and both the plan and the
    // apply build their Prisma payload from `fields`, so the key would be silently
    // dropped and the target would KEEP ITS OWN mode while the dry-run reported no
    // change to the policy. A club importing a pre-#2543 bundle to turn the lockout
    // off would be told it worked while every unpaid member went on being refused.
    // Deriving `mode` here puts the value on a field that does travel.
    //
    // The reverse branch is gone with the column: there is no longer a boolean to
    // re-derive, and writing one would name a column that does not exist.
    //
    // IT DERIVES ONLY INTO AN ABSENT-OR-NULL `mode`, and never over a value the
    // bundle actually states. A present `mode` — including a hand-edited
    // `"HRD_BLOCK"` — is handed to the validation loop untouched, where the DMMF
    // enum check refuses it by name, so a bundle cannot invent a fourth policy and a
    // typo cannot be silently "corrected" into whatever the legacy boolean said.
    // That is also why the test is written out here rather than deferred to
    // `isSubscriptionLockoutMode`: the two answers differ on exactly the strings
    // this branch must not touch.
    reconcile: (incoming) => {
      const stated = "mode" in incoming && incoming.mode !== null;
      if (stated) {
        return incoming;
      }
      if (typeof incoming.enabled === "boolean") {
        return {
          ...incoming,
          mode: incoming.enabled ? "HARD_BLOCK" : "NO_BLOCK",
        };
      }
      // `mode` is absent or null with nothing to derive from. Absent means "this
      // bundle says nothing about the policy", which merge mode honours by leaving
      // the target's own mode alone; a present null is a broken file, and
      // `constraints.mode.required` above fails the dry-run on it.
      return incoming;
    },
  },
  {
    entity: "membership-cancellation-setting",
    delegate: "membershipCancellationSetting",
    fields: ["warningText", "rejoinProcessText", "xeroArchiveContactsOnCancellation"],
    // warningText / rejoinProcessText are nullable (String?) — null is a
    // legitimate value, so no `required`. xeroArchiveContactsOnCancellation is a
    // non-null Boolean (@default false) and fails on a present null (#2200).
    constraints: {
      xeroArchiveContactsOnCancellation: { required: true },
    },
    defaults: () => DEFAULT_MEMBERSHIP_CANCELLATION_SETTINGS,
  },
  {
    // #2200 (model-level completeness audit): portable club login/security POLICY
    // — the password-complexity rules and the magic-link token TTL. Every field is
    // a portable club decision with no secret, credential, tenant, or deployment
    // coupling (the FORBIDDEN_FIELD_PATTERNS sweep passes: none is a secret/token
    // value — magicLinkTtlMinutes is a duration, not a token). An absent row reads
    // as the code default (normalizeLoginSecurityPolicy over null), so the exporter
    // emits exactly that constant.
    entity: "login-security-setting",
    delegate: "loginSecuritySetting",
    fields: [
      "minPasswordLength", "requireUppercase", "requireLowercase",
      "requireDigit", "requireSymbol", "magicLinkTtlMinutes",
    ],
    // Every column is a non-null policy field: a present null fails the dry-run
    // (#2200). Range bounds are not enforced here because normalizeLoginSecurityPolicy
    // already clamps minPasswordLength/magicLinkTtlMinutes on read, so an out-of-range
    // import is corrected at read time rather than silently mis-applied.
    constraints: {
      minPasswordLength: { required: true },
      requireUppercase: { required: true },
      requireLowercase: { required: true },
      requireDigit: { required: true },
      requireSymbol: { required: true },
      magicLinkTtlMinutes: { required: true },
    },
    defaults: () => ({ ...DEFAULT_LOGIN_SECURITY_POLICY }),
  },
  {
    // #2200: portable public-content visibility POLICY — the six double-opt-in
    // embed gates plus whether the public "Book Now" button is shown. The
    // Book-Now DESTINATION does not travel: bookNowTarget/bookNowPageId reference
    // a specific install's PageContent id (instance-local, like the phase-7
    // lodgeId / rateMembershipTypeId FK exclusions), and getBookNowVariants fails
    // open to the booking flow when the target page is absent — so a target keeps
    // its own destination and the button is never dead.
    entity: "public-content-settings",
    delegate: "publicContentSettings",
    fields: [
      "membershipTypes", "entranceFees", "hutFees", "bookingPolicySummary",
      "cancellationPolicy", "annualFees", "showBookNow", "committeePhotoDisplay",
    ],
    // Every exported column is non-null: a present null fails the dry-run
    // (#2200). All but committeePhotoDisplay are boolean gates; that one is the
    // CommitteePhotoDisplay enum (NONE/CIRCLE/SQUARE), validated automatically
    // against the DMMF. It is portable public-page config exactly like the gates
    // — no instance-local reference (unlike the excluded Book-Now FKs), and the
    // setting travels without any member photo, which stays member data outside
    // config transfer and gated by the committee-only serving boundary.
    constraints: {
      membershipTypes: { required: true },
      entranceFees: { required: true },
      hutFees: { required: true },
      bookingPolicySummary: { required: true },
      cancellationPolicy: { required: true },
      annualFees: { required: true },
      showBookNow: { required: true },
      committeePhotoDisplay: { required: true },
    },
    excluded: {
      bookNowTarget:
        "half of the instance-local Book-Now destination; only meaningful with " +
        "bookNowPageId, which names a specific install's PageContent row",
      bookNowPageId:
        "FK to a PageContent row; an instance-local id that need not resolve on " +
        "the target — getBookNowVariants fails open to the booking flow without it",
      contactCommitteeRoleKey:
        "soft reference to a CommitteeRole.key selecting the Contact page Club " +
        "Details role; instance-local like the Book-Now exclusions — a key need " +
        "not resolve on the target, where the Contact page falls open to the " +
        "booking-officer heuristic when it matches no active role",
    },
    defaults: () => DEFAULT_PUBLIC_CONTENT_SETTINGS,
  },
  {
    // #2200: portable membership billing POLICY — the invoice due-days window and
    // the club family-billing model. Neither embeds a Xero/provider or tenant
    // reference (verified against the schema), so both are portable club config,
    // exactly like the other membership-settings singletons. familyBillingMode
    // interacts with PER_FAMILY fee schedules (which travel in the membership-fees
    // category); a whole-bundle export stays internally consistent, and the
    // admin-reviewed dry-run surfaces any partial-import mismatch.
    entity: "membership-subscription-billing-settings",
    delegate: "membershipSubscriptionBillingSettings",
    fields: ["invoiceDueDays", "familyBillingMode"],
    // Mirror the admin API's bounds so a hand-edited bundle fails the dry-run:
    // invoiceDueDays is 1–365 (subscription-billing route z.number().int().min(1).max(365)),
    // and both fields are non-null. familyBillingMode is enum-validated automatically.
    constraints: {
      invoiceDueDays: { required: true, min: 1, max: 365 },
      familyBillingMode: { required: true },
    },
    defaults: () => DEFAULT_MEMBERSHIP_SUBSCRIPTION_BILLING_SETTINGS,
  },
];

function fileFor(entity: string): string {
  return `club-settings/${entity}.json`;
}

/**
 * True when the incoming file carries no allowlisted value at all — every field
 * present is `null` (or none is present). In practice this is only the
 * `DEFAULTS_INTENTIONALLY_PARTIAL` pair exported from a club that never saved
 * an override; every other singleton exports concrete defaults.
 *
 * Such a file must NOT create a row on a target that has none (#2171 review):
 * `clubIdentitySelfHealStep.isPresent` (`src/lib/config-self-heal.ts`) keys
 * purely on the `ClubIdentitySettings` row EXISTING, and the whole self-heal
 * runner is skipped while `clubConfigSource !== "primary"` on the promise that
 * it repairs itself on the next boot with a valid `config/club.json`. An import
 * onto a SAFE_DEFAULT install would otherwise plant an all-null row that
 * permanently satisfies that presence check, so identity would never be healed
 * from the file — and `clubIdentityName` in the setup snapshot would stay null
 * forever. Skipping restores the exact pre-#2171 behaviour for the no-row case
 * at no cost: an all-null file carries nothing to write.
 */
function carriesNoValue(
  spec: SingletonSpec,
  incoming: Record<string, unknown>,
): boolean {
  return spec.fields.every((f) => !(f in incoming) || incoming[f] === null);
}

for (const s of SINGLETONS) {
  registerEntity({
    entity: s.entity,
    category: "club-settings",
    tier: "key-strong",
    format: "json",
    file: fileFor(s.entity),
    naturalKey: [],
    singleton: true,
    fields: s.fields,
    optInFields: s.optInFields,
  });
}

/**
 * Parse a singleton JSON file and type-check every allowlisted field against
 * the REAL Prisma model column types (via dmmf) — a hand-edited value of the
 * wrong shape fails the dry-run as an error instead of a write-time Prisma
 * exception mid-transaction. Returns null (with errors pushed) on failure.
 *
 * A spec's `reconcile` hook runs before that type-check, so what is validated is
 * exactly what will be written, and a derived field can still be `required`.
 */
function parseSingleton(
  spec: SingletonSpec,
  bytes: Uint8Array,
  errors: string[],
): Record<string, unknown> | null {
  const file = fileFor(spec.entity);
  let incoming: unknown;
  try {
    incoming = JSON.parse(strFromU8(bytes));
  } catch (error) {
    errors.push(
      `${file}: not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    );
    return null;
  }
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    errors.push(`${file}: must be a JSON object`);
    return null;
  }
  // The spec's own legacy-key reconciliation runs FIRST, so a field it derives can
  // still carry `constraints.required` and the loop below judges the record that
  // will actually be written. See `SingletonSpec.reconcile` for why that order is
  // the one that closes the hole rather than opening one.
  const record = spec.reconcile
    ? spec.reconcile(incoming as Record<string, unknown>)
    : (incoming as Record<string, unknown>);
  const modelName = spec.delegate[0].toUpperCase() + spec.delegate.slice(1);
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  let ok = true;
  for (const field of spec.fields) {
    if (!(field in record)) continue;
    const value = record[field];
    const column = model?.fields.find((f) => f.name === field);
    if (!column) continue; // guarded separately by the schema-drift test
    const rule = spec.constraints?.[field];
    if (value === null) {
      // Prisma 7's client DMMF strips `isRequired`, so non-nullability is no
      // longer readable from the schema here (#2200) — a spec declares it via
      // `constraints.required`. A present null on a required field is a plan
      // error, so a hand-edited bundle fails the dry-run, not the write.
      if (rule?.required) {
        errors.push(`${file}: ${field} — null is not allowed (required setting)`);
        ok = false;
      }
      continue;
    }
    const customValidationError = rule?.validate?.(value);
    if (customValidationError) {
      errors.push(`${file}: ${field} â€” ${customValidationError}`);
      ok = false;
      continue;
    }
    // A custom validator owns the complete shape check for structured values
    // (notably String[]); Prisma's scalar `column.type` alone is insufficient.
    if (rule?.validate) continue;
    // Enum columns (e.g. familyBillingMode) are validated against the real
    // Prisma enum so an invalid value fails the dry-run, not the write (#2200).
    if (column.kind === "enum") {
      if (typeof value !== "string" || !prismaEnumValues(column.type).has(value)) {
        errors.push(
          `${file}: ${field} — ${JSON.stringify(value)} is not a valid ${column.type}`,
        );
        ok = false;
      }
      continue;
    }
    const fails =
      (column.type === "Boolean" && typeof value !== "boolean") ||
      (column.type === "Int" && (typeof value !== "number" || !Number.isInteger(value))) ||
      (column.type === "String" && typeof value !== "string") ||
      (column.type === "DateTime" &&
        (typeof value !== "string" || Number.isNaN(new Date(value).getTime())));
    if (fails) {
      errors.push(
        `${file}: ${field} — ${JSON.stringify(value)} is not a valid ${column.type}`,
      );
      ok = false;
      continue;
    }
    // Inclusive Int bounds mirroring the admin API, so an out-of-range value
    // (e.g. invoiceDueDays outside 1–365) fails the dry-run, not the write.
    if (
      column.type === "Int" &&
      typeof value === "number" &&
      ((rule?.min !== undefined && value < rule.min) ||
        (rule?.max !== undefined && value > rule.max))
    ) {
      const range =
        rule?.min !== undefined && rule?.max !== undefined
          ? `${rule.min}–${rule.max}`
          : rule?.min !== undefined
            ? `at least ${rule.min}`
            : `at most ${rule?.max}`;
      errors.push(`${file}: ${field} — ${value} is out of range (must be ${range})`);
      ok = false;
    }
  }
  if (!ok) return null;
  return record;
}

function delegateOf(db: ReadDb | TxDb, name: string): SingletonDelegate {
  return (db as unknown as Record<string, SingletonDelegate>)[name];
}

/** Fields to serialise, dropping opt-in fields unless the admin opted in. */
function exportFields(spec: SingletonSpec, includeOptIn: boolean): string[] {
  if (includeOptIn) return spec.fields;
  const optIn = new Set(spec.optInFields ?? []);
  return spec.fields.filter((f) => !optIn.has(f));
}

function project(
  row: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = row[f] ?? null;
  return out;
}

export const clubSettingsExporter: CategoryExporter = {
  category: "club-settings",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const entries: BundleEntry[] = [];
    for (const spec of SINGLETONS) {
      const row = await delegateOf(ctx.db, spec.delegate).findUnique({
        where: { id: "default" },
        select: spec.select,
      });
      // #2171: a club that has never SAVED a singleton is not a club with no
      // settings — every read site synthesises defaults on a miss. Export those
      // effective values in place of the missing row so the bundle carries what
      // the source club actually runs on, and an import reproduces it instead
      // of silently leaving the target's own row in place.
      //
      // The cost, accepted by the owner on #2171: a bundle no longer
      // distinguishes "saved these values" from "never saved anything", and
      // importing one MATERIALISES the row in the target. That is visible in
      // the FOUR setup-checklist signals that key on row existence: three
      // booleans in the snapshot (bookingDefaultsConfigured,
      // groupDiscountConfigured, membershipCancellationSettingsConfigured,
      // `src/lib/setup-readiness-db.ts`) plus the Module Controls step, which
      // reads `Boolean(db.adminModuleSettings)` directly in
      // `src/lib/setup-readiness.ts` (`required: false`, so it downgrades a
      // warning rather than gating). See docs/config-transfer.
      //
      // The one exception is a file whose every value is null — see
      // carriesNoValue: it creates no row, so it cannot flip any of them.
      const fields = exportFields(spec, ctx.includeDoorCodes);
      entries.push({
        path: fileFor(spec.entity),
        category: "club-settings",
        rowCount: 1,
        bytes: strToU8(
          JSON.stringify(project(row ?? spec.defaults(), fields), null, 2),
        ),
      });
    }
    return entries;
  },
};

async function planClubSettings(
  ctx: PlanContext,
): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  for (const spec of SINGLETONS) {
    const bytes = ctx.files.get(fileFor(spec.entity));
    if (!bytes) continue;
    const incoming = parseSingleton(spec, bytes, errors);
    if (!incoming) continue;
    const current = await delegateOf(ctx.db, spec.delegate).findUnique({
      where: { id: "default" },
      select: spec.select,
    });
    const currentHash = current
      ? hashRow(spec.fields, current)
      : "absent";
    fingerprintParts.push(`${spec.entity}:default:${currentHash}`);
    // Mirror apply's write-data (present allowlisted fields, mode-filtered) and
    // diff it against the current row so the dry-run reflects the chosen mode.
    const data: Record<string, unknown> = {};
    for (const f of spec.fields) if (f in incoming) data[f] = incoming[f];
    const writeData = updateDataForMode(ctx.mode, incoming, data);
    const changed = changedFields(writeData, current);
    // Mirror apply's no-row/no-value skip so the dry-run cannot promise a
    // "create" the apply will decline to make.
    const noOp = !current && carriesNoValue(spec, incoming);
    items.push({
      entity: spec.entity,
      key: "default",
      action: noOp ? "unchanged" : planActionFor(current, changed),
      changedFields: noOp || changed.length === 0 ? undefined : changed,
    });
  }
  return { items, warnings: [], errors, fingerprintParts };
}

async function applyClubSettings(
  ctx: ApplyContext,
): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive only
  for (const spec of SINGLETONS) {
    const bytes = ctx.files.get(fileFor(spec.entity));
    if (!bytes) continue;
    const incoming = parseSingleton(spec, bytes, errors);
    if (!incoming) { result.skipped += 1; continue; }
    // Replace-present: only allowlisted fields actually present in the bundle.
    const data: Record<string, unknown> = {};
    for (const f of spec.fields) {
      if (f in incoming) data[f] = incoming[f];
    }
    const delegate = delegateOf(ctx.tx, spec.delegate);
    const existing = await delegate.findUnique({
      where: { id: "default" },
      select: spec.select,
    });
    if (!existing) {
      // An all-null file plants nothing but a row, and that row would defeat
      // the boot-time identity self-heal for good — see carriesNoValue.
      if (carriesNoValue(spec, incoming)) {
        result.unchanged += 1;
        continue;
      }
      await delegate.upsert({
        where: { id: "default" },
        create: { id: "default", ...data },
        update: {},
        select: spec.select,
      });
      result.created += 1;
      continue;
    }
    const write = updateDataForMode(ctx.mode, incoming, data);
    const changed = changedFields(write, existing);
    if (changed.length === 0) {
      result.unchanged += 1;
      continue;
    }
    await delegate.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: write,
      select: spec.select,
    });
    result.updated += 1;
  }
  return result;
}

export const clubSettingsImporter: CategoryImporter = {
  category: "club-settings",
  plan: planClubSettings,
  apply: applyClubSettings,
};
