import { describe, expect, it } from "vitest";
import { forcedCancelRefundMethod } from "@/lib/cancel-refund-method";
import { paidByOrganiserCard } from "@/lib/group-organiser-paid";

describe("forcedCancelRefundMethod (#3643 follow-up, the one home)", () => {
  it("forces an internet banking payment's cancellation refund to account credit", () => {
    expect(forcedCancelRefundMethod("INTERNET_BANKING")).toBe("credit");
  });

  it("forces nothing for a card payment or no payment", () => {
    expect(forcedCancelRefundMethod("STRIPE")).toBeNull();
    expect(forcedCancelRefundMethod(null)).toBeNull();
    expect(forcedCancelRefundMethod(undefined)).toBeNull();
  });

  it("forces the organiser's card for a joiner's booking the organiser paid for by card (#3653)", () => {
    expect(forcedCancelRefundMethod("STRIPE", true)).toBe("organiser_card");
  });
});

describe("paidByOrganiserCard (#3653)", () => {
  const child = { organiserSettled: true, parentBookingId: "organiser_bk", payment: { source: "STRIPE" } };

  it("is a card-settled organiser child, and nothing else", () => {
    expect(paidByOrganiserCard(child)).toBe(true);
    expect(paidByOrganiserCard({ ...child, payment: { source: "INTERNET_BANKING" } })).toBe(false);
    expect(paidByOrganiserCard({ ...child, organiserSettled: false })).toBe(false);
    expect(paidByOrganiserCard({ ...child, parentBookingId: null })).toBe(false);
    expect(paidByOrganiserCard({ ...child, payment: null })).toBe(false);
  });
});
