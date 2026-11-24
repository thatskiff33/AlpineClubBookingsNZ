/**
 * The `[id]` path segment of a Bookings & Beds admin route that names a
 * record other than a booking (a booking request, room, bed, season, promo
 * code…), as the AI app action catalogue offers it (ALP-719). A booking's
 * own id uses `bookingIdParamsSchema`. The dispatcher also holds every path
 * argument to a plain record id before it is sent.
 */
export { routeIdParamsSchema as adminRecordIdParamsSchema } from "@/lib/route-id-params";
