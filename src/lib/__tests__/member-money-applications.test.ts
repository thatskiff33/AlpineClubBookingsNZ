import { describe, expect, it } from "vitest";
import { buildMemberMoneyBatch, buildMemberMoneyReversal, MemberMoneyPlanError, type MemberMoneyPlan } from "@/lib/member-money/internal/plan";
import { memberMoneyEventKeys as keys, memberMoneyApplicationKeys, memberMoneyChainKey, walkMemberMoneyChain } from "@/lib/member-money/internal/keys";
import { memberMoneyConservationProblems, type ApplicationState } from "@/lib/member-money/internal/application-state";
import { memberMoneyTestContext } from "./support/member-money-fixtures";

const context = memberMoneyTestContext();
const debtor = { kind: "MEMBER", memberId: "m" } as const;
const booking = { bookingId: "b", lodgeId: "l" };
const receipt = (): Extract<MemberMoneyPlan, { legs: unknown }> => ({
  kind: "RECEIPT", eventKey: keys.capture("capture-1"), origin: "STRIPE", source: { kind: "PAYMENT", id: "transaction-1", version: "captured" }, reason: "cash received",
  legs: [
    { type: "amount", account: "STRIPE_CLEARING", side: "DEBIT", amountCents: 100, booking, evidence: {} },
    { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 100, debtor, booking, evidence: {} },
  ],
  applications: [{ key: "application-1", source: { leg: 1 }, obligationKey: "charge", amountCents: 60 }],
});
function state(): ApplicationState {
  return {
    sources: [{ id: "receipt", sourceKind: "PAYMENT", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 100, debtorKind: "MEMBER", memberId: "m", organisationId: null, currency: "NZD", bookingId: "b", obligationId: null, capture: "capture", reversed: false },
      { id: "refund", sourceKind: "REFUND", account: "REFUND_PAYABLE", side: "DEBIT", amountCents: 100, debtorKind: "MEMBER", memberId: "m", organisationId: null, currency: "NZD", bookingId: "b", obligationId: "successor", capture: "capture", reversed: false }],
    obligations: [{ id: "root", key: "refund-obligation|cancellation|b", kind: "REFUND", faceCents: 100, debtorKind: "MEMBER", memberId: "m", organisationId: null, currency: "NZD" },
      { id: "successor", key: "refund-obligation|cancellation|b|for|MEMBER|m", kind: "REFUND", faceCents: 100, debtorKind: "MEMBER", memberId: "m", organisationId: null, currency: "NZD" }],
    applications: [{ id: "fund", sourceLineId: "receipt", obligationId: "root", amountCents: 100, reversesApplicationId: null }], reservations: [],
  };
}
describe("M4a applications", () => {
  it("includes application economics in the hash, preserving order-independent leg identity", () => {
    const plan = receipt();
    const hash = buildMemberMoneyBatch(context, plan).event.payloadHash;
    expect(buildMemberMoneyBatch(context, { ...plan, applications: [{ ...plan.applications![0]!, amountCents: 59 }] }).event.payloadHash).not.toBe(hash);
    expect(buildMemberMoneyBatch(context, { ...plan, legs: [...plan.legs].reverse(), applications: [{ ...plan.applications![0]!, source: { leg: 0 } }] }).event.payloadHash).toBe(hash);
  });
  it("refuses an in-batch over-application and an application from the cash leg", () => {
    const plan = receipt();
    expect(() => buildMemberMoneyBatch(context, { ...plan, applications: [{ ...plan.applications![0]!, amountCents: 101 }] })).toThrow(/C1/);
    expect(() => buildMemberMoneyBatch(context, { ...plan, applications: [{ ...plan.applications![0]!, source: { leg: 0 } }] })).toThrow(MemberMoneyPlanError);
  });
  it("copies original applications with their source ids and exact cents into a reversal", () => {
    const original = { id: "journal", currency: "NZD", policyVersion: "p", codingVersion: "c", lines: [], applications: [{ id: "application", key: "original", source: { lineId: "receipt" }, obligationKey: "charge", amountCents: 60, reversesApplicationId: null }] };
    const batch = buildMemberMoneyReversal(context, { reversesJournalId: "journal", origin: "APP", source: { kind: "BOOKING", id: "b", version: "reverse" }, reason: "reverse" }, original);
    expect(batch.applications).toEqual([{ key: "reversal:journal|application", source: { lineId: "receipt" }, obligationKey: "charge", amountCents: 60, reversesApplicationId: "application" }]);
  });
  it("checks C1 across collect and fund, and nets exact reversals", () => {
    const s = state();
    s.applications.push({ id: "another", sourceLineId: "receipt", obligationId: "root", amountCents: 1, reversesApplicationId: null });
    expect(memberMoneyConservationProblems(s)).toContainEqual({ identity: "receipt", problem: "C1_source_cap" });
    s.applications.push({ id: "undo", sourceLineId: "receipt", obligationId: "root", amountCents: 1, reversesApplicationId: "another" });
    expect(memberMoneyConservationProblems(s)).toEqual([]);
  });
  it("checks C3 across a root and successors, including open reservations", () => {
    const s = state();
    s.applications.push({ id: "paid", sourceLineId: "refund", obligationId: "successor", amountCents: 60, reversesApplicationId: null });
    s.reservations.push({ id: "reserve", attemptKey: "attempt", obligationId: "root", capture: "capture", amountCents: 41 });
    expect(memberMoneyConservationProblems(s)).toContainEqual({ identity: "refund-obligation|cancellation|b", problem: "C3_refund_family_cap" });
  });
  it("checks C4 separately for each capture even with family headroom", () => {
    const s = state();
    s.reservations.push({ id: "reserve", attemptKey: "attempt", obligationId: "successor", capture: "another-capture", amountCents: 1 });
    expect(memberMoneyConservationProblems(s)).toEqual([{ identity: "refund-obligation|cancellation|b:another-capture", problem: "C4_capture_cap" }]);
  });
});
describe("M4a stable keys", () => {
  it("gives each event builder a distinct namespace, accepts colon-nested Stripe keys verbatim", () => {
    const built = [keys.bookingCharge("x"), keys.modification("x"), keys.cancellation("x", 0), keys.reviewClose("x", "x"), keys.backPost("x"), keys.chargeRestatement("x"), keys.merge("x", "x"), keys.reversal("x"), keys.capture("x"), keys.receipt("x", "x"), keys.collect(keys.capture("x")), keys.chargeOpen("x"), keys.refundFunding("x:a"), keys.refund("x"), keys.refundAnswer("x"), keys.paidAnotherWay("x"), keys.handBackPaid("x"), keys.refundCloseOut(keys.refundObligation("review", "x")), keys.keptCapture("x"), keys.successor(keys.refundObligation("review", "x"), "x", "x"), keys.mergeResidue("x", "x", keys.capture("x")),
      ...(["cancellation", "modification", "refund-request", "review", "capture-return", "hand-back"] as const).map((scope) => keys.refundObligation(scope, "x"))];
    expect(new Set(built).size).toBe(built.length);
    expect(keys.refundFunding("prefix:slice:100")).toBe("refund-funding|prefix:slice:100");
    expect(() => keys.refundFunding("prefix|slice")).toThrow();
    expect(() => keys.capture("x|after|y")).toThrow();
    expect(memberMoneyApplicationKeys.application(keys.capture("x"), "line:1", "charge")).toBe("capture:x|line:1|charge");
  });
  it("walks exact reversals and replays the live tip", async () => {
    const base = keys.refundObligation("review", "task");
    const next = memberMoneyChainKey(base, "reversal-journal");
    const find = async (key: string) => key === base ? { reversedBy: { id: "reversal-journal" } } : null;
    expect(await walkMemberMoneyChain(base, find)).toBe(next);
    expect(await walkMemberMoneyChain(base, async (key) => key === next ? { reversedBy: null } : find(key))).toBe(next);
  });
});
