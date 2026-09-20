/**
 * #3528 (`INV-ADDPAY-040`): a WITHDRAWN charge request is closed for good and is
 * not "this edit's one request" any more. `findEditReviewChargeRequest` is the
 * one reader that decides whether an edit already has a request - the charge
 * replay, the second-share sync and the dead-recovery cancel all ask it - so
 * the filter is pinned here by its own shape: dropping `withdrawnAt: null`
 * would let a withdrawn row be found again as live, and a later share on the
 * same edit would then meet a FAILED row and refuse as "closed" instead of
 * minting a fresh ask.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroSecondSupplementaryInvoiceOperation: vi.fn(),
  restatePendingSupplementaryInvoiceAmount: vi.fn(),
}));

import { findEditReviewChargeRequest } from "@/lib/edit-financial-review-charge-request";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";

describe("findEditReviewChargeRequest and withdrawn rows (#3528)", () => {
  it("asks only for rows that were NOT withdrawn, by the newest first", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const store = { paymentTransaction: { findFirst } } as unknown as Parameters<
      typeof findEditReviewChargeRequest
    >[0]["store"];

    const found = await findEditReviewChargeRequest({
      paymentId: "payment-1",
      bookingModificationId: "mod-1",
      store,
    });

    expect(found).toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        paymentId: "payment-1",
        kind: "ADDITIONAL",
        source: "STRIPE",
        reason: buildEditFinancialReviewChargeReason("mod-1"),
        withdrawnAt: null,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        stripePaymentIntentId: true,
        amountCents: true,
        carriedAskCents: true,
        status: true,
      },
    });
  });
});
