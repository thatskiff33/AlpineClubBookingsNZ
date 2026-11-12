import { z } from "zod";
import { modifyQuoteSchema, editQuotedFiguresSchema } from "@/lib/booking-modify-quote-request";
import { hostingCoverageOverrideSchema } from "@/lib/adult-member-hosting-same-owner";
import { hostingCoverageLinkedMoveSchema } from "@/lib/adult-member-hosting-linked-move";

/**
 * The request contract for `PUT /api/bookings/[id]/modify`: the preview's
 * schema, extended with the answers only a save carries (#4924). Every shared
 * field is declared once, in `modifyQuoteSchema`, so the preview and the save
 * cannot parse the same edit differently (`INV-SSOT-001`, the `INV-MOD-033`
 * class of drift). Its own module rather than beside the preview schema because
 * the hosting answers pull server-only code with them.
 */
export const batchModifySchema = modifyQuoteSchema.extend({
  memberReviewJustification: z.string().trim().min(1).max(1000).optional(),
  settlementMethod: z.enum(["card", "credit"]).optional(),
  notifyMember: z.boolean().optional(),
  // #2576 §7: the officer's explicit confirmation and mandatory reason for
  // overriding a same-owner coverage refusal. Optional in the shape because the
  // first submission never carries it — the officer is asked only when the change
  // would actually strand another booking on the account.
  hostingCoverageOverride: hostingCoverageOverrideSchema.optional(),
  // #3232: the member's answer to the linked-move offer. Absent on a first
  // submission, which is the normal case — the question is only asked when the
  // change would actually strand another booking on their own account.
  hostingCoverageLinkedMove: hostingCoverageLinkedMoveSchema.optional(),
  // #4924 (`INV-MOD-062`): the preview's figures the member approved. Optional
  // for the blue-green compatibility window: an older panel sends none.
  quotedFigures: editQuotedFiguresSchema.optional(),
});
