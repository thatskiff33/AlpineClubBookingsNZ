// The body an officer sends to approve or decline a refund request, moved
// verbatim from `src/app/api/admin/refund-requests/[id]/route.ts` so the route
// shrinks below its length on main (#4926: past the hard ceiling a file may only
// stay or shrink). The route parses with it exactly as before.
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
