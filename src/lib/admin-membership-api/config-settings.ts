/**
 * The Membership settings routes' request schemas, shared with the AI app
 * actions that call them (ALP-720, `INV-SSOT`): the app is described exactly
 * the fields each route enforces. Free of the database client, so the
 * catalogue can load it.
 *
 * Routes: `/api/admin/club-posts/settings`, `/api/admin/member-fields`,
 * `/api/admin/membership-cancellation-settings`,
 * `/api/admin/membership-nomination-settings` and
 * `/api/admin/membership-lockout-settings` (with its `liability-impact` read).
 */
import { z } from "zod";

import { MEMBER_FIELD_KEYS, type MemberFieldKey } from "@/config/member-fields";
import { RETENTION_CHOICES } from "@/lib/club-post-retention-choices";
import {
  CHOOSABLE_LIABILITY_AGE_SOURCES,
  SUBSCRIPTION_LIABILITY_AGE_SOURCES,
  SUBSCRIPTION_REQUIRED_TYPE_AGE_RULES,
} from "@/lib/policies/subscription";
import { SUBSCRIPTION_LOCKOUT_MODES } from "@/lib/subscription-lockout-modes";

/** The retention periods, in days, the message board settings offer. */
export const CLUB_POST_RETENTION_DAYS = RETENTION_CHOICES.map((choice) => choice.days) as [number, ...number[]];

/** `PUT /api/admin/club-posts/settings`: one of the offered periods; 0 keeps everything. */
export const clubPostRetentionUpdateSchema = z.object({
  retentionDays: z.literal(CLUB_POST_RETENTION_DAYS),
});

/** `PUT /api/admin/member-fields`: every optional profile field, on or off. */
export const memberFieldsUpdateSchema = z
  .object({
    settings: z
      .object(
        Object.fromEntries(MEMBER_FIELD_KEYS.map((key) => [key, z.boolean()])) as Record<
          MemberFieldKey,
          z.ZodBoolean
        >,
      )
      .strict(),
  })
  .strict();

function nullableTrimmedString(maxLength: number) {
  return z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    },
    z.string().min(1).max(maxLength).nullable().optional(),
  );
}

/**
 * `PUT /api/admin/membership-cancellation-settings`: the whole setting. A
 * field left out is saved as its default (no text, no Xero archiving, no
 * contact groups), not kept.
 */
export const membershipCancellationSettingsSchema = z
  .object({
    warningText: nullableTrimmedString(4000),
    rejoinProcessText: nullableTrimmedString(4000),
    xeroArchiveContactsOnCancellation: z.boolean().optional(),
    xeroContactGroups: z
      .array(
        z
          .object({
            groupId: z.string().trim().min(1).max(200),
            groupName: nullableTrimmedString(200),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

/** `PUT /api/admin/membership-nomination-settings`: a field left out keeps its value. */
export const membershipNominationSettingsSchema = z
  .object({
    gateEnabled: z.boolean().optional(),
    minimumMembershipMonths: z.number().int().min(0).max(600).optional(),
    minimumNights: z.number().int().min(0).max(3650).optional(),
    requiredSignOffs: z.number().int().min(1).max(10).optional(),
    gateEffectiveFrom: z.string().datetime().nullable().optional(),
  })
  .strict();

/**
 * `PUT /api/admin/membership-lockout-settings`: a field left out keeps its
 * value. Still `.strict()`, so an old client sending the retired `enabled`
 * boolean is refused rather than silently ignored (#2543, #2561).
 * `requiredTypeAgeRule` and `liabilityAgeSource` are the club's
 * subscription-liability rule (#5190): chosen together, and a change needs
 * Finance edit as well as Membership edit (`liabilityChoiceRefusal`).
 */
export const membershipLockoutSettingsSchema = z
  .object({
    mode: z.enum(SUBSCRIPTION_LOCKOUT_MODES).optional(),
    financialYearEndMonthOverride: z.number().int().min(1).max(12).nullable().optional(),
    textFallbackEnabled: z.boolean().optional(),
    useFeeScheduleItemCodes: z.boolean().optional(),
    requiredTypeAgeRule: z.enum(SUBSCRIPTION_REQUIRED_TYPE_AGE_RULES).optional(),
    liabilityAgeSource: z.enum(SUBSCRIPTION_LIABILITY_AGE_SOURCES).optional(),
  })
  .strict();

/**
 * `GET /api/admin/membership-lockout-settings/liability-impact`: a proposed
 * rule, both answers, from the values open for choice, exactly what the
 * settings `PUT` would accept as an opt-in.
 */
export const liabilityImpactQuerySchema = z
  .object({
    requiredTypeAgeRule: z.enum(["ALWAYS_OWES", "AGE_TIER_EXEMPTS"]),
    liabilityAgeSource: z.enum(CHOOSABLE_LIABILITY_AGE_SOURCES),
  })
  .strict();
