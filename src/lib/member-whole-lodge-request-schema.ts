import { z } from "zod";

import { parsedDateOnlySchema } from "@/lib/date-only-schema";

/**
 * The body of a member's "Book the whole lodge" request
 * (`POST /api/booking-requests/whole-lodge`, #2263), in a lib module so the
 * route and the AI app action catalogue read one description of it (ALP-797,
 * `INV-SSOT`). Client-safe: zod only.
 */

const noCrlf = (value: string) => !/[\r\n]/.test(value);

export const memberWholeLodgeRequestSchema = z.object({
  checkIn: parsedDateOnlySchema,
  checkOut: parsedDateOnlySchema,
  // Approximate party size. Bounded against the lodge's configured capacity
  // by the service; there is no availability check of any kind.
  headcount: z.number().int().min(1).max(500),
  // Who the group is, in the member's words. No guest names are collected (D5).
  groupDescription: z
    .string()
    .min(1, "Tell us who the group is")
    .max(500)
    .refine(noCrlf, "This cannot contain line breaks"),
  notes: z
    .string()
    .max(400)
    .refine(noCrlf, "Notes cannot contain line breaks")
    .optional()
    .nullable(),
  // "Put my account credit towards this booking if it is approved." A yes/no,
  // never an amount: the price is set by the officer at approval, and the
  // approval applies min(balance, price). Derived from the member's own choice,
  // so it reveals nothing about the calendar.
  applyAccountCredit: z.boolean().optional(),
  // The control is visually hidden for one lodge, but the client still sends
  // that sole explicit identity. Unknown scope must never become the default.
  lodgeId: z.string().min(1),
});

/** The `[id]` segment of `/api/booking-requests/whole-lodge/[id]/withdraw`. */
export { routeIdParamsSchema as wholeLodgeRequestIdParamsSchema } from "@/lib/route-id-params";
