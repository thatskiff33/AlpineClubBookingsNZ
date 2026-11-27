import { z } from "zod";

import { ARRIVAL_TIME_ERROR_MESSAGE, ARRIVAL_TIME_PATTERN } from "@/lib/arrival-time";
import { htmlToPlainText } from "@/lib/email-text";

/**
 * The request bodies of the small edits on a booking's page: the member's
 * note, the expected arrival time and the requested room (ALP-794,
 * `INV-SSOT`). Each route parses with the schema here, and the AI app
 * catalogue offers the same fields.
 */

/** `PUT /api/bookings/[id]/notes`. Markup is stripped; an empty note clears it. */
export const bookingNotesUpdateSchema = z.object({
  notes: z
    .string()
    .max(500, "Notes must be 500 characters or fewer")
    .transform((val) => htmlToPlainText(val).trim()),
});

/**
 * `PUT /api/bookings/[id]/arrival-time`. #2621: the accepted-value rule is
 * `ARRIVAL_TIME_PATTERN`, imported rather than re-spelled, so the message
 * and the rule cannot disagree.
 */
export const arrivalTimeUpdateSchema = z.object({
  expectedArrivalTime: z.string().regex(ARRIVAL_TIME_PATTERN, ARRIVAL_TIME_ERROR_MESSAGE),
});

/** `PUT /api/bookings/[id]/requested-room`. Clearing the request is the `DELETE`. */
export const requestedRoomUpdateSchema = z
  .object({ requestedRoomId: z.string().min(1) })
  .strict();
