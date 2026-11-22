import { describe, expect, it } from "vitest";

import { editMoneyBackCents, editTotalMoneyBackCents, workPartyCreditBackCents } from "@/lib/edit-money-back";

const NONE = {
  refundAmountCents: 0,
  accountCreditAmountCents: 0,
  appliedCreditGivenBackCents: 0,
  refundedExcessCreditCents: 0,
};

describe("the money an edit hands back (INV-SSOT, fork triyder/AlpineClubBookingsNZ#132)", () => {
  it("is nothing when nothing comes back", () => {
    expect(editMoneyBackCents(NONE)).toBe(0);
    expect(editTotalMoneyBackCents(NONE)).toBe(0);
  });

  it.each([
    ["a card refund", { refundAmountCents: 900 }],
    ["paid money as account credit", { accountCreditAmountCents: 900 }],
    ["a paid booking's applied credit given back", { appliedCreditGivenBackCents: 900 }],
  ])("counts %s in both sums", (_label, money) => {
    expect(editMoneyBackCents({ ...NONE, ...money })).toBe(900);
    expect(editTotalMoneyBackCents({ ...NONE, ...money })).toBe(900);
  });

  it("counts an unpaid booking's freed applied credit in the total only", () => {
    const freed = { ...NONE, refundedExcessCreditCents: 1_500 };
    expect(editMoneyBackCents(freed)).toBe(0);
    expect(editTotalMoneyBackCents(freed)).toBe(1_500);
  });

  it("adds every figure, once, in integer cents", () => {
    expect(
      editTotalMoneyBackCents({
        refundAmountCents: 1,
        accountCreditAmountCents: 20,
        appliedCreditGivenBackCents: 300,
        refundedExcessCreditCents: 4_000,
      }),
    ).toBe(4_321);
  });
});

describe("workPartyCreditBackCents (triyder/AlpineClubBookingsNZ#129)", () => {
  it("adds every credit route and never the refund", () => {
    const figures = {
      refundAmountCents: 9_000,
      accountCreditAmountCents: 100,
      appliedCreditGivenBackCents: 20,
      refundedExcessCreditCents: 3,
    };
    expect(workPartyCreditBackCents(figures)).toBe(123);
    expect(workPartyCreditBackCents(figures)).toBe(editTotalMoneyBackCents(figures) - figures.refundAmountCents);
  });
});
