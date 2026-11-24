/**
 * The request schemas of the Lodge Operations maintenance and food-order
 * settings routes: the maintenance report queue, its question set and policy,
 * the QR sign switch, and the food-order settings card (ALP-722,
 * `INV-MCP-006`).
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). No database or server
 * imports, so the catalogue can load it.
 *
 * Minting or rotating a QR sign (`POST /api/admin/maintenance-reports/tokens`)
 * answers the sign's bearer link once, so it is website-only and has no schema
 * here.
 */
import { z } from "zod";

import {
  MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX,
  MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN,
} from "@/config/club-settings-defaults";
import { adminListPageQueryFields } from "@/lib/admin-list-page";
import { FOOD_OFFICER_EMAIL_MAX_LENGTH, FOOD_OFFICER_LABEL_MAX_LENGTH } from "@/lib/food-order-rules";
import {
  MAX_MAINTENANCE_QUESTION_CHOICE_LENGTH,
  MAX_MAINTENANCE_QUESTION_CHOICES,
  MAX_MAINTENANCE_QUESTION_HELP_LENGTH,
  MAX_MAINTENANCE_QUESTION_LABEL_LENGTH,
  MAX_MAINTENANCE_QUESTIONS,
} from "@/lib/maintenance-report-limits";

// ---------------------------------------------------------------------------
// The maintenance report queue
// ---------------------------------------------------------------------------

/** `GET /api/admin/maintenance-reports`: one page of the queue. */
export const maintenanceReportListQuerySchema = z.object({
  status: z
    .enum(["OPEN", "IN_PROGRESS", "RESOLVED", "ALL"])
    .optional()
    .default("OPEN")
    .describe("Which reports: OPEN (the default, oldest first), IN_PROGRESS, RESOLVED or ALL (newest first)."),
  lodgeId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe("Only this lodge's reports, an id from `lodges` in this answer or `list_lodges_for_officers`."),
  source: z
    .enum(["MEMBER_PORTAL", "LODGE_QR", "ALL"])
    .optional()
    .default("ALL")
    .describe("Where reports came from: MEMBER_PORTAL (a signed-in member), LODGE_QR (the lodge's QR sign) or ALL."),
  ...adminListPageQueryFields,
});

const resolutionNoteField = z
  .string()
  .trim()
  .max(1000)
  .optional()
  .describe("What was done, kept only when the status is RESOLVED.");

/** One report's status move, without the route's `action` discriminator. */
export const maintenanceReportStatusBodySchema = z.object({
  status: z
    .enum(["OPEN", "IN_PROGRESS", "RESOLVED"])
    .describe("The new status. Moving off RESOLVED clears the resolution date and note."),
  note: resolutionNoteField,
});

/** Deleting one report's photo ahead of the retention sweep, without the `action` discriminator. */
export const maintenanceReportPhotoDeleteBodySchema = z.object({
  reason: z.string().trim().max(300).optional().describe("Why the photo is deleted early; recorded in the audit log."),
});

/** `PATCH /api/admin/maintenance-reports/[id]`: move the status, or delete the photo. */
export const maintenanceReportActionBodySchema = z.discriminatedUnion("action", [
  maintenanceReportStatusBodySchema.extend({ action: z.literal("setStatus") }),
  maintenanceReportPhotoDeleteBodySchema.extend({ action: z.literal("deletePhoto") }),
]);

// ---------------------------------------------------------------------------
// The question set
// ---------------------------------------------------------------------------

