/**
 * The Bookings & Beds officer actions (ALP-719, `INV-MCP-006`): every
 * `/api/admin/**` route method the `bookings` admin area guards, except the
 * fresh-proof ones, which stay on the website.
 *
 * Each is offered only to someone holding `bookings` at the level its route
 * needs (`mcpCallerMayUse`), and its route decides with the officer's own
 * permissions, as on the admin screens. Request schemas and answer shapes
 * come from `src/lib/admin-bookings-api/`, which the routes import too.
 *
 * Grouped by the admin screens they serve, one module each.
 */
import type { McpAction } from "../catalogue";

import { BED_ALLOCATION_ACTIONS } from "./bed-allocation";
import { BOOKING_REQUEST_ACTIONS } from "./booking-requests";
import { BOOKING_SETUP_ACTIONS } from "./booking-setup";
import { BOOKING_ACTIONS } from "./bookings";
import { REVIEW_QUEUE_ACTIONS } from "./review-queues";

export const BOOKINGS_OFFICER_ACTIONS: readonly McpAction[] = [
  ...BOOKING_ACTIONS,
  ...BOOKING_REQUEST_ACTIONS,
  ...REVIEW_QUEUE_ACTIONS,
  ...BED_ALLOCATION_ACTIONS,
  ...BOOKING_SETUP_ACTIONS,
];
