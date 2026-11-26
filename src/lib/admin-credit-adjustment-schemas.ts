/**
 * What an officer sends to request, and to decide, a manual account credit
 * adjustment (`POST` and `PATCH` under `/api/admin/members/[id]/credits`),
 * and to list the requests waiting for review (`GET /api/admin/credit-approvals`).
 * The routes and their AI app actions read these (ALP-721, `INV-SSOT`).
 * Amounts are integer cents.
 */
import { z } from "zod";

import { ADMIN_CREDIT_GRANT_ACCOUNTS } from "@/lib/admin-credit-grant-account";

export const adminCreditAdjustmentRequestSchema = z
  .object({
    amountCents: z.number().int().refine((v) => v !== 0, "Amount cannot be zero"),
    description: z.string().min(1, "Description is required").max(500),
    idempotencyKey: z.string().uuid("Idempotency key must be a UUID"),
    grantAccount: z.enum(ADMIN_CREDIT_GRANT_ACCOUNTS).optional(),
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

/** The review queue's filter (`GET /api/admin/credit-approvals`). */
const ADMIN_CREDIT_APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "ALL"] as const;

/**
 * `status` is read case-insensitively and anything else, or nothing, lists the
 * pending requests: the queue never refuses a filter it does not know.
 */
export const adminCreditApprovalsQuerySchema = z.object({
  status: z
    .preprocess(
      (value) => (typeof value === "string" ? value.toUpperCase() : value),
      z.enum(ADMIN_CREDIT_APPROVAL_STATUSES).catch("PENDING"),
    )
    .default("PENDING"),
});