const maintenanceQuestionInputSchema = z
  .object({
    // Absent on a question being added; present on one being edited. A client
    // cannot invent an id that is not already in the set — see the PUT handler.
    id: z
      .string()
      .trim()
      .max(64)
      .optional()
      .describe("A kept question's `id` from `get_maintenance_report_questions`; omit for a new question."),
    label: z.string().trim().min(1).max(MAX_MAINTENANCE_QUESTION_LABEL_LENGTH),
    helpText: z.string().trim().max(MAX_MAINTENANCE_QUESTION_HELP_LENGTH).optional().nullable(),
    type: z.enum(["SHORT_TEXT", "LONG_TEXT", "YES_NO", "SINGLE_CHOICE"]),
    required: z.boolean(),
    choices: z
      .array(z.string().trim().min(1).max(MAX_MAINTENANCE_QUESTION_CHOICE_LENGTH))
      .max(MAX_MAINTENANCE_QUESTION_CHOICES)
      .optional()
      .default([])
      .describe("The options of a SINGLE_CHOICE question: at least two, all different. Empty for every other type."),
  })
  .strict();

/** `PUT /api/admin/maintenance-reports/questions`: the whole active set, in order. */
export const maintenanceQuestionsBodySchema = z
  .object({
    questions: z
      .array(maintenanceQuestionInputSchema)
      .max(MAX_MAINTENANCE_QUESTIONS)
      .describe(
        `The whole question set in the order asked, at most ${MAX_MAINTENANCE_QUESTIONS}. A current question left out stops being asked; its past answers are kept.`,
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// The maintenance report policy
// ---------------------------------------------------------------------------

/** `PUT /api/admin/maintenance-reports/settings`: every field, each time. */
export const maintenanceReportSettingsBodySchema = z
  .object({
    anonymousReportsEnabled: z
      .boolean()
      .describe("Whether anyone at the lodge may report through its QR sign without signing in."),
    photosEnabled: z.boolean().describe("Whether signed-in members may attach a photo."),
    anonymousPhotosEnabled: z.boolean().describe("Whether a QR-sign report may attach a photo."),
    photoRetentionDays: z
      .number()
      .int()
      .min(MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN)
      .max(MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX)
      .describe(
        `Days a photo is kept before it is deleted, ${MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MIN} to ${MAINTENANCE_REPORT_PHOTO_RETENTION_DAYS_MAX}.`,
      ),
    anonymousContactPrompt: z.boolean().describe("Whether the QR-sign form asks for a name and contact."),
  })
  .strict();

// ---------------------------------------------------------------------------
// The QR sign switch
// ---------------------------------------------------------------------------

/** The lodge a QR sign belongs to, as both the mint and the switch take it. */
export const maintenanceSignLodgeIdSchema = z.string().trim().min(1).max(64);

/** `PATCH /api/admin/maintenance-reports/tokens`: pause or resume, never mint. */
export const maintenanceSignActiveBodySchema = z
  .object({
    lodgeId: maintenanceSignLodgeIdSchema.describe(
      "The lodge whose sign is switched, as `lodgeId` from `list_maintenance_report_signs`.",
    ),
    active: z
      .boolean()
      .describe("false pauses the sign, true resumes it. A pause is not a revocation: the same sign works again when resumed."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Food-order settings
// ---------------------------------------------------------------------------

/**
 * The one format check for the food officer's address, shared by the settings
 * save and the read that decides whether ordering is set up
 * (`food-order-settings.ts` imports it from here). Checked only as an email address
 * (fork triyder/AlpineClubBookingsNZ#121 owner decision 10).
 */
export const foodOfficerEmailSchema = z.string().trim().max(FOOD_OFFICER_EMAIL_MAX_LENGTH).email();

export const foodOfficerLabelSchema = z.string().trim().min(1).max(FOOD_OFFICER_LABEL_MAX_LENGTH);

/** `PUT /api/admin/food-orders/settings`. */
export const foodOrderSettingsBodySchema = z
  .object({
    // "" clears it; anything else must be a valid address.
    officerEmail: z
      .union([z.literal(""), foodOfficerEmailSchema])
      .nullable()
      .describe("The address food orders are emailed to; an empty string or null turns ordering off."),
    officerLabel: foodOfficerLabelSchema.describe(
      `What the club calls its food officer, up to ${FOOD_OFFICER_LABEL_MAX_LENGTH} characters.`,
    ),
  })
  .strict();
