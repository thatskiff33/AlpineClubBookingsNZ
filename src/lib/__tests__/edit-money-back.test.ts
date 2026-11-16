import { describe, expect, it } from "vitest";
import { editMoneyBackCents, workPartyCreditBackCents } from "@/lib/edit-money-back";
import { workPartyMoneyBackCents } from "@/lib/work-party-booking-correction";

describe("workPartyCreditBackCents", () => {
  const base = {
    refundAmountCents: 0,
    accountCreditAmountCents: 0,
    appliedCreditGivenBackCents: 0,
    refundedExcessCreditCents: 0,
  };

  it("adds every credit route and never the card refund", () => {
    const figures = {
      ...base,
      refundAmountCents: 9_000,
      accountCreditAmountCents: 100,
      appliedCreditGivenBackCents: 20,
      refundedExcessCreditCents: 3,
    };
    expect(workPartyCreditBackCents(figures)).toBe(123);
  });

  it("is the one rule the server's money-back total is built on", () => {
    const figures = { ...base, refundAmountCents: 500, accountCreditAmountCents: 100, refundedExcessCreditCents: 7 };
    expect(workPartyMoneyBackCents(figures as never)).toBe(
      figures.refundAmountCents + workPartyCreditBackCents(figures),
    );
    expect(workPartyMoneyBackCents(figures as never)).toBe(editMoneyBackCents(figures) + 7);
  });
});
