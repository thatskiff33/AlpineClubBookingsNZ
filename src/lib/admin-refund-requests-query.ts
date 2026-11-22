/**
 * The refund appeal queue's filters (`GET /api/admin/refund-requests`): the
 * route and its AI app action read them (ALP-721, `INV-SSOT`).
 */
import { z } from "zod";

import { adminListPageQueryFields } from "@/lib/admin-list-page";

export const adminRefundRequestsQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).optional().default("PENDING"),
  ...adminListPageQueryFields,
});
