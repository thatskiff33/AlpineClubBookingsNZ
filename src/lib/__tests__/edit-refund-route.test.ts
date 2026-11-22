/**
 * #5303: the one wording of where an edit's refund goes (`INV-SSOT-001`). Each
 * booking's own answer comes from the settlement; this module only combines
 * and words it, so a bank-transfer refund is never offered as the card.
 */
import { describe, expect, it } from "vitest";
import {
  EDIT_REFUND_CREDIT_CHOICE_LABEL,
  EDIT_REFUND_ROUTES,
  combineEditRefundRoutes,
  editRefundChoiceLabel,
  editRefundDestinationPhrase,
  editRefundRouteOf,
} from "@/lib/edit-refund-route";

describe("editRefundRouteOf", () => {
  it("is the card when no booking is refunded by bank transfer", () => {
    expect(editRefundRouteOf([false])).toBe("CARD");
    expect(editRefundRouteOf([false, false])).toBe("CARD");
  });

  it("is bank transfer when every booking is", () => {
    expect(editRefundRouteOf([true])).toBe("BANK_TRANSFER");
    expect(editRefundRouteOf([true, true])).toBe("BANK_TRANSFER");
  });

  it("is mixed when the one choice covers both kinds", () => {
    expect(editRefundRouteOf([false, true])).toBe("CARD_AND_BANK_TRANSFER");
    expect(editRefundRouteOf([true, false, false])).toBe("CARD_AND_BANK_TRANSFER");
  });
});

describe("combineEditRefundRoutes", () => {
  it("keeps a single route as it is", () => {
    for (const route of EDIT_REFUND_ROUTES) expect(combineEditRefundRoutes([route])).toBe(route);
  });

  it("mixes a card route with a bank-transfer one, and absorbs into an already mixed one", () => {
    expect(combineEditRefundRoutes(["CARD", "BANK_TRANSFER"])).toBe("CARD_AND_BANK_TRANSFER");
    expect(combineEditRefundRoutes(["CARD", "CARD_AND_BANK_TRANSFER"])).toBe("CARD_AND_BANK_TRANSFER");
    expect(combineEditRefundRoutes(["BANK_TRANSFER", "CARD_AND_BANK_TRANSFER"])).toBe("CARD_AND_BANK_TRANSFER");
    expect(combineEditRefundRoutes(["CARD", "CARD"])).toBe("CARD");
    expect(combineEditRefundRoutes(["BANK_TRANSFER", "BANK_TRANSFER"])).toBe("BANK_TRANSFER");
  });
});

describe("the wording", () => {
  it("labels each route's refund choice", () => {
    expect(editRefundChoiceLabel("CARD")).toBe("Refund to original card");
    expect(editRefundChoiceLabel("BANK_TRANSFER")).toBe("Refund by bank transfer");
    expect(editRefundChoiceLabel("CARD_AND_BANK_TRANSFER")).toBe(
      "Refund to original card, or by bank transfer for a booking that can't be refunded to a card",
    );
    expect(EDIT_REFUND_CREDIT_CHOICE_LABEL).toBe("Hold as account credit");
  });

  it("words each route inside the money sentence, including the mixed one", () => {
    const sentence = (route: (typeof EDIT_REFUND_ROUTES)[number]) =>
      `That comes back ${editRefundDestinationPhrase(route)} or as account credit.`;
    expect(sentence("CARD")).toBe("That comes back to your card or as account credit.");
    expect(sentence("BANK_TRANSFER")).toBe("That comes back by bank transfer or as account credit.");
    expect(sentence("CARD_AND_BANK_TRANSFER")).toBe(
      "That comes back to your card (or by bank transfer for a booking that can't be refunded to a card) or as account credit.",
    );
  });
});
