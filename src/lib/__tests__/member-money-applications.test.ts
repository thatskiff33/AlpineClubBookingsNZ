import { describe, expect, it } from "vitest";
import { memberMoneyApplicationKeys, memberMoneyChainKey } from "@/lib/member-money";
import { memberMoneyEventKeys as keys, walkMemberMoneyChain } from "@/lib/member-money/internal/keys";
import { buildMemberMoneyBatch, buildMemberMoneyReversal, MemberMoneyPlanError, type MemberMoneyPlan } from "@/lib/member-money/internal/plan";
import { applicationRoleOf, sameApplicationDebtor, memberMoneyApplicationTotals, memberMoneyConservationProblems, type ApplicationState } from "@/lib/member-money/internal/application-state";
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
  it.each([
    [{ key: "" }, /keys must be non-empty/],
    [{ amountCents: 0 }, /positive integer cents/],
    [{ obligationKey: "" }, /need an obligation/],
    [{ source: { leg: 9 } }, /must name an amount leg/],
    [{ source: { lineId: "" } }, /source line id is blank/],
    [{ reversesApplicationId: "original" }, /original posted source line/],
  ] as const)("refuses malformed application %j", (change, message) => {
    const plan = receipt();
    expect(() => buildMemberMoneyBatch(context, { ...plan, applications: [{ ...plan.applications![0]!, ...change }] })).toThrow(message);
  });
  it("refuses duplicate application identities and sums all applications against their source", () => {
    const plan = receipt();
    const first = plan.applications![0]!;
    expect(() => buildMemberMoneyBatch(context, { ...plan, applications: [first, first] })).toThrow(/unique/);
    expect(() => buildMemberMoneyBatch(context, { ...plan, applications: [first, { ...first, key: "second", amountCents: 41 }] })).toThrow(/C1/);
  });
  it("checks a pay leg's exact obligation and debtor before posting", () => {
    const key = keys.refundObligation("review", "task");
    const plan: Extract<MemberMoneyPlan, { legs: unknown }> = { kind: "REFUND", eventKey: keys.refund("refund"), origin: "STRIPE",
      source: { kind: "REFUND", id: "refund", version: "1" }, reason: "refund", legs: [
        { type: "amount", account: "REFUND_PAYABLE", side: "DEBIT", amountCents: 100, debtor, obligationKey: key, booking, evidence: {} },
        { type: "amount", account: "STRIPE_CLEARING", side: "CREDIT", amountCents: 100, booking, evidence: {} },
      ], applications: [{ key: "pay", source: { leg: 0 }, obligationKey: "different", amountCents: 100 }] };
    expect(() => buildMemberMoneyBatch(context, plan)).toThrow(/source leg's obligation/);
    const obligation = { key, kind: "REFUND" as const, debtor: { kind: "MEMBER" as const, memberId: "other" }, faceCents: 100, evidence: {} };
    expect(() => buildMemberMoneyBatch(context, { ...receipt(), obligations: [obligation],
      applications: [{ ...receipt().applications![0]!, obligationKey: key }] })).toThrow(/same debtor/);
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
  it("collects only credit AR and pays only the exact refund obligation", () => {
    const s = state();
    const charge = { ...s.obligations[0]!, kind: "CHARGE" as const };
    expect(applicationRoleOf(s.sources[0]!, charge)).toBe("collect");
    expect(applicationRoleOf(s.sources[0]!, s.obligations[0]!)).toBe("fund");
    expect(applicationRoleOf(s.sources[1]!, s.obligations[1]!)).toBe("pay");
    expect(applicationRoleOf(s.sources[1]!, s.obligations[0]!)).toBeNull();
    expect(applicationRoleOf(s.sources[1]!, charge)).toBeNull();
    expect(applicationRoleOf({ ...s.sources[0]!, side: "DEBIT" }, charge)).toBeNull();
    expect(applicationRoleOf({ ...s.sources[0]!, account: "CASH" }, charge)).toBeNull();
    expect(sameApplicationDebtor(s.sources[0]!, charge)).toBe(true);
    for (const change of [{ currency: "USD" }, { debtorKind: "ORGANISATION" }, { memberId: "other" }, { organisationId: "other" }]) {
      expect(sameApplicationDebtor({ ...s.sources[0]!, ...change }, charge)).toBe(false);
    }
  });
  it("sums collections, non-card funding and reversal-of-reversal exactly", () => {
    const s = state();
    s.obligations[0]!.kind = "CHARGE";
    s.sources[0]!.capture = null;
    s.applications.push({ ...s.applications[0]!, id: "undo", reversesApplicationId: "fund" },
      { ...s.applications[0]!, id: "redo", reversesApplicationId: "undo" });
    expect(memberMoneyApplicationTotals(s).collected).toBe(100);
    s.obligations[0]!.kind = "REFUND";
    const family = memberMoneyApplicationTotals(s).families.get(s.obligations[0]!.key)!;
    expect(family.funded).toBe(100);
    expect(family.captures.size).toBe(0);
  });
  it.each(["cycle", "original", "source", "obligation", "reservation"])("refuses incomplete or cyclic %s projections", (problem) => {
    const s = state();
    if (problem === "cycle") s.applications[0]!.reversesApplicationId = "fund";
    if (problem === "original") s.applications[0]!.reversesApplicationId = "absent";
    if (problem === "source") s.sources = [];
    if (problem === "obligation") s.obligations = [];
    if (problem === "reservation") s.reservations.push({ id: "r", attemptKey: "a", obligationId: "absent", capture: "capture", amountCents: 1 });
    expect(() => memberMoneyApplicationTotals(s)).toThrow(/Cyclic|Missing/);
  });
  it("reports missing roots, excess funding and negative source balances", () => {
    const missingRoot = state(); missingRoot.obligations[0]!.key += "|for|MEMBER|other";
    expect(memberMoneyConservationProblems(missingRoot)).toContainEqual({ identity: "refund-obligation|cancellation|b", problem: "C3_refund_family_cap" });
    const excess = state(); excess.obligations[0]!.faceCents = 99;
    expect(memberMoneyConservationProblems(excess)).toContainEqual({ identity: "refund-obligation|cancellation|b", problem: "C3_refund_family_cap" });
    const negative = state(); negative.applications[0]!.amountCents = -1;
    expect(memberMoneyConservationProblems(negative)).toEqual(expect.arrayContaining([
      { identity: "receipt", problem: "C1_source_cap" },
      { identity: "refund-obligation|cancellation|b", problem: "C3_refund_family_cap" },
      { identity: "refund-obligation|cancellation|b:capture", problem: "C4_capture_cap" },
    ]));
  });
});
describe("M4a stable keys", () => {
  it("gives each event builder a distinct namespace, accepts colon-nested Stripe keys verbatim", () => {
    const built = [keys.bookingCharge("x"), keys.modification("x"), keys.cancellation("x", 0), keys.reviewClose("x", "x"), keys.backPost("x"), keys.chargeRestatement("x"), keys.merge("x", "x"), keys.reversal("x"), keys.capture("x"), keys.receipt("x", "x"), keys.collect(keys.capture("x")), keys.chargeOpen("x"), keys.refundFunding("x:a"), keys.refund("x"), keys.refundAnswer("x"), keys.paidAnotherWay("x"), keys.handBackPaid("x"), keys.refundCloseOut("x"), keys.keptCapture("x"), keys.successor(keys.refundObligation("review", "x"), "x", "x"), keys.mergeResidue("x", "x", keys.capture("x")), keys.mergeFollow(keys.capture("x"), "x"),
      ...(["cancellation", "modification", "refund-request", "review", "capture-return", "hand-back"] as const).map((scope) => keys.refundObligation(scope, "x"))];
    expect(new Set(built).size).toBe(built.length);
    expect(keys.refund("re_1")).toBe("refund:re_1");
    expect(keys.capture("pi_1")).toBe("capture:pi_1");
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
  it("keeps nested identities verbatim, namespaces successors, and refuses cyclic chains", async () => {
    const base = keys.refundObligation("review", "task:revision");
    expect(memberMoneyApplicationKeys.successor(base, "MEMBER", "member:one")).toBe(`${base}|for|MEMBER|member:one`);
    expect(memberMoneyApplicationKeys.successor(base, "ORGANISATION", "member:one")).not.toBe(memberMoneyApplicationKeys.successor(base, "MEMBER", "member:one"));
    const twice = memberMoneyApplicationKeys.successor(memberMoneyApplicationKeys.successor(base, "MEMBER", "a"), "MEMBER", "b");
    expect([memberMoneyApplicationKeys.succeeds(twice, base), memberMoneyApplicationKeys.succeeds(base, base),
      memberMoneyApplicationKeys.succeeds(memberMoneyApplicationKeys.successor(`${base}x`, "MEMBER", "a"), base)]).toEqual([true, false, false]);
    expect([memberMoneyApplicationKeys.root(twice), memberMoneyApplicationKeys.root(base)]).toEqual([base, base]);
    expect(memberMoneyChainKey(base)).toBe(base);
    expect(memberMoneyChainKey(base, "reverse:one")).toBe(`${base}|after|reverse:one`);
    for (const bad of ["", "part|injection"]) {
      expect(() => keys.refundFunding(bad)).toThrow();
      expect(() => memberMoneyChainKey(base, bad)).toThrow();
    }
    await expect(walkMemberMoneyChain(base, async () => ({ reversedBy: { id: "same" } }))).rejects.toThrow(/Cyclic/);
    const next = memberMoneyChainKey(base, "first");
    const last = memberMoneyChainKey(base, "second");
    expect(await walkMemberMoneyChain(base, async (key) => key === base ? { reversedBy: { id: "first" } }
      : key === next ? { reversedBy: { id: "second" } } : null)).toBe(last);
  });
});
