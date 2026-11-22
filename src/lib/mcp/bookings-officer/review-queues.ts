/**
 * Review queues and booking reads: change and exception requests, booking
 * reviews, the waitlist, occupancy and promo codes. Part of the Bookings &
 * Beds officer actions (ALP-719): see `index.ts`.
 */
import {
  ADMIN_OCCUPANCY_CONNECTION_SHAPE,
  adminOccupancyQuerySchema,
} from "@/lib/admin-bookings-api/occupancy";

import type { McpAction } from "../catalogue";

export const REVIEW_QUEUE_ACTIONS: readonly McpAction[] = [
  {
    id: "get_lodge_occupancy",
    title: "Read a lodge's occupancy for a month",
    summary:
      "Officer: how many guests stay at one lodge on each night of one calendar month, and the bookings behind them (reference, owner, dates, guest count, status).",
    method: "GET",
    path: "/api/admin/occupancy",
    query: adminOccupancyQuerySchema,
    kind: "read",
    returns: ADMIN_OCCUPANCY_CONNECTION_SHAPE,
    core: false,
  },
];
