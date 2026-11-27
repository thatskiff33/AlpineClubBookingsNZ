/**
 * The query schemas of the Bookings & Beds review queues (ALP-719,
 * `INV-MCP-006`): locked-period change requests, booking-policy exception
 * requests, booking reviews and the waitlist.
 *
 * In a pure lib module because each route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). Zod and client-safe
 * helpers only: no database or server imports, so the catalogue can load it.
 */
import { z } from "zod";

import { adminListPageQueryFields, adminQueueFocusIdField } from "@/lib/admin-list-page";
import {
  DEFAULT_EXCEPTION_QUEUE_STATUS_FILTER,
  EXCEPTION_QUEUE_STATUS_FILTERS,
} from "@/lib/booking-exception-request-shared";
import { dateOnlyStringSchema } from "@/lib/date-only-schema";

/** `GET /api/admin/booking-change-requests`: the locked-period change queue. */
export const adminBookingChangeRequestQueueQuerySchema = z.object({
  status: z
    .enum(["REQUESTED", "APPROVED", "REJECTED", "ALL"])
    .optional()
    .default("REQUESTED")
    .describe("Which requests: `REQUESTED` (the default: waiting for a decision, oldest first), `APPROVED`, `REJECTED` or `ALL`."),
  ...adminListPageQueryFields,
  requestId: adminQueueFocusIdField.describe("One request's id, to read just that request."),
});

/**
 * `GET /api/admin/booking-exception-requests`: the unified policy-exception
 * queue. The values are `EXCEPTION_QUEUE_STATUS_FILTERS`, the same list the
 * queue reader's type and the officer screen's filter buttons come from
 * (#5247), so the route can never reject a filter the screen offers.
 */
export const adminBookingExceptionRequestQueueQuerySchema = z.object({
  status: z
    .enum(EXCEPTION_QUEUE_STATUS_FILTERS)
    .optional()
    .default(DEFAULT_EXCEPTION_QUEUE_STATUS_FILTER)
    .describe(
      "Which requests: `REQUESTED` (the default: waiting for a decision, oldest first), `APPROVED`, `REJECTED`, `CANCELLED`, `SUPERSEDED`, `EXPIRED` (the provisional hold ran out) or `ALL`. Every filter but `REQUESTED` lists newest first.",
    ),
  ...adminListPageQueryFields,
});

/** `GET /api/admin/booking-reviews`: bookings held for an officer's review. */
export const adminBookingReviewQueueQuerySchema = z.object({
  status: z
    .enum(["PENDING", "APPROVED", "REJECTED", "ALL"])
    .optional()
    .default("PENDING")
    .describe("Which reviews: `PENDING` (the default: waiting, oldest first), `APPROVED`, `REJECTED` or `ALL` (pending first)."),
  ...adminListPageQueryFields,
  // A focused deep link (`?bookingId=`) reads its one booking, inside the same
  // review scope, so the panel can pin it when it is not on the page
  // (INV-OPS-020).
  bookingId: adminQueueFocusIdField.describe("One booking's id, to read just that booking if it is in the review queue."),
});

/**
 * `GET /api/admin/waitlist`. The route refines these fields further (each
 * date a real day, the window at most the finance metrics window), with a
 * server-side rule; the catalogue offers the fields and the route remains the
 * authority for the window.
 */
export const adminWaitlistQuerySchema = z.object({
  from: dateOnlyStringSchema.optional().describe("Only entries arriving on or after this date, `YYYY-MM-DD`."),
  to: dateOnlyStringSchema.optional().describe("Only entries leaving on or before this date, `YYYY-MM-DD`."),
  ...adminListPageQueryFields,
});
