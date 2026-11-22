/**
 * What an officer sends to request, and to decide, a manual account credit
 * adjustment (`POST` and `PATCH` under `/api/admin/members/[id]/credits`).
 * The routes and their AI app actions read these (ALP-721, `INV-SSOT`).
 * Amounts are integer cents.
 */
import { z } from "zod";

export const adminCreditAdjustmentRequestSchema = z
  .object({
    amountCents: z.number().int().refine((v) => v !== 0, "Amount cannot be zero"),
    description: z.string().min(1, "Description is required").max(500),
    idempotencyKey: z.string().uuid("Idempotency key must be a UUID"),
    grantAccount: z.enum(["MEMBER_OWN_MONEY", "GOODWILL"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.amountCents > 0 && !value.grantAccount) {
      ctx.addIssue({
        code: "custom",
        path: ["grantAccount"],
        message: "Choose which account this credit belongs to.",
      });
    }
    if (value.amountCents < 0 && value.grantAccount) {
      ctx.addIssue({
        code: "custom",
        path: ["grantAccount"],
        message: "A deduction does not choose a Xero account.",
      });
    }
  });

export const adminCreditAdjustmentReviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
});

/** `[id]` is the member, `[requestId]` the adjustment request. */
export const adminCreditAdjustmentReviewParamsSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1),
});
