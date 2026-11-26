/**
 * The request schemas of the officer promo-code routes under
 * `/api/admin/promo-codes/**` (ALP-719, `INV-MCP-006`): the list, creating and
 * changing a code, and one code's redemptions report.
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). Zod and client-safe
 * helpers only: no database or server imports, so the catalogue can load it.
 * Moved here from the two route files, which each held a copy of the code's
 * rule fields; the create and update bodies now share one declaration of them.
 *
 * Money is integer cents (`INV-MONEY`). The routes still check what one field
 * cannot say alone: the value each type needs, date order, a unique code and
 * real lodges.
 */
import { z } from "zod";

import { adminListPageField } from "@/lib/admin-list-page";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

/** `GET /api/admin/promo-codes`. Anything but `true` reads the live codes, as the page always has. */
export const adminPromoCodeListQuerySchema = z.object({
  archived: z
    .enum(["true", "false"])
    .optional()
    .describe("`true` for archived codes; left out or `false`, the codes not archived."),
});

const promoCodeTypeSchema = z
  .enum(["PERCENTAGE", "FIXED_AMOUNT", "FREE_NIGHTS", "FIXED_NIGHTLY_PRICE"])
  .describe(
    "`PERCENTAGE` (needs `percentOff`), `FIXED_AMOUNT` (needs `valueCents`), `FREE_NIGHTS` (needs `freeNightsPerIndividual`) or `FIXED_NIGHTLY_PRICE` (needs `fixedNightlyPriceCents`).",
  );

const promoCodeCodeSchema = z
  .string()
  .min(1, "Code is required")
  .transform((s) => s.toUpperCase().trim())
  .describe("The code members type; stored upper case and must be unique.");

/** The rule fields the create and update bodies share, each meaning the same on both. */
const promoCodeRuleFields = {
  description: z.string().optional().nullable().describe("A note for officers about the code."),
  valueCents: z
    .number()
    .int()
    .min(0)
    .optional()
    .nullable()
    .describe("`FIXED_AMOUNT`: the amount off per eligible guest, in integer cents."),
  percentOff: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .nullable()
    .describe("`PERCENTAGE`: the whole-number percentage off per eligible guest."),
  freeNightsPerIndividual: z
    .number()
    .int()
    .min(0)
    .optional()
    .nullable()
    .describe("`FREE_NIGHTS`: the most free nights each eligible guest gets on one booking."),
  lifetimeFreeNightsCap: z
    .number()
    .int()
    .min(1)
    .optional()
    .nullable()
    .describe("`FREE_NIGHTS`: the most free nights one member may ever claim from the code; null for no limit."),
  fixedNightlyPriceCents: z
    .number()
    .int()
    .min(0)
    .optional()
    .nullable()
    .describe("`FIXED_NIGHTLY_PRICE`: the nightly price per eligible guest-night, in integer cents."),
  fixedNightlyMode: z
    .enum(["SET_PRICE", "CAP_ONLY"])
    .optional()
    .nullable()
    .describe("`FIXED_NIGHTLY_PRICE`: `SET_PRICE` sets every eligible night to the price; `CAP_ONLY` (the default) only lowers nights above it."),
  maxNightlyValueCents: z
    .number()
    .int()
    .min(0)
    .optional()
    .nullable()
    .describe("`PERCENTAGE` and `FREE_NIGHTS`: the most taken off one guest-night, in integer cents."),
  maxGuestsPerBooking: z
    .number()
    .int()
    .min(1)
    .optional()
    .nullable()
    .describe("The most guests on one booking the code applies to; null for all."),
  maxRedemptionsTotal: z
    .number()
    .int()
    .min(1)
    .optional()
    .nullable()
    .describe("The most uses across all members; null for no limit."),
  maxUniqueMembersTotal: z
    .number()
    .int()
    .min(1)
    .optional()
    .nullable()
    .describe("The most distinct members who may ever use the code; null for no limit."),
  maxUsesPerMember: z
    .number()
    .int()
    .min(1)
    .optional()
    .nullable()
    .describe("The most bookings one member may use the code on (1 for single use); null for no limit."),
  validFrom: dateOnlyStringSchema.optional().nullable().describe("The first day the code can be entered, `YYYY-MM-DD`."),
  validUntil: dateOnlyStringSchema.optional().nullable().describe("The last day the code can be entered, `YYYY-MM-DD`."),
  bookingStartFrom: dateOnlyStringSchema
    .optional()
    .nullable()
    .describe("Only bookings checking in on or after this day, `YYYY-MM-DD`."),
  bookingStartUntil: dateOnlyStringSchema
    .optional()
    .nullable()
    .describe("Only bookings checking in before this day, `YYYY-MM-DD`."),
  assignedMembersOnlyOwnNights: z
    .boolean()
    .optional()
    .describe(
      "With assigned members: true applies the code only to the assigned members' own nights. Left out on create, false for a fixed nightly price that is not member-guests only, true otherwise.",
    ),
  xeroItemCode: z.string().trim().min(1).max(30).optional().nullable().describe("The Xero item code the discount line uses."),
  xeroAccountCode: z.string().trim().min(1).max(10).optional().nullable().describe("The Xero account code the discount line uses."),
  assignedMemberIds: z
    .array(z.string())
    .optional()
    .describe("Members the code is assigned to (only they may use it). Given, the list replaces the assignments; empty for anyone."),
  // Optional per-lodge restriction (multi-lodge phase 6, ADR-001 resolved
  // question 4). Empty/omitted clears the restriction (redeemable at every
  // lodge); a non-empty list restricts redemption to those lodges.
  lodgeIds: z
    .array(z.string())
    .max(20)
    .optional()
    .describe("Lodges (from `list_lodges`) the code is redeemable at. Empty for every lodge; given, the list replaces the restriction."),
};

