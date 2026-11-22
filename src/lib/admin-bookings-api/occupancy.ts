/**
 * The request and the connection answer of `GET /api/admin/occupancy`
 * (ALP-719, `INV-MCP-006`).
 *
 * In a pure lib module because the route parses with these and the AI app
 * action catalogue offers the same fields (`INV-SSOT`): neither describes
 * them a second time. No database or server imports, so the catalogue can
 * load it.
 */
import { z } from "zod";

import { connectionShapeFor } from "@/lib/connection-projection";
import type { OccupancyMonth } from "@/lib/admin-occupancy";

/** A calendar month as the occupancy page asks for it. */
export const OCCUPANCY_MONTH_PATTERN = /^\d{4}-\d{2}$/;

export const adminOccupancyQuerySchema = z.object({
  month: z.string().regex(OCCUPANCY_MONTH_PATTERN, "month is required as YYYY-MM").describe("The calendar month, `YYYY-MM`."),
  lodgeId: z.string().min(1, "A valid lodgeId is required.").describe("The lodge, from `list_lodges`."),
});

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
