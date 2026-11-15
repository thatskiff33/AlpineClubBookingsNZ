import { describe, expect, it } from "vitest";
import { memberMoneyEventKeys } from "@/lib/member-money";
import { MemberMoneyPlanError } from "@/lib/member-money/internal/plan";
import { planJoiningFee, planSubscriptionCharge, planSubscriptionReceipt } from "@/lib/member-money/internal/subscription-charges";

/** #4519 (Ledger M7): the pure subscription and joining-fee planners. */

const facts = (components: number[], chargedAmountCents = components.reduce((s, c) => s + c, 0), billingBasis = "PER_MEMBER") => ({
  chargeId: "charge-1", recipientMemberId: "member-1", billingBasis, chargedAmountCents,
  components: components.map((c, i) => ({ id: `k${i}`, label: `Part ${i}`, chargedAmountCents: c })),
});

describe("planSubscriptionCharge (R18)", () => {
  it("is one obligation for the recipient and one revenue leg per component", () => {
    const plan = planSubscriptionCharge(facts([15_000, 2_500]));
    expect(plan.kind).toBe("CHARGE");
    if (plan.kind !== "CHARGE") return;
    expect(plan.eventKey).toBe(memberMoneyEventKeys.subscriptionCharge("charge-1"));
    expect(plan.obligations).toEqual([expect.objectContaining({ faceCents: 17_500, debtor: { kind: "MEMBER", memberId: "member-1" } })]);
    expect(plan.legs.filter((l) => l.type === "revenue").map((l) => l.type === "revenue" && [l.chargeIdentity, l.grossCents]))
      .toEqual([["subscription:charge-1:k0", 15_000], ["subscription:charge-1:k1", 2_500]]);
    expect(plan.legs.filter((l) => l.account === "MEMBER_RECEIVABLE")).toHaveLength(1);
  });

  it("refuses components that do not add up to the charge", () => {
    expect(() => planSubscriptionCharge(facts([15_000, 2_500], 17_000))).toThrow(MemberMoneyPlanError);
    expect(() => planSubscriptionCharge(facts([15_000, -1], 14_999))).toThrow(MemberMoneyPlanError);
    expect(() => planSubscriptionCharge(facts([15_000], 150.5))).toThrow(MemberMoneyPlanError);
  });

  it("is a ZERO for NO_INVOICE or a zero gross", () => {
    expect(planSubscriptionCharge(facts([0], 0, "NO_INVOICE")).kind).toBe("ZERO");
    expect(planSubscriptionCharge(facts([], 0)).kind).toBe("ZERO");
  });

  it("is a ZERO naming each replaced paid charge once, sorted", () => {
    const plan = planSubscriptionCharge(facts([15_000]), { replacesPaid: ["b", "a", "b"] });
    expect(plan.kind).toBe("ZERO");
    expect(plan.additionalSources?.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("planJoiningFee (R19)", () => {
  it("charges the frozen cents to joining-fee revenue", () => {
    const plan = planJoiningFee({ memberId: "member-1", feeAmountCents: 5_000, exempt: false });
    expect(plan).toMatchObject({ kind: "CHARGE", eventKey: memberMoneyEventKeys.joiningFee("member-1") });
    if (plan.kind !== "CHARGE") return;
    expect(plan.legs.find((l) => l.account === "JOINING_FEE_REVENUE")).toMatchObject({ grossCents: 5_000 });
  });

  it("is a ZERO for an exempt member and refuses no fee", () => {
    expect(planJoiningFee({ memberId: "member-1", feeAmountCents: 0, exempt: true }).kind).toBe("ZERO");
    expect(() => planJoiningFee({ memberId: "member-1", feeAmountCents: 0, exempt: false })).toThrow(MemberMoneyPlanError);
  });
});

describe("planSubscriptionReceipt (R08)", () => {
  it("is cash against the receivable, collected on the charge's obligation in the same batch", () => {
    const eventKey = memberMoneyEventKeys.subscriptionReceipt("charge-1", 1);
    const plan = planSubscriptionReceipt({ eventKey, chargeId: "charge-1", version: "paid:1", debtor: { kind: "MEMBER", memberId: "member-1" },
      obligationKey: memberMoneyEventKeys.subscriptionCharge("charge-1"), amountCents: 12_345, reason: "paid" });
    expect(plan.kind).toBe("RECEIPT");
    if (plan.kind !== "RECEIPT") return;
    expect(plan.legs.map((l) => [l.account, l.side, l.type === "amount" && l.amountCents]))
      .toEqual([["CASH", "DEBIT", 12_345], ["MEMBER_RECEIVABLE", "CREDIT", 12_345]]);
    expect(plan.applications).toEqual([expect.objectContaining({ source: { leg: 1 }, amountCents: 12_345 })]);
  });
});
