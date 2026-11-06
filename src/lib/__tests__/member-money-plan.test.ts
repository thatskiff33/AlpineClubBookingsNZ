/**
 * The posting plan builder, its correction completion, the posting context and
 * event keys (#4626, Ledger M3a). Pure: every case here is refused or built
 * before the store writes a row. What the database then accepts is
 * `member-money-posting.realdb.test.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLUB_TAX_SETTINGS_DEFAULTS } from "@/lib/club-tax-settings";
import { requireClubTimeZone, requireInstant } from "@/lib/club-time";
import {
  memberMoneyEventKeys,
  MemberMoneyPlanError,
  resolveMemberMoneyPostingContext,
  type MemberMoneyPlan,
} from "@/lib/member-money";
import { DEBTOR_ACCOUNTS, TAXED_REVENUE_ACCOUNTS } from "@/lib/member-money/internal/accounts";
import {
  completeMemberMoneyBatch,
  reversalLiveProblems,
  type PostedRevenueLeg,
} from "@/lib/member-money/internal/components";
import { buildMemberMoneyBatch, buildMemberMoneyReversal, type BuiltLine } from "@/lib/member-money/internal/plan";
import type { MemberMoneyTaxSplit } from "@/lib/member-money/internal/tax";
import { UnsupportedChargeCurrencyError } from "@/lib/stripe-charge-currency";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import { CLUB_FORMAT_TEST, CLUB_FORMAT_TEST_OTHER } from "./support/club-format-fixture";
import { bookingChargePlan, MEMBER_MONEY_JOURNAL_MIGRATION, memberMoneyTestContext } from "./support/member-money-fixtures";

const MEMBER = { kind: "MEMBER", memberId: "member-1" } as const;
const context = memberMoneyTestContext();
const charge = (grossCents = 11500) => bookingChargePlan({ eventKey: memberMoneyEventKeys.bookingCharge("b1"), debtor: MEMBER,
  grossCents, booking: { bookingId: "b1", lodgeId: "l1" } });
const legsOf = (lines: readonly BuiltLine[]) => lines.map(({ account, side, amountCents, netCents, taxCents }) => [account, side, amountCents, netCents, taxCents]);
/** A context whose tax setting starts after the frozen clock's date. */
const unavailable = memberMoneyTestContext({ taxSettings: { effectiveFrom: "2027-04-01" as never } });

function problems(plan: MemberMoneyPlan, ctx = context): readonly string[] {
  try {
    buildMemberMoneyBatch(ctx, plan);
  } catch (error) {
    if (error instanceof MemberMoneyPlanError) return error.problems;
    throw error;
  }
  return [];
}

/** An ADJUSTMENT taking component `nights:1` (gross 11500) back off the receivable. */
function correction(frozenTax?: MemberMoneyTaxSplit | "untaxed", grossCents = 11500): MemberMoneyPlan {
  return {
    kind: "ADJUSTMENT", eventKey: memberMoneyEventKeys.modification("m1"), origin: "APP", reason: "reduction",
    source: { kind: "BOOKING", id: "m1", version: "1" },
    legs: [
      { type: "revenue", account: "BOOKING_REVENUE", side: "DEBIT", grossCents, chargeIdentity: "nights:1", frozenTax, evidence: {} },
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: grossCents, debtor: MEMBER, evidence: {} },
    ],
  };
}
const posted = (overrides: Partial<PostedRevenueLeg> = {}): PostedRevenueLeg => ({
  account: "BOOKING_REVENUE", chargeIdentity: "nights:1", side: "CREDIT", amountCents: 10000,
  grossCents: 11500, netCents: 10000, taxCents: 1500, taxCode: "GST_INCLUSIVE_1500BP", bookingId: null, lodgeId: null, ...overrides,
});
function completionProblems(plan: MemberMoneyPlan, legs: PostedRevenueLeg[], ctx = context): readonly string[] {
  try {
    completeMemberMoneyBatch(buildMemberMoneyBatch(ctx, plan), legs);
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
    expect(memberMoneyEventKeys.reviewClose("t1", "l1")).toBe("review-close:t1:l1");
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

  it("is a branded type: a hand-written key does not compile", () => {
    // @ts-expect-error a plan's event key comes only from memberMoneyEventKeys
    const plan: MemberMoneyPlan = { ...charge(), eventKey: "booking-charge:b1" };
    expect(plan.eventKey).toBe("booking-charge:b1");
  });
});