const membersOnlyDescription = "Only a member may use the code as booker.";
const memberGuestsOnlyDescription = "The code applies only to guests who are members.";
const activeDescription = "Whether the code can be used.";

/** `POST /api/admin/promo-codes`. */
export const promoCodeCreateBodySchema = z.object({
  code: promoCodeCodeSchema,
  type: promoCodeTypeSchema,
  ...promoCodeRuleFields,
  membersOnly: z.boolean().default(false).describe(`${membersOnlyDescription} False by default.`),
  memberGuestsOnly: z.boolean().default(false).describe(`${memberGuestsOnlyDescription} False by default.`),
  active: z.boolean().default(true).describe(`${activeDescription} True by default.`),
});

/** `PUT /api/admin/promo-codes/[id]`: every field optional; a field left out keeps its value. */
export const promoCodeUpdateBodySchema = z.object({
  code: promoCodeCodeSchema.optional(),
  type: promoCodeTypeSchema.optional(),
  ...promoCodeRuleFields,
  membersOnly: z.boolean().optional().describe(membersOnlyDescription),
  memberGuestsOnly: z.boolean().optional().describe(memberGuestsOnlyDescription),
  active: z.boolean().optional().describe(activeDescription),
});

/**
 * `GET /api/admin/promo-codes/[id]/redemptions`. Redeemed-date range (`from`
 * and `to` are inclusive club-timezone days), an optional lodge filter, and
 * page/pageSize pagination. Filtering never changes the all-time totals. The
 * page's CSV export (`export=1`) is not one of these fields: it is the
 * website's alone.
 */
export const adminPromoRedemptionsQuerySchema = z.object({
  from: dateOnlyStringSchema.optional().describe("Only uses redeemed on or after this day (club time), `YYYY-MM-DD`."),
  to: dateOnlyStringSchema.optional().describe("Only uses redeemed on or before this day (club time), `YYYY-MM-DD`."),
  lodgeId: z.string().min(1).optional().describe("Only uses on bookings at this lodge, from `list_lodges`."),
  page: adminListPageField.describe("The page to read, from 1."),
  pageSize: z.coerce.number().int().min(1).max(200).default(50).describe("Uses per page, 1 to 200; 50 by default."),
});
