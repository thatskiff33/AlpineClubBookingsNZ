import { z } from "zod";

import { hostingCoverageOverrideSchema } from "@/lib/adult-member-hosting-same-owner";

/**
 * The body of `POST /api/bookings/[id]/cancel`.
 *
 * In a lib module rather than the route file because the AI app action
 * catalogue (`src/lib/mcp/catalogue.ts`) offers the member's part of it,
 * `refundMethod`, and must not describe that field a second time (ALP-653,
 * `INV-SSOT`). The route stays the authority on who may send the other two.
 */
export const cancelBookingMutationSchema = z.object({
  refundMethod: z.enum(["card", "credit"]),
  // Issue #1705: per-action member-email choice for admin cancellations, same
  // semantics as the modify routes (#1696): booking-management ADMIN only,
  // absent means notify.
  notifyMember: z.boolean().optional(),
  // #2576 §7: the officer's explicit confirmation and mandatory reason for
  // overriding a same-owner coverage refusal. Optional in the shape because the
  // first submission never carries it — the officer is asked only when the cancel
  // would actually strand another booking on the account.
  hostingCoverageOverride: hostingCoverageOverrideSchema.optional(),
});

/**
 * The `[id]` segment of the booking routes (`/api/bookings/[id]` and the
 * routes under it), shared with the catalogue for the same reason.
 */
export { routeIdParamsSchema as bookingIdParamsSchema } from "@/lib/route-id-params";
