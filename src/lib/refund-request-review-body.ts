// The review body for `PUT /api/admin/refund-requests/[id]`, moved verbatim
// from that route to keep it under its size ceiling (#5145).
import { z } from "zod";

export const reviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  adminNotes: z.string().max(2000).optional(),
  approvedAmountCents: z.number().int().min(0).optional(),
  // #1792: admin per-action email choice. Absent/undefined = notify (default);
  // false = suppress the member outcome email. A non-boolean is rejected 400 by
  // this parse. Only affects the outcome notice — refund execution, ledger math,
  // and Stripe/Xero are unchanged.
  notifyMember: z.boolean().optional(),
});