describe("resolveMemberMoneyPostingContext", () => {
  const input = { effectiveAt: requireInstant(FROZEN_TEST_CLOCK_BASE_ISO), zone: requireClubTimeZone("Pacific/Auckland"),
    policyVersion: "p", codingVersion: "c", taxSettings: CLUB_TAX_SETTINGS_DEFAULTS };

  it("takes the currency through the rule card charges use", () => {
    expect(resolveMemberMoneyPostingContext({ ...input, format: CLUB_FORMAT_TEST }).currency).toBe("NZD");
    expect(resolveMemberMoneyPostingContext({ ...input, format: CLUB_FORMAT_TEST_OTHER }).currency).toBe("CHF");
    expect(() => resolveMemberMoneyPostingContext({ ...input, format: { currencyCode: "JPY", locale: "ja-JP" } }))
      .toThrow(UnsupportedChargeCurrencyError);
    expect(() => resolveMemberMoneyPostingContext({ ...input, format: { ...CLUB_FORMAT_TEST, unusableStoredCurrency: "dollars" } }))
      .toThrow(UnsupportedChargeCurrencyError);
  });

  it("records an unavailable tax treatment instead of refusing the context", () => {
    expect(context.tax).toEqual({ status: "known", treatment: { registered: true, rateBasisPoints: 1500, taxCode: "GST_INCLUSIVE_1500BP" } });
    expect(unavailable.tax).toEqual({ status: "unavailable", effectiveFrom: "2027-04-01" });
  });

  it("is a branded type: a literal context does not compile", () => {
    // @ts-expect-error only resolveMemberMoneyPostingContext makes a context
    const literal: Parameters<typeof buildMemberMoneyBatch>[0] = { effectiveAt: new Date(), effectiveDate: "2026-07-01",
      currency: "NZD", policyVersion: "p", codingVersion: "c", tax: { status: "known", treatment: { registered: false } } };
    expect(literal.currency).toBe("NZD");
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

  it("repeats a frozen split on a fresh charge instead of today's rate", () => {
    const plan = charge();
    const batch = buildMemberMoneyBatch(context, { ...plan, legs: [plan.legs[0]!, { ...plan.legs[1]!, type: "revenue",
      account: "BOOKING_REVENUE", grossCents: 11500, frozenTax: { grossCents: 11500, netCents: 10223, taxCents: 1277, taxCode: "GST_INCLUSIVE_1250BP" } }] });
    expect(legsOf(batch.lines).slice(1)).toEqual([["BOOKING_REVENUE", "CREDIT", 10223, 10223, 1277], ["GST_PAYABLE", "CREDIT", 1277, null, null]]);
  });

  it("builds an explicit ZERO event with no legs", () => {
    const batch = buildMemberMoneyBatch(context, { kind: "ZERO", eventKey: memberMoneyEventKeys.reviewClose("t1", "l1"), origin: "APP",
      reason: "no invoice", source: { kind: "SUBSCRIPTION", id: "s1", version: "1" } });
    expect(batch.lines).toEqual([]);
    expect(batch.sources).toEqual([{ kind: "SUBSCRIPTION", id: "s1", version: "1", bookingLedgerLineId: null }]);
  });

  it("hashes economics: order-independent, blind to reason and actor, sensitive to cents and rate", () => {
    const plan = charge();
    const hash = (p: MemberMoneyPlan, ctx = context) => buildMemberMoneyBatch(ctx, p).event.payloadHash;
    expect(hash({ ...plan, legs: [...plan.legs].reverse() })).toBe(hash(plan));
    expect(hash({ ...plan, reason: "other", actorMemberId: "officer-9" })).toBe(hash(plan));
    expect(hash(charge(11600))).not.toBe(hash(plan));
    expect(hash(plan, memberMoneyTestContext({ effectiveAt: "2026-07-02T00:00:00.000Z" }))).not.toBe(hash(plan));
    expect(hash(plan, memberMoneyTestContext({ taxSettings: { taxRateBasisPoints: 1250 } }))).not.toBe(hash(plan));
  });

  describe("with no tax treatment for the date (D3)", () => {
    it("still builds every batch that needs no fresh split", () => {
      expect(buildMemberMoneyBatch(unavailable, { kind: "ZERO", eventKey: memberMoneyEventKeys.reviewClose("t1", "l1"), origin: "APP",
        reason: "z", source: { kind: "BOOKING", id: "b", version: "1" } }).lines).toEqual([]);
      const receipt: MemberMoneyPlan = { kind: "ADJUSTMENT", eventKey: memberMoneyEventKeys.reviewClose("t2", "l1"), origin: "OFFICER",
        reason: "receipt", source: { kind: "OFFICER_FACT", id: "r", version: "1" }, legs: [
          { type: "amount", account: "BANK", side: "DEBIT", amountCents: 500, evidence: {} },
          { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 500, debtor: MEMBER, evidence: {} },
        ] };
      expect(buildMemberMoneyBatch(unavailable, receipt).lines).toHaveLength(2);
      expect(buildMemberMoneyBatch(unavailable, correction()).corrections).toHaveLength(1);
      const plan = charge();
      expect(buildMemberMoneyBatch(unavailable, { ...plan, legs: [plan.legs[0]!, { ...plan.legs[1]!, type: "revenue",
        account: "BOOKING_REVENUE", grossCents: 11500, frozenTax: "untaxed" }] }).lines).toHaveLength(2);
    });

    it("refuses a revenue leg that needs a fresh split", () => {
      expect(problems(charge(), unavailable).join("\n")).toMatch(/needs a fresh tax split, but the club's tax setting starts on 2027-04-01/);
    });
  });

  describe("refuses before any write", () => {
    const base = charge();
    const [receivable, revenue] = base.legs as [Extract<typeof base.legs[number], { type: "amount" }>, Extract<typeof base.legs[number], { type: "revenue" }>];

    it.each<[string, MemberMoneyPlan, RegExp]>([
      ["a dropped balancing leg", { ...base, legs: [receivable] }, /at least two legs|do not balance/],
      ["unbalanced cents", { ...base, legs: [{ ...receivable, amountCents: 11499 }, revenue] }, /debits less credits is -0\.01/],
      ["non-integer cents", { ...base, legs: [{ ...receivable, amountCents: 11500.5 }, revenue] }, /positive integer cents/],
      ["zero cents", { ...base, legs: [{ ...receivable, amountCents: 0 }, revenue] }, /positive integer cents/],
      ["a receivable with no debtor", { ...base, legs: [{ ...receivable, debtor: undefined, obligationKey: undefined }, revenue] }, /needs a debtor/],
      ["revenue posted as a plain amount", { ...base, legs: [receivable, { ...receivable, account: "BOOKING_REVENUE" as never, side: "CREDIT" }] }, /only the builder splits tax/],
      ["GST posted by hand", { ...base, legs: [receivable, { ...receivable, account: "GST_PAYABLE" as never, side: "CREDIT" }] }, /only the builder splits tax/],
      ["a credit leg with no lot", { ...base, legs: [receivable, { ...receivable, account: "MEMBER_CREDIT", side: "CREDIT", obligationKey: undefined }] }, /credit lot/],
      ["a refund-payable leg with no obligation", { ...base, legs: [receivable, { ...receivable, account: "REFUND_PAYABLE", side: "CREDIT", obligationKey: undefined }] }, /needs an obligation/],
      ["a leg naming another debtor than its obligation", { ...base, legs: [{ ...receivable, debtor: { kind: "MEMBER", memberId: "member-2" } }, revenue] }, /other than obligation/],
      ["an obligation planned twice", { ...base, obligations: [base.obligations![0]!, base.obligations![0]!] }, /planned twice/],
      ["an obligation face its receivable legs do not post", { ...base, obligations: [{ ...base.obligations![0]!, faceCents: 11000 }] }, /face is not the MEMBER_RECEIVABLE its legs post here \(115\.00\)/],
      ["a frozen split that does not add up", { ...base, legs: [receivable, { ...revenue, frozenTax: { grossCents: 11500, netCents: 10000, taxCents: 1499, taxCode: "X" } }] }, /frozen tax split/],
      ["a revenue correction naming no component", { ...base, legs: [receivable, { ...revenue, side: "DEBIT", chargeIdentity: undefined }] }, /must name the posted component/],
      ["a linked legacy line no leg posts", { ...base, additionalSources: [{ kind: "BOOKING_LEDGER", id: "line-1", version: "1" }] }, /no leg posts it/],
      ["a blank reason", { ...base, reason: " " }, /reason is blank/],
    ])("%s", (_case, plan, problem) => {
      expect(problems(plan).join("\n")).toMatch(problem);
    });

    it("an obligation whose refund-payable legs net to its face is accepted", () => {
      const refund: MemberMoneyPlan = { kind: "ADJUSTMENT", eventKey: memberMoneyEventKeys.reviewClose("t3", "l1"), origin: "APP",
        reason: "refund owed", source: { kind: "REFUND", id: "rf", version: "1" },
        obligations: [{ key: "refund:rf", kind: "REFUND", debtor: MEMBER, faceCents: 800, evidence: {} }],
        legs: [
          { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 800, debtor: MEMBER, evidence: {} },
          { type: "amount", account: "REFUND_PAYABLE", side: "CREDIT", amountCents: 800, debtor: MEMBER, obligationKey: "refund:rf", evidence: {} },
        ] };
      expect(problems(refund)).toEqual([]);
    });

    it("an unusable context", () => {
      expect(problems(base, { ...context, currency: "nzd", policyVersion: "" }).join("\n")).toMatch(/ISO 4217[\s\S]*policy and coding/);
    });
  });
});

describe("corrections repeat the split their component was posted with", () => {
  it("leaves the correction for the store to complete, and completes it from the posted legs", () => {
    const draft = buildMemberMoneyBatch(context, correction());
    expect(draft.lines.map((line) => line.account)).toEqual(["MEMBER_RECEIVABLE"]);
    expect(draft.corrections).toHaveLength(1);
    const complete = completeMemberMoneyBatch(draft, [posted()]);
    expect(legsOf(complete.lines)).toEqual([
      ["MEMBER_RECEIVABLE", "CREDIT", 11500, null, null],
      ["BOOKING_REVENUE", "DEBIT", 10000, 10000, 1500],
      ["GST_PAYABLE", "DEBIT", 1500, null, null],
    ]);
    expect(complete.event.payloadHash).toBe(draft.event.payloadHash);
  });

  it("uses the posted split, not the context's rate", () => {
    const at1250 = memberMoneyTestContext({ taxSettings: { taxRateBasisPoints: 1250 } });
    expect(legsOf(completeMemberMoneyBatch(buildMemberMoneyBatch(at1250, correction()), [posted()]).lines).slice(1))
      .toEqual([["BOOKING_REVENUE", "DEBIT", 10000, 10000, 1500], ["GST_PAYABLE", "DEBIT", 1500, null, null]]);
  });

  it("corrects an untaxed component without tax fields", () => {
    const untaxedLeg = posted({ amountCents: 11500, grossCents: null, netCents: null, taxCents: null, taxCode: null });
    expect(legsOf(completeMemberMoneyBatch(buildMemberMoneyBatch(context, correction()), [untaxedLeg]).lines).slice(1))
      .toEqual([["BOOKING_REVENUE", "DEBIT", 11500, null, null]]);
  });

  it("accepts a frozen split equal to the posted one", () => {
    expect(completionProblems(correction({ grossCents: 11500, netCents: 10000, taxCents: 1500, taxCode: "GST_INCLUSIVE_1500BP" }), [posted()])).toEqual([]);
  });

  it.each<[string, MemberMoneyPlan, PostedRevenueLeg[], RegExp]>([
    ["a component never posted", correction(), [], /no posted BOOKING_REVENUE leg/],
    ["part of a component", correction(undefined, 5000), [posted()], /takes a whole component: nights:1 still carries 115\.00, not 50\.00/],
    ["a component already corrected", correction(), [posted(), posted({ side: "DEBIT" })], /still carries 0\.00/],
    ["a component posted under two treatments", correction(), [posted({ amountCents: 5000, grossCents: 5750, netCents: 5000, taxCents: 750 }),
      posted({ amountCents: 5111, grossCents: 5750, netCents: 5111, taxCents: 639, taxCode: "GST_INCLUSIVE_1250BP" })], /carries money under more than one tax treatment/],
    ["a frozen split other than the posted one", correction({ grossCents: 11500, netCents: 10223, taxCents: 1277, taxCode: "GST_INCLUSIVE_1250BP" }),
      [posted()], /not the split it was posted with/],
    ["untaxed given for a taxed component", correction("untaxed"), [posted()], /not the split it was posted with/],
  ])("refuses %s", (_case, plan, legs, problem) => {
    expect(completionProblems(plan, legs).join("\n")).toMatch(problem);
  });

  it("corrects a component re-charged at a new rate after a full correction, at the new rate", () => {
    const recharged = [posted(), posted({ side: "DEBIT" }),
      posted({ amountCents: 10222, grossCents: 11500, netCents: 10222, taxCents: 1278, taxCode: "GST_INCLUSIVE_1250BP" })];
    expect(legsOf(completeMemberMoneyBatch(buildMemberMoneyBatch(context, correction()), recharged).lines).slice(1))
      .toEqual([["BOOKING_REVENUE", "DEBIT", 10222, 10222, 1278], ["GST_PAYABLE", "DEBIT", 1278, null, null]]);
  });

  it("refuses a correction naming another booking than its component, or a component whose legs disagree", () => {
    const onBooking = posted({ bookingId: "b1", lodgeId: "l1" });
    expect(completionProblems(correction(), [onBooking]).join("\n")).toMatch(/names a different booking or lodge/);
    expect(completionProblems(correction(), [posted({ amountCents: 5000, grossCents: 5750, netCents: 5000, taxCents: 750 }),
      posted({ amountCents: 5000, grossCents: 5750, netCents: 5000, taxCents: 750, bookingId: "b2", lodgeId: "l1" })]).join("\n"))
      .toMatch(/disagree on its booking or lodge/);
  });

  it("refuses correcting one component twice in a plan", () => {
    const plan = correction() as Extract<MemberMoneyPlan, { legs: unknown }>;
    expect(problems({ ...plan, legs: [plan.legs[0]!, plan.legs[0]!, plan.legs[1]!, plan.legs[1]!] }).join("\n")).toMatch(/corrects component nights:1 twice/);
  });
});

describe("buildMemberMoneyReversal", () => {
  it("copies every leg with its side swapped under the original's coding, keyed by the journal", () => {
    const original = buildMemberMoneyBatch(context, charge());
    const reversal = buildMemberMoneyReversal(context, { reversesJournalId: "j1", origin: "OFFICER", reason: "error",
      source: { kind: "OFFICER_FACT", id: "fix-1", version: "1" } },
    { id: "j1", currency: "NZD", policyVersion: "p0", codingVersion: "c0",
      lines: original.lines.map((line, index) => ({ ...line, source: undefined, originalLineId: undefined, id: `line-${index}` })) });
    expect(reversal.event).toMatchObject({ kind: "REVERSAL", eventKey: "reversal:j1" });
    expect(reversal.journal).toEqual({ currency: "NZD", policyVersion: "p0", codingVersion: "c0", reversesJournalId: "j1" });
    expect(reversal.lines.map(({ side, originalLineId, amountCents }) => [side, originalLineId, amountCents]))
      .toEqual([["CREDIT", "line-0", 11500], ["DEBIT", "line-1", 10000], ["DEBIT", "line-2", 1500]]);
  });
});

describe("an exact reversal needs the components it undoes unchanged", () => {
  const journal = (side: "CREDIT" | "DEBIT") => ({ lines: [
    { ...posted({ side }), debtorKind: null, memberId: null, organisationId: null, obligationKey: null, creditLotId: null,
      refundIdentity: null, evidence: {}, id: "l-rev" },
    { account: "GST_PAYABLE" as const, side, amountCents: 1500, chargeIdentity: "nights:1", grossCents: null, netCents: null,
      taxCents: null, taxCode: null, bookingId: null, lodgeId: null, debtorKind: null, memberId: null, organisationId: null,
      obligationKey: null, creditLotId: null, refundIdentity: null, evidence: {}, id: "l-gst" },
  ] });

  it("allows a charge whose component is untouched, and a correction whose component was not charged again", () => {
    expect(reversalLiveProblems(journal("CREDIT"), [posted()])).toEqual([]);
    expect(reversalLiveProblems(journal("DEBIT"), [posted(), posted({ side: "DEBIT" })])).toEqual([]);
  });

  it("allows a correction with a remainder charge in the same batch, whether the remainder is smaller or larger", () => {
    for (const remainder of [5750, 15000]) {
      const mixed = { lines: [
        ...journal("DEBIT").lines,
        { ...journal("CREDIT").lines[0]!, amountCents: remainder, grossCents: remainder, netCents: remainder, taxCents: 0, id: "l-rem" },
      ] };
      const live = [posted(), posted({ side: "DEBIT" }), posted({ amountCents: remainder, grossCents: remainder, netCents: remainder, taxCents: 0 })];
      expect(reversalLiveProblems(mixed, live), String(remainder)).toEqual([]);
      // The remainder corrected since: refused.
      const corrected = [...live, posted({ side: "DEBIT", amountCents: remainder, grossCents: remainder, netCents: remainder, taxCents: 0 })];
      expect(reversalLiveProblems(mixed, corrected).join("\n")).toMatch(/has changed since/);
    }
  });

  it("refuses a charge corrected since, and a correction whose component was charged again", () => {
    expect(reversalLiveProblems(journal("CREDIT"), [posted(), posted({ side: "DEBIT" })]).join("\n"))
      .toMatch(/nights:1 has changed since this journal posted it \(it carries 0\.00, not 115\.00\)/);
    expect(reversalLiveProblems(journal("DEBIT"), [posted(), posted({ side: "DEBIT" }), posted()]).join("\n"))
      .toMatch(/has changed since/);
  });
});

describe("account rules come from the registry and match the database", () => {
  const migration = readFileSync(MEMBER_MONEY_JOURNAL_MIGRATION, "utf8");
  const quoted = (list: string) => list.replaceAll("'", "").split(", ");

  it("taxed revenue is exactly the set the database's tax tie reads", () => {
    const lists = [...migration.matchAll(/account IN \(('[A-Z_]+'(?:, '[A-Z_]+')*)\)/g)].map((match) => quoted(match[1]!));
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) expect(list).toEqual([...TAXED_REVENUE_ACCOUNTS]);
  });

  it("debtor accounts are exactly the set member_money_line_shape requires a debtor for", () => {
    const shape = /ADD CONSTRAINT "member_money_line_shape" CHECK \(([\s\S]*?)\n\);/.exec(migration)?.[1] ?? "";
    const list = /account NOT IN \(('[A-Z_]+'(?:, '[A-Z_]+')*)\) OR "debtorKind" IS NOT NULL/.exec(shape)?.[1];
    expect(list, "the CHECK's debtor clause").toBeDefined();
    expect(quoted(list!).sort()).toEqual([...DEBTOR_ACCOUNTS].sort());
  });
});
