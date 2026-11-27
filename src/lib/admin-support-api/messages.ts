/**
 * The request schemas of the Support area's message routes: booking message
 * wording, email templates, the club's email settings, delivery policies,
 * officers' alert choices, delivery suppressions and failed emails (ALP-724,
 * `INV-MCP-006`).
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). No database or server
 * imports, so the catalogue can load it.
 */
import { z } from "zod";

import { normalizeEmailMessagePublicUrl } from "@/lib/email-message-public-url";

// ---------------------------------------------------------------------------
// Booking message wording
// ---------------------------------------------------------------------------

const bookingMessageKey = z
  .string()
  .trim()
  .min(1)
  .describe("The message's `key` from `list_booking_message_wording`.");

/** `PUT /api/admin/booking-messages` and its preview. The route checks the key and the wording. */
export const bookingMessageWordingSchema = z
  .object({
    messageKey: bookingMessageKey,
    bodyText: z.string().describe("The new wording. Tokens in double braces are filled in when shown."),
  })
  .strict();

/** `POST /api/admin/booking-messages/reset`. */
export const bookingMessageResetSchema = z.object({ messageKey: bookingMessageKey }).strict();

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

const templateName = z
  .string()
  .trim()
  .min(1)
  .describe("The template's `key` from `list_email_templates`.");

/**
 * `GET /api/admin/email-templates`. With `templateName` the route answers
 * that one template, whole; without it, every template.
 */
export const emailTemplatesQuerySchema = z.object({ templateName: templateName.optional() });

/** As `emailTemplatesQuerySchema`, the template required: one template's whole wording. */
export const emailTemplateQuerySchema = emailTemplatesQuerySchema.required();

/**
 * `PUT /api/admin/email-templates`. A rich `bodyHtml` is sanitised before
 * storage and `bodyText` derived from it; a save with `bodyText` and no
 * `bodyHtml` clears any stored rich body, so the text is authoritative.
 */
export const emailTemplateUpdateSchema = z
  .object({
    templateName,
    subject: z.string().trim().max(500).nullable().optional().describe("The subject. Null or empty uses the default."),
    bodyText: z
      .string()
      .trim()
      .max(10000)
      .nullable()
      .optional()
      .describe("The plain-text body. Null or empty uses the default. Clears any formatted body."),
    bodyHtml: z
      .string()
      .trim()
      .max(20000)
      .nullable()
      .optional()
      .describe("A formatted (HTML) body, sanitised before it is stored; its text becomes `bodyText`."),
  })
  .strict()
  .refine(
    (value) => value.subject !== undefined || value.bodyText !== undefined || value.bodyHtml !== undefined,
    "A subject, bodyText or bodyHtml update is required",
  );

/** `POST /api/admin/email-templates/preview`: renders with sample data, saves nothing. */
export const emailTemplatePreviewSchema = z
  .object({
    templateName,
    subject: z.string().trim().min(1).max(500),
    bodyText: z.string().trim().min(1).max(10000).optional(),
    bodyHtml: z.string().trim().max(20000).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.bodyText) || Boolean(value.bodyHtml), "A bodyText or bodyHtml is required");

/** `POST /api/admin/email-templates/reset`. */
export const emailTemplateResetSchema = z.object({ templateName });

// ---------------------------------------------------------------------------
// The club's email settings
// ---------------------------------------------------------------------------

/** `PUT /api/admin/email-settings`. Each field left out is unchanged; null clears it to the default. */
export const emailMessageSettingsUpdateSchema = z
  .object({
    clubName: z.string().trim().min(1).max(200).nullable().optional(),
    bookingsName: z.string().trim().min(1).max(200).nullable().optional(),
    emailFromName: z.string().trim().min(1).max(200).nullable().optional(),
    supportEmail: z.string().trim().email().max(320).nullable().optional(),
    contactEmail: z.string().trim().email().max(320).nullable().optional(),
    publicUrl: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine((value) => normalizeEmailMessagePublicUrl(value) !== null, {
        message: "Public URL must use http or https",
      })
      .transform((value) => normalizeEmailMessagePublicUrl(value)!)
      .nullable()
      .optional(),
  })
  .strict();

/**
 * `PUT /api/admin/email-settings` from an AI app connection: every field but
 * `publicUrl`, which the sign-in and password-reset links point to and so
 * stays on the website (`sign-in-access`, ALP-724). The route refuses it.
 */
export const emailMessageSettingsConnectionUpdateSchema = emailMessageSettingsUpdateSchema.omit({ publicUrl: true });

// ---------------------------------------------------------------------------
// Delivery policies and officers' alerts
// ---------------------------------------------------------------------------

/** `PUT /api/admin/notification-delivery-policies`. */
export const notificationDeliveryPolicyUpdateSchema = z
  .object({
    templateName: z
      .string()
      .trim()
      .min(1)
      .describe("An officer or system template's `templateName` from `list_notification_delivery_policies`."),
    mode: z
      .enum(["always", "content_only", "disabled"])
      .describe("`always` sends every time, `content_only` only when there is something to report, `disabled` never."),
  })
  .strict();

/** The officer alerts one officer may switch on or off, each optional. */
export const adminNotificationPreferenceUpdateSchema = z
  .object({
    adminNewBooking: z.boolean().optional(),
    adminPaymentFailure: z.boolean().optional(),
    adminPendingDeadline: z.boolean().optional(),
    adminBookingBumped: z.boolean().optional(),
    adminXeroSyncError: z.boolean().optional(),
    adminCapacityWarning: z.boolean().optional(),
    adminDailyDigest: z.boolean().optional(),
    adminWaitlistOffer: z.boolean().optional(),
    adminFamilyGroupRequest: z.boolean().optional(),
    adminBookingChangeRequest: z.boolean().optional(),
    adminRefundRequest: z.boolean().optional(),
    adminIssueReport: z.boolean().optional(),
    adminBookingRequest: z.boolean().optional(),
    adminBookingReviewRequired: z.boolean().optional(),
    adminMemberDeleteRequest: z.boolean().optional(),
    adminMaintenanceReport: z.boolean().optional(),
    adminServerVersion: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    "At least one preference update is required",
  );

/** `PUT /api/admin/notifications`: one officer's alert choices. */
export const adminNotificationPreferencesUpdateSchema = z.object({
  memberId: z.string().min(1).describe("The officer's member id."),
  preferences: adminNotificationPreferenceUpdateSchema.describe(
    "The alerts to switch on (true) or off (false); each left out is unchanged. Only alerts for areas the officer can edit are accepted.",
  ),
});

// ---------------------------------------------------------------------------
// Delivery suppressions and failed emails
// ---------------------------------------------------------------------------

/** `POST /api/admin/email-suppressions/[id]/clear`; the body may be left out. */
export const emailSuppressionClearSchema = z.object({
  reason: z.string().max(500).optional().describe("Why the address may be emailed again, kept in the audit log."),
});

/** `POST /api/admin/email-failures/[id]/review`; the body may be left out. */
export const emailFailureReviewSchema = z.object({
  reason: z.string().max(500).optional().describe("Why no retry is needed, kept on the failure."),
});
