import { z } from "zod";

import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import {
  GUEST_CHANGE_LIST_BOUND,
  guestStayFieldsSchema,
} from "@/lib/booking-guest-stay-range-input";
import { parsedDateOnlySchema } from "@/lib/date-only-schema";
import { nameField } from "@/lib/zod-helpers";

/**
 * The fields every new booking request carries, whoever is making it: the
 * stay, the party, the lodge and a note (ALP-653, `INV-SSOT`).
 *
 * `POST /api/bookings` spreads this shape into its request schema and adds the
 * payment, promo, waitlist and officer-only fields beside it. The AI app
 * action catalogue (`src/lib/mcp/catalogue.ts`) offers exactly these fields
 * for a draft booking. One declaration, so the two cannot describe a guest
 * differently; the route stays the authority on what any of it means.
 */
export const bookingCreateCoreShape = {
  checkIn: parsedDateOnlySchema,
  checkOut: parsedDateOnlySchema,
  guests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
        // Date In and Date Out, or the night set (#713), which may be
        // non-contiguous; the booking range auto-expands to cover them (#4199).
        ...guestStayFieldsSchema.shape,
      })
    )
    .min(1)
    .max(...GUEST_CHANGE_LIST_BOUND),
  notes: z.string().max(500).optional(),
  // Lodge the booking is for (multi-lodge phase 8). Optional at schema-parse
  // time only, so the route can return its own BOOKING_LODGE_REQUIRED 400;
  // every create must name a lodge and omission never defaults one.
  lodgeId: z.string().min(1).optional(),
} as const;
