import { z } from "zod";

import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { BOOKING_PARTY_GUESTS_MAX, guestStayFieldsSchema } from "@/lib/booking-guest-stay-range-input";
import { parsedDateOnlySchema } from "@/lib/date-only-schema";

/**
 * `POST /api/bookings/quote`: the price of a stay before it is booked
 * (ALP-794, `INV-SSOT`). The route parses with this and the AI app preview
 * `quote_booking` offers the same fields, less the officer's on-behalf target.
 */
export const bookingQuoteRequestSchema = z.object({
  checkIn: parsedDateOnlySchema,
  checkOut: parsedDateOnlySchema,
  lodgeId: z.string().min(1).optional(),
  guests: z.array(
    z.object({
      ageTier: bookableAgeTierEnum,
      isMember: z.boolean(),
      memberId: z.string().min(1).optional(),
      // Date In and Date Out, or the night set of a multi date range stay (#713, #4199).
      ...guestStayFieldsSchema.shape,
    })
  ).min(1).max(BOOKING_PARTY_GUESTS_MAX),
  forMemberId: z.string().optional(),
});

/** `quote_booking`: the member's own quote. A connection's `forMemberId` is refused by the route. */
export const bookingQuoteConnectionRequestSchema = bookingQuoteRequestSchema.omit({ forMemberId: true });
