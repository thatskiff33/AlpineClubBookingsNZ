/**
 * What the Bookings & Beds review-queue officer actions return (ALP-719,
 * `INV-MCP-006`): change and exception requests, booking reviews, the
 * waitlist, occupancy and promo codes. The catalogue entry and the route's
 * `connectionJson` both read these (`INV-SSOT`).
 *
 * Types only from the route modules: nothing here reaches the database.
 */
import type { OccupancyMonth } from "@/lib/admin-occupancy";
import { connectionShapeFor } from "@/lib/connection-projection";

const OCCUPANCY_BOOKING_SHAPE = {
  id: true,
  reference: true,
  ownerName: true,
  checkIn: true,
  checkOut: true,
  guestCount: true,
  status: true,
} as const;

export const ADMIN_OCCUPANCY_CONNECTION_SHAPE = connectionShapeFor<OccupancyMonth>({
  month: true,
  startDate: true,
  endDate: true,
  nights: { date: true, guestCount: true, bookings: OCCUPANCY_BOOKING_SHAPE },
  bookings: OCCUPANCY_BOOKING_SHAPE,
});
