/**
 * The body of `POST /api/maintenance-reports`, the signed-in maintenance-report
 * door (#2780), shared with the AI app action `report_maintenance_issue`
 * (ALP-796, `INV-SSOT`).
 *
 * Client-safe: zod and the two limits modules only, no Prisma.
 */
import { z } from "zod";

import {
  MAX_MAINTENANCE_QUESTIONS,
  MAX_MAINTENANCE_SUMMARY_LENGTH,
} from "@/lib/maintenance-report-limits";
import { MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH } from "@/lib/maintenance-report-photo";

const memberMaintenanceReportFields = {
  lodgeId: z.string().trim().min(1).max(64),
  summary: z.string().trim().min(1).max(MAX_MAINTENANCE_SUMMARY_LENGTH),
  answers: z
    .array(
      z.object({
        questionId: z.string().trim().min(1).max(64),
        // Bounded here only so an oversized payload is refused before the
        // service walks it; the real per-type limits live in the service, which
        // is the half both doors share.
        value: z.string().max(4000),
      }),
    )
    .max(MAX_MAINTENANCE_QUESTIONS)
    .optional()
    .default([]),
};

export const memberMaintenanceReportSchema = z
  .object({
    ...memberMaintenanceReportFields,
    photoDataUrl: z
      .string()
      .max(MAX_MAINTENANCE_PHOTO_DATA_URL_LENGTH)
      .optional()
      .nullable(),
  })
  .strict();

/**
 * What an AI app connection may send: the report without a photo, which is a
 * file chosen in the member's browser. Strict, so a connection that sends one
 * is refused rather than having it quietly dropped.
 */
export const memberMaintenanceReportConnectionSchema = z
  .object(memberMaintenanceReportFields)
  .strict();
