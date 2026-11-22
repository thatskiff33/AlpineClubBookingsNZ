import { z } from "zod";

/**
 * `POST /api/bookings/[id]/refund-request`: a member asking the club to review
 * the refund on a cancelled booking (ALP-794, `INV-SSOT`). The route parses
 * with this and the AI app action `request_refund_review` offers the same
 * fields. An appeal moves no money: an officer decides it.
 */
export const refundAppealRequestSchema = z.object({
  reason: z.string().min(10).max(2000),
  requestedAmountCents: z.number().int().min(1).optional(),
});
