import { describe, expect, it } from "vitest";
import { cancelRefundDisposition, forcedCancelRefundMethod } from "@/lib/cancel-refund-method";
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

  it("forces a bank transfer to the organiser, never the joiner's credit, for one the organiser paid for by internet banking (#3949, owner decision 22 Oct 2026)", () => {
    expect(forcedCancelRefundMethod("INTERNET_BANKING", false, true)).toBe("organiser_by_hand");
    expect(forcedCancelRefundMethod("INTERNET_BANKING", false, false)).toBe("credit");
  });
});

describe("cancelRefundDisposition (#3949 review round 3, the one home for the cancel and its preview)", () => {
  const base = { paymentSource: "STRIPE", organiserCard: false, organiserByBank: false, manuallyMarkedPaid: false, requested: "credit" as const };

  it("an organiser paid by internet banking: forced to them by hand, tiered on the card tiers", () => {
    expect(cancelRefundDisposition({ ...base, paymentSource: "INTERNET_BANKING", organiserByBank: true })).toEqual({ forced: "organiser_by_hand", refundMethod: "card", manualDisposition: true });
  });

  it("the organiser's card wins, and is never by hand", () => {
    expect(cancelRefundDisposition({ ...base, organiserCard: true, organiserByBank: true, manuallyMarkedPaid: true })).toEqual({ forced: "organiser_card", refundMethod: "card", manualDisposition: false });
  });

  it("the member's own: internet banking is credit; a card keeps the choice; a hand-settled one is by hand", () => {
    expect(cancelRefundDisposition({ ...base, paymentSource: "INTERNET_BANKING" })).toEqual({ forced: "credit", refundMethod: "credit", manualDisposition: false });
    expect(cancelRefundDisposition(base)).toEqual({ forced: null, refundMethod: "credit", manualDisposition: false });
    expect(cancelRefundDisposition({ ...base, requested: "card", manuallyMarkedPaid: true })).toEqual({ forced: null, refundMethod: "card", manualDisposition: true });
  });
});

describe("the cancellation hand-back's reason names its payee (#3949)", () => {
  it("the organiser on an organiser-paid place; the member's wording unchanged", async () => {
    const { cancellationHandBackReason } = await import("@/lib/manual-refund-task-copy");
    expect(cancellationHandBackReason({ bookingId: "b1", refundPercentage: 50, payee: "organiser", organiserName: "Olive Organiser" })).toBe(
      "Booking b1 cancelled by its joiner; the group organiser (Olive Organiser) paid for it by internet banking, so the club refunds 50% (under the policy in effect at the time, on the card refund tiers) to the group organiser by bank transfer.",
    );
    expect(cancellationHandBackReason({ bookingId: "b1", refundPercentage: 50, payee: "organiser" })).toContain("the group organiser paid for it");
    expect(cancellationHandBackReason({ bookingId: "b1", refundPercentage: 50, payee: "member" })).toBe(
      "Booking b1 cancelled — cash/manual settlement, refund by hand (50% under the policy in effect at the time).",
    );
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
