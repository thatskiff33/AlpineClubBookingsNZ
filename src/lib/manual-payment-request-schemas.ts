/**
 * What an officer sends to record, or reverse, a payment taken by hand: a
 * member subscription (`POST /api/admin/subscriptions/[id]/manual-payment`)
 * and a booking paid in cash or by an off-Xero bank transfer (`POST
 * /api/admin/bookings/[id]/mark-paid`). The routes, and the subscription
 * route's AI app action, read these (ALP-721, `INV-SSOT`); marking a booking
 * paid is website-only (#5305 comment 7131138226, item 1). Amounts are
 * integer cents; neither route takes a settlement amount, only the figure the
 * officer was shown, which the route checks against its own.
 */
import { z } from "zod";

import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";

/** What both bodies carry: the direction, the officer's note, confirmation and the email decision. */
const manualPaymentDecisionFields = {
  direction: z.enum(["paid", "unpaid"]),
  note: z.string().max(MANUAL_PAYMENT_NOTE_MAX).optional().nullable(),
  // Explicit confirmation so a manual money-state change is never a
  // single-click accident.
  confirmed: z.literal(true),
  // #2260: the admin's "email the member or not" decision. Shape-checked
  // here, contract-checked in each route — see their 422 branches.
  notifyMember: z.boolean().optional(),
};

export const manualSubscriptionPaymentBodySchema = z.object(manualPaymentDecisionFields).strict();

export const manualBookingPaymentBodySchema = z
  .object({
    ...manualPaymentDecisionFields,
    // The amount owing the dialog showed. NOT the settlement amount — that is
    // recomputed under the locks — but a mismatch means the price or the
    // applied credit moved, so the settle is refused rather than recorded at a
    // figure the admin never agreed to.
    expectedAmountCents: z.number().int().optional(),
    // #2397: the admin's answer to "does this cash cover the outstanding
    // extra?", sent ONLY when the dialog showed one. Absent means "the dialog
    // showed no extra" — a claim the settle re-checks under its locks, not a
    // default — so the common no-extra screen keeps its exact request shape.
    additionalCoverage: z
      .object({
        covered: z.boolean(),
        // The figure the dialog showed. Not the settled amount — that is
        // re-derived under the locks — but a mismatch means the extra moved
        // since the dialog rendered, so the settle is refused.
        expectedAdditionalAmountCents: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
