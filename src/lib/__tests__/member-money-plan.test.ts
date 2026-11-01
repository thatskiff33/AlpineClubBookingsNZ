/**
 * The posting plan builder and event keys (#4626, Ledger M3a). Pure: every case
 * here is refused or built before the store writes a row. What the database
 * then accepts is `member-money-posting.realdb.test.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memberMoneyEventKeys, MemberMoneyPlanError, TAXED_REVENUE_ACCOUNTS, type MemberMoneyPlan } from "@/lib/member-money";
import { buildMemberMoneyBatch, buildMemberMoneyReversal, type BuiltLine } from "@/lib/member-money/internal/plan";
import { bookingChargePlan, memberMoneyTestContext } from "./support/member-money-fixtures";

const MEMBER = { kind: "MEMBER", memberId: "member-1" } as const;
const context = memberMoneyTestContext();
const charge = (grossCents = 11500) => bookingChargePlan({ eventKey: "booking-charge:b1", debtor: MEMBER, grossCents,
  booking: { bookingId: "b1", lodgeId: "l1" } });
const legsOf = (lines: readonly BuiltLine[]) => lines.map(({ account, side, amountCents, netCents, taxCents }) => [account, side, amountCents, netCents, taxCents]);

function problems(plan: MemberMoneyPlan, ctx = context): readonly string[] {
  try {
    buildMemberMoneyBatch(ctx, plan);
  } catch (error) {
    if (error instanceof MemberMoneyPlanError) return error.problems;
    throw error;
  }
  return [];
}

describe("member-money event keys", () => {
  it("spells each event of the M3 key scheme once", () => {
    expect(memberMoneyEventKeys.bookingCharge("b1")).toBe("booking-charge:b1");
    expect(memberMoneyEventKeys.modification("m1")).toBe("modification:m1");
    expect(memberMoneyEventKeys.cancellation("b1", 2)).toBe("cancellation:b1:2");
    expect(memberMoneyEventKeys.reviewClose("t1")).toBe("review-close:t1");
    expect(memberMoneyEventKeys.merge("from", "to")).toBe("merge:from:to");
    expect(memberMoneyEventKeys.reversal("j1")).toBe("reversal:j1");
  });

  it("refuses a part that could make two events spell one key", () => {
    expect(() => memberMoneyEventKeys.merge("a:b", "c")).toThrow(/without ':'/);
    expect(() => memberMoneyEventKeys.bookingCharge("")).toThrow();
    expect(() => memberMoneyEventKeys.bookingCharge(" b1")).toThrow();
    expect(() => memberMoneyEventKeys.cancellation("b1", -1)).toThrow(/revision/);
    expect(() => memberMoneyEventKeys.cancellation("b1", 1.5)).toThrow(/revision/);
  });
});

describe("buildMemberMoneyBatch", () => {
  it("splits a revenue component into net revenue and a GST leg on the same side, and balances", () => {
    const batch = buildMemberMoneyBatch(context, charge());
    expect(legsOf(batch.lines)).toEqual([
      ["MEMBER_RECEIVABLE", "DEBIT", 11500, null, null],
      ["BOOKING_REVENUE", "CREDIT", 10000, 10000, 1500],
      ["GST_PAYABLE", "CREDIT", 1500, null, null],
    ]);
    expect(batch.lines[1]).toMatchObject({ grossCents: 11500, taxCode: "GST_INCLUSIVE_1500BP", bookingId: "b1", lodgeId: "l1" });
    expect(batch.lines[2]).toMatchObject({ debtorKind: null, obligationKey: null, chargeIdentity: batch.lines[1]!.chargeIdentity });
    expect(batch.obligations).toEqual([expect.objectContaining({ key: "booking-charge:b1:obligation", faceCents: 11500, debtorKind: "MEMBER" })]);
    expect(batch.event).toMatchObject({ kind: "CHARGE", effectiveDate: "2026-07-01", payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("posts gross revenue with no tax fields and no GST leg when the club is not registered", () => {
    const batch = buildMemberMoneyBatch(memberMoneyTestContext({ taxSettings: { gstRegistered: false } }), charge());
    expect(legsOf(batch.lines)).toEqual([["MEMBER_RECEIVABLE", "DEBIT", 11500, null, null], ["BOOKING_REVENUE", "CREDIT", 11500, null, null]]);
    expect(batch.lines[1]).toMatchObject({ grossCents: null, taxCode: null });
  });

  it("writes no GST leg for a component too small to carry tax", () => {
    expect(legsOf(buildMemberMoneyBatch(context, charge(1)).lines)).toEqual([
      ["MEMBER_RECEIVABLE", "DEBIT", 1, null, null], ["BOOKING_REVENUE", "CREDIT", 1, 1, 0],
    ]);
  });

  it("repeats a frozen split instead of today's rate", () => {
    const plan = charge();
    const batch = buildMemberMoneyBatch(context, { ...plan, legs: [plan.legs[0]!, { ...plan.legs[1]!, type: "revenue",
      account: "BOOKING_REVENUE", grossCents: 11500, frozenTax: { grossCents: 11500, netCents: 10223, taxCents: 1277, taxCode: "GST_INCLUSIVE_1250BP" } }] });
    expect(legsOf(batch.lines).slice(1)).toEqual([["BOOKING_REVENUE", "CREDIT", 10223, 10223, 1277], ["GST_PAYABLE", "CREDIT", 1277, null, null]]);
  });

  it("builds an explicit ZERO event with no legs", () => {
    const batch = buildMemberMoneyBatch(context, { kind: "ZERO", eventKey: "zero:1", origin: "APP", reason: "no invoice",
      source: { kind: "SUBSCRIPTION", id: "s1", version: "1" } });
    expect(batch.lines).toEqual([]);
    expect(batch.sources).toEqual([{ kind: "SUBSCRIPTION", id: "s1", version: "1", bookingLedgerLineId: null }]);
  });

  it("hashes the same facts in any order alike, and any change in cents or wording differently", () => {
    const plan = charge();
    const hash = (p: MemberMoneyPlan) => buildMemberMoneyBatch(context, p).event.payloadHash;
    expect(hash({ ...plan, legs: [...plan.legs].reverse() })).toBe(hash(plan));
    expect(hash(charge(11600))).not.toBe(hash(plan));
    expect(hash({ ...plan, reason: "other" })).not.toBe(hash(plan));
    expect(hash(plan)).not.toBe(buildMemberMoneyBatch(memberMoneyTestContext({ taxSettings: { taxRateBasisPoints: 1250 } }), plan).event.payloadHash);
  });

  describe("refuses before any write", () => {
    const base = charge();
    const [receivable, revenue] = base.legs as [Extract<typeof base.legs[number], { type: "amount" }>, Extract<typeof base.legs[number], { type: "revenue" }>];

    it.each<[string, MemberMoneyPlan, RegExp]>([
      ["a dropped balancing leg", { ...base, legs: [receivable] }, /at least two legs|debits minus credits/],
      ["unbalanced cents", { ...base, legs: [{ ...receivable, amountCents: 11499 }, revenue] }, /debits minus credits is -1 cents/],
      ["non-integer cents", { ...base, legs: [{ ...receivable, amountCents: 11500.5 }, revenue] }, /positive integer cents/],
      ["zero cents", { ...base, legs: [{ ...receivable, amountCents: 0 }, revenue] }, /positive integer cents/],
      ["a receivable with no debtor", { ...base, legs: [{ ...receivable, debtor: undefined, obligationKey: undefined }, revenue] }, /needs a debtor/],
      ["revenue posted as a plain amount", { ...base, legs: [receivable, { ...receivable, account: "BOOKING_REVENUE" as never, side: "CREDIT" }] }, /only the builder splits tax/],
      ["GST posted by hand", { ...base, legs: [receivable, { ...receivable, account: "GST_PAYABLE" as never, side: "CREDIT" }] }, /only the builder splits tax/],
      ["a credit leg with no lot", { ...base, legs: [receivable, { ...receivable, account: "MEMBER_CREDIT", side: "CREDIT", obligationKey: undefined }] }, /credit lot/],
      ["a refund-payable leg with no obligation", { ...base, legs: [receivable, { ...receivable, account: "REFUND_PAYABLE", side: "CREDIT", obligationKey: undefined }] }, /needs an obligation/],
      ["a leg naming another debtor than its obligation", { ...base, legs: [{ ...receivable, debtor: { kind: "MEMBER", memberId: "member-2" } }, revenue] }, /other than obligation/],
      ["an obligation planned twice", { ...base, obligations: [base.obligations![0]!, base.obligations![0]!] }, /planned twice/],
      ["a frozen split that does not add up", { ...base, legs: [receivable, { ...revenue, frozenTax: { grossCents: 11500, netCents: 10000, taxCents: 1499, taxCode: "X" } }] }, /frozen tax split/],
      ["a linked legacy line no leg posts", { ...base, additionalSources: [{ kind: "BOOKING_LEDGER", id: "line-1", version: "1" }] }, /no leg posts it/],
      ["a blank event key", { ...base, eventKey: " " }, /eventKey is blank/],
    ])("%s", (_case, plan, problem) => {
      expect(problems(plan).join("\n")).toMatch(problem);
    });

    it("an unusable context", () => {
      expect(problems(base, { ...context, currency: "nzd", policyVersion: "" }).join("\n")).toMatch(/ISO 4217[\s\S]*policy and coding/);
    });
  });
});

describe("buildMemberMoneyReversal", () => {
  it("copies every leg with its side swapped under the original's coding", () => {
    const original = buildMemberMoneyBatch(context, charge());
    const reversal = buildMemberMoneyReversal(context, { reversesJournalId: "j1", origin: "OFFICER", reason: "error",
      source: { kind: "OFFICER_FACT", id: "fix-1", version: "1" } },
    { id: "j1", currency: "NZD", policyVersion: "p0", codingVersion: "c0",
      lines: original.lines.map(({ source: _source, originalLineId: _original, ...line }, index) => ({ ...line, id: `line-${index}` })) });
    expect(reversal.event).toMatchObject({ kind: "REVERSAL", eventKey: "reversal:j1" });
    expect(reversal.journal).toEqual({ currency: "NZD", policyVersion: "p0", codingVersion: "c0", reversesJournalId: "j1" });
    expect(reversal.lines.map(({ side, originalLineId, amountCents }) => [side, originalLineId, amountCents]))
      .toEqual([["CREDIT", "line-0", 11500], ["DEBIT", "line-1", 10000], ["DEBIT", "line-2", 1500]]);
  });
});

describe("TAXED_REVENUE_ACCOUNTS", () => {
  it("is exactly the revenue set the database's tax tie reads", () => {
    const migration = readFileSync("prisma/migrations/20261127010000_member_money_journal/migration.sql", "utf8");
    const lists = [...migration.matchAll(/account IN \(('[A-Z_]+'(?:, '[A-Z_]+')*)\)/g)].map((match) => match[1]!.replaceAll("'", "").split(", "));
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) expect(list).toEqual([...TAXED_REVENUE_ACCOUNTS]);
  });
});
