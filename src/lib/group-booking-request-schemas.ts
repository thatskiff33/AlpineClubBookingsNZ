import { GroupBookingPaymentMode, type GroupBookingStatus } from "@prisma/client";
import { z } from "zod";

import { parsedDateOnlySchema } from "@/lib/date-only-schema";

/**
 * The requests a group booking's organiser sends (`POST /api/group-bookings`
 * and `PATCH /api/group-bookings/[code]`), in a lib module so the routes and
 * the AI app action catalogue read one description of each (ALP-797,
 * `INV-SSOT`). Zod only, plus a Prisma enum.
 */

/** Open a group on one of the caller's own bookings. */
export const createGroupBookingSchema = z
  .object({
    organiserBookingId: z.string().min(1),
    paymentMode: z.nativeEnum(GroupBookingPaymentMode),
    // Optional date-only deadline after which no new joins are accepted.
    joinDeadline: parsedDateOnlySchema.optional().nullable(),
    maxJoiners: z.number().int().min(1).max(200).optional().nullable(),
  })
  .strict();

/** Close the group to new joins, or reopen it. Existing joiners are untouched. */
export const groupBookingJoinStatusSchema = z
  .object({ action: z.enum(["close", "reopen"]) })
  .strict();

/**
 * The `[code]` segment: the join code as the organiser hands it out. Case and
 * hyphens are normalised by the service (`normaliseJoinCode`); a code that
 * fails this schema answers Not Found, as an unknown code does.
 */
export const groupBookingCodeParamsSchema = z.object({
  code: z.string().min(1).max(64),
});

/** What `POST /api/group-bookings` answers with when the group is opened. */
export interface GroupBookingCreatedResponse {
  id: string;
  joinCode: string;
  paymentMode: GroupBookingPaymentMode;
  status: GroupBookingStatus;
  joinDeadline: string | null;
  maxJoiners: number | null;
}
