/**
 * The payments list's filters other than the amount boxes (`GET
 * /api/admin/payments`). The amount boxes take dollars as typed and are
 * parsed to cents by `admin-payments-service.ts`, the money module, which
 * spreads these in beside them. The AI app action (ALP-721) offers these
 * only, so every amount an app sends or reads is integer cents (`INV-SSOT`).
 * Pure: no database.
 */
import { z } from "zod";

import { adminListPageQueryFields } from "@/lib/admin-list-page";
import { paymentApiSourceFilters, settlementFilters, xeroStateFilters } from "@/lib/admin-operational-state";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

const sortBySchema = z
  .enum([
    "lastUpdated",
    "checkIn",
    "member",
    "booking",
    "amount",
    "status",
    "stripe",
    "xeroInvoice",
    "settlement",
  ])
  .optional()
  .default("lastUpdated");

export const adminPaymentsFilterFields = {
  status: z.enum(["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED", "all"]).optional().default("all"),
  source: z.enum(paymentApiSourceFilters).optional().default("all"),
  xeroState: z.enum(xeroStateFilters).optional().default("all"),
  settlement: z.enum(settlementFilters).optional().default("all"),
  from: dateOnlyStringSchema.optional(),
  to: dateOnlyStringSchema.optional(),
  lastUpdatedFrom: dateOnlyStringSchema.optional(),
  lastUpdatedTo: dateOnlyStringSchema.optional(),
  checkInFrom: dateOnlyStringSchema.optional(),
  checkInTo: dateOnlyStringSchema.optional(),
  search: z.string().trim().max(100).optional(),
  sortBy: sortBySchema,
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
  ...adminListPageQueryFields,
};
