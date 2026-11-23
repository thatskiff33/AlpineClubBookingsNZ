/**
 * What an officer sends to the subscription billing panel
 * (`/api/admin/subscription-billing`): the preview's query, and one schema per
 * action the panel's `POST` takes, joined on `action`. The route parses with
 * the union; each AI app action offers one variant's fields, with its
 * `action` fixed by the catalogue (ALP-721, `INV-SSOT`). Changing the
 * club-level billing settings (`UPDATE_SETTINGS`) is not offered to an app.
 */
import type { FamilyBillingMode } from "@prisma/client";
import { z } from "zod";

import { CLOSE_ALREADY_PAID_REASON_MAX } from "@/lib/subscription-charge-already-paid";
import { seasonYearQuerySchema, seasonYearSchema } from "@/lib/season-year-range";

/** The longest note an officer may leave when marking a family invoiced. */
export const FAMILY_INVOICED_NOTE_MAX = 500;

/** How a family's subscriptions are invoiced, club-wide (#159). */
export const FAMILY_BILLING_MODES = [
  "BILL_FAMILY_VIA_BILLING_MEMBER",
  "BILL_MEMBERS_INDIVIDUALLY",
] as const satisfies readonly FamilyBillingMode[];

export const subscriptionBillingQuerySchema = z.object({
  seasonYear: seasonYearQuerySchema.optional(),
  decisionDate: z.string().optional(),
});

export const confirmAnnualBatchFields = {
  seasonYear: seasonYearSchema,
  decisionDate: z.string(),
  confirmationToken: z.string().length(64),
  confirmed: z.literal(true),
};

export const retryChargeFields = { chargeId: z.string().min(1) };

// #4098: close a charge in CONFLICT because every subscription it covers is
// already PAID. Finance edit (the POST guard); the reason is required.
export const closeAlreadyPaidFields = {
  chargeId: z.string().min(1),
  reason: z.string().trim().min(1).max(CLOSE_ALREADY_PAID_REASON_MAX),
};

// #2148 (D2): edit-gated preview refresh. Reconciles stale persisted
// exceptions (auto-resolves any OPEN row the fresh whole-club preview no
// longer regenerates) and returns the refreshed billing data. The read-only
// GET never mutates; this action is the documented way stale rows clear.
export const refreshPreviewFields = {
  seasonYear: seasonYearSchema,
  decisionDate: z.string(),
};

const updateSettingsFields = {
  invoiceDueDays: z.number().int().min(1).max(365),
  // Optional so the existing due-days save path stays a single-field write;
  // when present it switches the club-level family billing model.
  familyBillingMode: z.enum(FAMILY_BILLING_MODES).optional(),
};

// #2161 (D2): operator "already invoiced" family marker. MARK creates an active
// marker; UNMARK sets releasedAt (row retained for audit). Both finance:edit
// gated (the POST guard) and idempotent.
export const markFamilyInvoicedFields = {
  seasonYear: seasonYearSchema,
  familyGroupId: z.string().min(1),
  note: z.string().max(FAMILY_INVOICED_NOTE_MAX).optional(),
};

export const unmarkFamilyInvoicedFields = {
  seasonYear: seasonYearSchema,
  familyGroupId: z.string().min(1),
};

export const subscriptionBillingMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("CONFIRM_ANNUAL_BATCH"), ...confirmAnnualBatchFields }).strict(),
  z.object({ action: z.literal("RETRY_CHARGE"), ...retryChargeFields }).strict(),
  z.object({ action: z.literal("CLOSE_ALREADY_PAID"), ...closeAlreadyPaidFields }).strict(),
  z.object({ action: z.literal("REFRESH_PREVIEW"), ...refreshPreviewFields }).strict(),
  z.object({ action: z.literal("UPDATE_SETTINGS"), ...updateSettingsFields }).strict(),
  z.object({ action: z.literal("MARK_FAMILY_INVOICED"), ...markFamilyInvoicedFields }).strict(),
  z.object({ action: z.literal("UNMARK_FAMILY_INVOICED"), ...unmarkFamilyInvoicedFields }).strict(),
]);
