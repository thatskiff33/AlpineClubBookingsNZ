import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  editReviewSettlementIssuesXeroDocument,
  editReviewXeroDocumentAsk,
} from "@/lib/edit-financial-review-xero-leg";

/**
 * ONE answer to "will this closure send Xero a document?", asked by the Xero leg
 * to decide whether to dispatch and by #3219's re-price to decide whether the
 * booking's history warns a treasurer and the audit entry is `critical`.
 *
 * The re-price used to derive its own, as `settlementRoute !== null`, and that
 * is LOOSER in the unsafe direction: the `local-allocation` route carries a
 * NULLABLE `bookingModificationId`, so a review settled against a booking with a
 * non-Stripe captured payment and no anchor returns a route, sends Xero nothing,
 * and would have reported the invoice as brought back into line - dropping the
 * one sentence that tells a treasurer not to mark the booking PAID on the new
 * figure.
 */
describe("will this edit-review closure send Xero a document? (#3219)", () => {
  const anchored = { bookingModificationId: "mod-1" };

  it("yes: an anchored route billing a real amount", () => {
    expect(
      editReviewXeroDocumentAsk({ route: anchored, xeroAmountCents: 5_000 }),
    ).toEqual({ bookingModificationId: "mod-1", amountCents: 5_000 });
    expect(
      editReviewSettlementIssuesXeroDocument({
        route: anchored,
        xeroAmountCents: 5_000,
      }),
    ).toBe(true);
  });

  it.each([
    [
      "a route with NO anchor - the hand-settled local-allocation shape",
      { route: { bookingModificationId: null }, xeroAmountCents: 5_000 },
    ],
    [
      "a route whose amount is zero, which dispatches nothing",
      { route: anchored, xeroAmountCents: 0 },
    ],
    [
      "a route whose amount is unknown",
      { route: anchored, xeroAmountCents: null },
    ],
    ["no route at all - every dismissal", { route: null, xeroAmountCents: 5_000 }],
  ])("no: %s", (_name, input) => {
    expect(editReviewXeroDocumentAsk(input)).toBeNull();
    expect(editReviewSettlementIssuesXeroDocument(input)).toBe(false);
  });
});
