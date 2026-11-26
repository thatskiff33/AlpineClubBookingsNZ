/**
 * The admin Reports window (`GET /api/admin/reports`): the route and its AI
 * app action read it (ALP-721, `INV-SSOT`). Both days are inclusive club
 * days, `YYYY-MM-DD`.
 */
import { z } from "zod";

import { BOOKING_DELETED_VISIBILITY_VALUES } from "@/lib/booking-delete-visibility";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

export const adminReportQuerySchema = z.object({
  from: dateOnlyStringSchema,
  to: dateOnlyStringSchema,
  deleted: z.enum(BOOKING_DELETED_VISIBILITY_VALUES).default("hide"),
  // Reporting lodge scope: omitted = all active lodges (occupancy denominator
  // is the summed active-lodge capacity); a value scopes to that lodge.
  lodgeId: z.string().min(1).optional(),
});
