/**
 * The request schemas of the Lodge Operations chore and work-party officer
 * routes (ALP-722, `INV-MCP-006`): the chores a roster is built from, and
 * work parties (working bees) with their discount.
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). Zod, the Prisma enums
 * and client-safe helpers only: no database or server imports, so the
 * catalogue can load it.
 */
import { AgeRestriction, ChoreFrequencyMode, ChoreTimeOfDay } from "@prisma/client";
import { z } from "zod";

import { parsedDateOnlySchema } from "@/lib/date-only-schema";

// ---------------------------------------------------------------------------
// Chores
// ---------------------------------------------------------------------------

/** `?lodgeId=` on the chore list: omitted lists every lodge's chores. */
export const choreListQuerySchema = z.object({
  lodgeId: z
    .string()
    .optional()
    .describe("A lodge id from `list_lodges` to list only that lodge's chores; omit for every lodge."),
});


// One description per field, shared by the create and the change.
const CHORE_FIELD = {
  recommendedPeopleMin: "Fewest people the chore takes, at least 1.",
  recommendedPeopleMax: "Most people the chore takes, at least the minimum.",
  isEssential: "Rostered every day it is due, however few guests are in.",
  ageRestriction:
    "Who may do it: `ANY`, `ADULTS_ONLY`, `MIXED_PREFERRED` (adults and children together) or `ADULT_SUPERVISED`.",
  conditionalNote: "A note on when the chore applies; null for none.",
  minAge: "Youngest age that may be given it; 0 for any age.",
  sortOrder: "Position in the roster, lowest first.",
  timeOfDay: "`MORNING`, `EVENING` or `ANYTIME`.",
  frequencyMode:
    "`DAILY`, `EVERY_X_DAYS` (with `frequencyDays`) or `SPECIFIC_DAYS` (with `frequencyDaysOfWeek`).",
  frequencyDays: "For `EVERY_X_DAYS`: how many days apart, at least 2; otherwise null.",
  frequencyDaysOfWeek: "For `SPECIFIC_DAYS`: the weekdays, 1 Monday to 7 Sunday.",
  active: "Whether rosters include it.",
} as const;

/** `POST /api/admin/chores`. */
export const choreCreateBodySchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string().optional().default("").describe("What doing the chore involves."),
    recommendedPeopleMin: z.number().int().min(1).default(1).describe(CHORE_FIELD.recommendedPeopleMin),
    recommendedPeopleMax: z.number().int().min(1).default(2).describe(CHORE_FIELD.recommendedPeopleMax),
    isEssential: z.boolean().default(false).describe(CHORE_FIELD.isEssential),
    ageRestriction: z.nativeEnum(AgeRestriction).default(AgeRestriction.ANY).describe(CHORE_FIELD.ageRestriction),
    conditionalNote: z.string().nullable().optional().default(null).describe(CHORE_FIELD.conditionalNote),
    minAge: z.number().int().min(0).default(0).describe(CHORE_FIELD.minAge),
    sortOrder: z.number().int().default(0).describe(CHORE_FIELD.sortOrder),
    timeOfDay: z.nativeEnum(ChoreTimeOfDay).default(ChoreTimeOfDay.ANYTIME).describe(CHORE_FIELD.timeOfDay),
    frequencyMode: z.nativeEnum(ChoreFrequencyMode).default(ChoreFrequencyMode.DAILY).describe(CHORE_FIELD.frequencyMode),
    frequencyDays: z.number().int().min(2).nullable().optional().default(null).describe(CHORE_FIELD.frequencyDays),
    frequencyDaysOfWeek: z
      .array(z.number().int().min(1).max(7))
      .optional()
      .default([])
      .describe(CHORE_FIELD.frequencyDaysOfWeek),
    active: z.boolean().default(true).describe(CHORE_FIELD.active),
    lodgeId: z.string().min(1).optional().describe("The lodge, from `list_lodges`; omitted means the default lodge."),
  })
  .superRefine((data, ctx) => {
    if (data.frequencyMode === "SPECIFIC_DAYS" && data.frequencyDaysOfWeek.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["frequencyDaysOfWeek"],
        message: "Select at least one day for SPECIFIC_DAYS chores",
      });
    }
  });

/** `PUT /api/admin/chores/[id]`: only what is sent changes. */
export const choreUpdateBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().describe("What doing the chore involves."),
  recommendedPeopleMin: z.number().int().min(1).optional().describe(CHORE_FIELD.recommendedPeopleMin),
  recommendedPeopleMax: z.number().int().min(1).optional().describe(CHORE_FIELD.recommendedPeopleMax),
  isEssential: z.boolean().optional().describe(CHORE_FIELD.isEssential),
  ageRestriction: z.nativeEnum(AgeRestriction).optional().describe(CHORE_FIELD.ageRestriction),
  conditionalNote: z.string().nullable().optional().describe(CHORE_FIELD.conditionalNote),
  minAge: z.number().int().min(0).optional().describe(CHORE_FIELD.minAge),
  sortOrder: z.number().int().optional().describe(CHORE_FIELD.sortOrder),
  timeOfDay: z.nativeEnum(ChoreTimeOfDay).optional().describe(CHORE_FIELD.timeOfDay),
  frequencyMode: z.nativeEnum(ChoreFrequencyMode).optional().describe(CHORE_FIELD.frequencyMode),
  frequencyDays: z.number().int().min(2).nullable().optional().describe(CHORE_FIELD.frequencyDays),
  frequencyDaysOfWeek: z
    .array(z.number().int().min(1).max(7))
    .optional()
    .describe(CHORE_FIELD.frequencyDaysOfWeek),
  active: z.boolean().optional().describe(CHORE_FIELD.active),
});

// ---------------------------------------------------------------------------
// Work parties
// ---------------------------------------------------------------------------

/**
 * The admin work-party create and update (both send every field). Moved here
 * from `work-party.ts`, a server module, so the catalogue can offer it.
 */
export const workPartyEventSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).optional().nullable(),
    startDate: parsedDateOnlySchema.describe("First discounted night, `YYYY-MM-DD`."),
    endDate: parsedDateOnlySchema.describe("Last discounted night, `YYYY-MM-DD`, on or after `startDate`."),
    discountPercent: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(100)
      .describe("Discount on those nights for a booking attending it, a whole percentage; 100 if omitted."),
    active: z
      .boolean()
      .default(true)
      .describe("Whether bookings can still say they attend it. Deactivating never changes existing bookings."),
    // Lodge the working bee is held at; null/omitted = club-wide event.
    lodgeId: z
      .string()
      .min(1)
      .optional()
      .nullable()
      .describe("The lodge it is held at, from `list_lodges`; null or omitted for a club-wide work party."),
  })
  .strict();
