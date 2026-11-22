/**
 * What an officer sends to answer a voided bank-transfer refund note the
 * nightly follow-up could not match (`POST
 * /api/admin/payments/bank-refund-voids/[id]/answered`, #4162,
 * `INV-ADDPAY-042`). The route and its AI app action read it (ALP-721,
 * `INV-SSOT`). `confirmed` is the officer's own confirmation: the app sends it
 * only after asking.
 */
import { z } from "zod";

import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";

export const bankRefundVoidAnsweredBodySchema = z
  .object({
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX),
    confirmed: z.literal(true),
  })
  .strict();
