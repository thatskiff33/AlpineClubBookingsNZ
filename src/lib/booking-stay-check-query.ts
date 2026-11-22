import { z } from "zod";

import { parsedDateOnlySchema } from "@/lib/date-only-schema";

/**
 * The query strings of the booking wizard's three stay checks (ALP-794,
 * `INV-SSOT`). Each route parses its query with the schema here, and the AI
 * app catalogue (`src/lib/mcp/catalogue-bookings.ts`) offers the same fields, so the
 * app is never told one shape while the route enforces another.
 */

/** `GET /api/availability/check`: free beds for each night of one stay. */
export const availabilityCheckQuerySchema = z.object({
  checkIn: parsedDateOnlySchema,
  checkOut: parsedDateOnlySchema,
  lodgeId: z.string().min(1).optional(),
});

/** `GET /api/booking-policies/check`: the minimum-stay rules and cancellation schedule for a stay. */
export const bookingPolicyCheckQuerySchema = z.object({
  checkIn: parsedDateOnlySchema,
  checkOut: parsedDateOnlySchema,
  // Lodge being booked (multi-lodge phase 8): minimum-stay overrides resolve
  // per lodge. Omitted = the club's default lodge.
  lodgeId: z.string().min(1).nullish(),
});

/** `GET /api/bookings/rooms`: one lodge's rooms, or every lodge the member may book. */
export const bookingRoomsQuerySchema = z.object({
  lodgeId: z.string().min(1).optional(),
});

/**
 * The AI app's `list_lodge_rooms` always names its lodge: the no-`lodgeId`
 * mode is kept for consumers outside this repository only (`INV-INT-016`).
 */
export const bookingRoomsConnectionQuerySchema = bookingRoomsQuerySchema.required();
