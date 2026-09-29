import { describe, expect, it } from "vitest";
import { forcedCancelRefundMethod } from "@/lib/cancel-refund-method";

describe("forcedCancelRefundMethod (#3643 follow-up, the one home)", () => {
  it("forces an internet banking payment's cancellation refund to account credit", () => {
    expect(forcedCancelRefundMethod("INTERNET_BANKING")).toBe("credit");
  });

  it("forces nothing for a card payment or no payment", () => {
    expect(forcedCancelRefundMethod("STRIPE")).toBeNull();
    expect(forcedCancelRefundMethod(null)).toBeNull();
    expect(forcedCancelRefundMethod(undefined)).toBeNull();
  });
});
