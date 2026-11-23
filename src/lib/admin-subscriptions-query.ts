/**
 * The member subscriptions list's filters (`GET /api/admin/subscriptions`):
 * the route and its AI app action read them (ALP-721, `INV-SSOT`).
 */
import { z } from "zod";

import { adminListPageQueryFields } from "@/lib/admin-list-page";
import { seasonYearQuerySchema } from "@/lib/season-year-range";

/** A row's status as the list shows it: `NOT_REQUIRED` is worked out, not stored. */
export const ADMIN_SUBSCRIPTION_LIST_STATUSES = [
  "PAID",
  "UNPAID",
  "OVERDUE",
  "NOT_INVOICED",
  "NOT_REQUIRED",
] as const;
const ADMIN_SUBSCRIPTION_STATUS_FILTER_VALUES = [...ADMIN_SUBSCRIPTION_LIST_STATUSES, "all"] as const;

export const adminSubscriptionSortBySchema = z
  .enum([
    "member",
    "email",
    "ageTier",
    "xeroContactGroup",
    "status",
    "xeroInvoice",
    "paidAt",
  ])
  .optional()
  .default("member");

export const adminSubscriptionsQuerySchema = z.object({
  seasonYear: seasonYearQuerySchema.optional(),
  status: z.enum(ADMIN_SUBSCRIPTION_STATUS_FILTER_VALUES).optional().default("all"),
  ageTier: z.enum(["INFANT", "CHILD", "YOUTH", "ADULT", "all"]).optional().default("all"),
  xeroContactGroup: z.string().trim().min(1).max(100).optional(),
  sortBy: adminSubscriptionSortBySchema,
  sortDir: z.enum(["asc", "desc"]).optional().default("asc"),
  ...adminListPageQueryFields,
});
