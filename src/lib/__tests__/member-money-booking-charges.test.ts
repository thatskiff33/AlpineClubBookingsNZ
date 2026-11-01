/**
 * The M3b adapter from stored legacy booking-ledger lines to journal batches
 * (#4627). Pure: every plan here is also run through the M3a builder, which
 * refuses an unbalanced or ill-shaped batch before any write. What the database
 * accepts, door by door, is `booking-ledger-journal.realdb.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { bookingChargeIdentity, journalComponentOfLegacyLine, MemberMoneyPlanError, type MemberMoneyPlan } from "@/lib/member-money";
import {
  planBookingChargeEvent,
  planMemberMergeTransfer,
  type BookingChargeEvent,
  type LegacyChargeLine,
} from "@/lib/member-money/internal/booking-charges";
import { componentKey } from "@/lib/member-money/internal/components";
import { buildMemberMoneyBatch } from "@/lib/member-money/internal/plan";
import { memberMoneyTestContext } from "./support/member-money-fixtures";

const BOOKING = "b1";
const LODGE = "l1";
const MEMBER = { kind: "MEMBER", memberId: "m1" } as const;
const CHARGE = bookingChargeIdentity(BOOKING);
const context = memberMoneyTestContext();
let sequence = 0;

function line(overrides: Partial<LegacyChargeLine> & Pick<LegacyChargeLine, "kind" | "amountCents">): LegacyChargeLine {
  sequence += 1;
  return {
    id: `line-${sequence}`,
    bookingId: BOOKING,
    lodgeId: LODGE,
    side: "CHARGE",
    quantity: 1,
    unitCents: Math.abs(overrides.amountCents),
    postingKey: `key-${sequence}`,
    reversesLineId: null,
    reversedPostingKey: null,
    bookingGuestId: overrides.kind === "GUEST_NIGHT" ? "g1" : null,
    night: overrides.kind === "GUEST_NIGHT" ? "2026-08-01" : null,
    ...overrides,
  };
}

const live = (entries: Array<[string, string, number]>) =>
  new Map(entries.map(([account, identity, cents]) => [componentKey(account, identity), cents]));

function plan(event: BookingChargeEvent, lines: LegacyChargeLine[], liveGross = live([])) {
  return planBookingChargeEvent({ bookingId: BOOKING, lodgeId: LODGE, event, debtor: MEMBER, lines, liveGrossCents: liveGross });
}

type Legs = Extract<MemberMoneyPlan, { legs: unknown }>;
const legsOf = (built: MemberMoneyPlan | null) =>
  (built as Legs).legs.map((leg) => [leg.account, leg.side, leg.type === "amount" ? leg.amountCents : leg.grossCents, leg.chargeIdentity ?? null]);

describe("R01: a confirmation's lines (#4627)", () => {
  it("folds the nights and the signed promotion into one component whose gross is the final price", () => {
    const nightA = line({ kind: "GUEST_NIGHT", amountCents: 6000 });
    const nightB = line({ kind: "GUEST_NIGHT", amountCents: 6000 });
    const promo = line({ kind: "PROMOTION", amountCents: -1500, unitCents: 1500 });
    const built = plan({ kind: "confirmation" }, [nightA, nightB, promo]) as Legs;
    expect(built.kind).toBe("CHARGE");
    expect(legsOf(built)).toEqual([
      ["MEMBER_RECEIVABLE", "DEBIT", 6000, null],
      ["MEMBER_RECEIVABLE", "DEBIT", 6000, null],
      ["MEMBER_RECEIVABLE", "CREDIT", 1500, null],
      ["BOOKING_REVENUE", "CREDIT", 10500, CHARGE],
    ]);
    // No separate promotion debit: the only revenue leg is the folded component.
    expect(built.legs.filter((leg) => leg.type === "revenue" && leg.side === "DEBIT")).toEqual([]);
    expect(built.obligations).toEqual([expect.objectContaining({ kind: "CHARGE", faceCents: 10500, debtor: MEMBER })]);
    // Every line is linked, and its receivable leg names it.
    expect(built.additionalSources?.map((source) => source.id)).toEqual([nightA.id, nightB.id, promo.id]);
    expect(built.legs.slice(0, 3).map((leg) => leg.source?.id)).toEqual([nightA.id, nightB.id, promo.id]);
    const batch = buildMemberMoneyBatch(context, built);
    expect(batch.sources.filter((source) => source.kind === "BOOKING_LEDGER")).toHaveLength(3);
  });

  it("posts a fee added to the amount owed as its own fee component, sourced to its line", () => {
    const night = line({ kind: "GUEST_NIGHT", amountCents: 8000 });
    const fee = line({ kind: "CHANGE_FEE", amountCents: 2500, postingKey: "modification:mod1:change-fee" });
    const built = plan({ kind: "confirmation" }, [night, fee]) as Legs;
    const feeLeg = built.legs.find((leg) => leg.account === "FEE_REVENUE");
    expect(feeLeg).toMatchObject({ side: "CREDIT", grossCents: 2500, chargeIdentity: "modification:mod1:change-fee", source: { id: fee.id } });
    expect(built.obligations?.[0]?.faceCents).toBe(10500);
    expect(() => buildMemberMoneyBatch(context, built)).not.toThrow();
  });

  it("posts a booking fully discounted with no revenue and no obligation, every line still bridged", () => {
    const night = line({ kind: "GUEST_NIGHT", amountCents: 5000 });
    const promo = line({ kind: "PROMOTION", amountCents: -5000 });
    const built = plan({ kind: "confirmation" }, [night, promo]) as Legs;
    expect(legsOf(built)).toEqual([["MEMBER_RECEIVABLE", "DEBIT", 5000, null], ["MEMBER_RECEIVABLE", "CREDIT", 5000, null]]);
    expect(built.obligations).toEqual([]);
    expect(() => buildMemberMoneyBatch(context, built)).not.toThrow();
  });

  it("leaves a zero-cent line unlinked and posts nothing for lines with no money", () => {
    const free = line({ kind: "GUEST_NIGHT", amountCents: 0 });
    expect(plan({ kind: "confirmation" }, [free])).toBeNull();
    const paid = line({ kind: "GUEST_NIGHT", amountCents: 4000 });
    const built = plan({ kind: "confirmation" }, [free, paid]) as Legs;
    expect(built.additionalSources?.map((source) => source.id)).toEqual([paid.id]);
  });

  it("names an organisation as the debtor of an organisation-owned booking", () => {
    const organisation = { kind: "ORGANISATION", organisationId: "org1" } as const;
    const built = planBookingChargeEvent({
      bookingId: BOOKING, lodgeId: LODGE, event: { kind: "confirmation" }, debtor: organisation,
      lines: [line({ kind: "GUEST_NIGHT", amountCents: 7000 })], liveGrossCents: new Map(),
    }) as Legs;
    expect(built.legs[0]).toMatchObject({ account: "MEMBER_RECEIVABLE", debtor: organisation });
    expect(built.obligations?.[0]?.debtor).toEqual(organisation);
    expect(() => buildMemberMoneyBatch(context, built)).not.toThrow();
  });
});

describe("R02/R03/R04/R21: later events correct whole components (#4627)", () => {
  it("re-posts an edit as the whole component corrected and the remainder charged", () => {
    const original = line({ kind: "GUEST_NIGHT", amountCents: 10000 });
    const reversal = line({ kind: "GUEST_NIGHT", amountCents: -10000, reversesLineId: original.id });
    const added = line({ kind: "GUEST_NIGHT", amountCents: 12000 });
    const fee = line({ kind: "CHANGE_FEE", amountCents: 2000, postingKey: "modification:mod2:change-fee" });
    const built = plan({ kind: "modification", modificationId: "mod2" }, [reversal, added, fee],
      live([["BOOKING_REVENUE", CHARGE, 30000]])) as Legs;
    expect(built.kind).toBe("ADJUSTMENT");
    expect(built.eventKey).toBe("modification:mod2");
    expect(legsOf(built)).toEqual([
      ["MEMBER_RECEIVABLE", "CREDIT", 10000, null],
      ["MEMBER_RECEIVABLE", "DEBIT", 12000, null],
      ["MEMBER_RECEIVABLE", "DEBIT", 2000, null],
      ["BOOKING_REVENUE", "DEBIT", 30000, CHARGE],
      ["BOOKING_REVENUE", "CREDIT", 32000, CHARGE],
      ["FEE_REVENUE", "CREDIT", 2000, "modification:mod2:change-fee"],
    ]);
    expect(built.obligations).toEqual([]);
    expect(() => buildMemberMoneyBatch(context, built)).not.toThrow();
  });

  it("moves no revenue when an edit's lines net to zero, and still bridges them", () => {
    const reversal = line({ kind: "GUEST_NIGHT", amountCents: -9000, reversesLineId: "old" });
    const added = line({ kind: "GUEST_NIGHT", amountCents: 9000 });
    const built = plan({ kind: "modification", modificationId: "mod3" }, [reversal, added], live([["BOOKING_REVENUE", CHARGE, 9000]]));
    expect(legsOf(built)).toEqual([["MEMBER_RECEIVABLE", "CREDIT", 9000, null], ["MEMBER_RECEIVABLE", "DEBIT", 9000, null]]);
  });

  it("cancels by correcting the stay and a reversed change fee whole, and charges the kept fee", () => {
    const stay = line({ kind: "GUEST_NIGHT", amountCents: -20000, reversesLineId: "n1" });
    const feeBack = line({ kind: "CHANGE_FEE", amountCents: -2000, reversesLineId: "f1", reversedPostingKey: "modification:mod2:change-fee" });
    const kept = line({ kind: "CANCELLATION_FEE", amountCents: 5000, postingKey: "cancellation:b1:fee" });
    const built = plan({ kind: "cancellation" }, [stay, feeBack, kept], live([
      ["BOOKING_REVENUE", CHARGE, 20000], ["FEE_REVENUE", "modification:mod2:change-fee", 2000],
    ])) as Legs;
    expect(built.eventKey).toBe("cancellation:b1:0");
    expect(legsOf(built).filter(([account]) => account !== "MEMBER_RECEIVABLE")).toEqual([
      ["BOOKING_REVENUE", "DEBIT", 20000, CHARGE],
      ["FEE_REVENUE", "DEBIT", 2000, "modification:mod2:change-fee"],
      ["FEE_REVENUE", "CREDIT", 5000, "cancellation:b1:fee"],
    ]);
    expect(() => buildMemberMoneyBatch(context, built)).not.toThrow();
  });

  it("folds an agreed adjustment into the charge component and names the officer on a review close", () => {
    const concession = line({ kind: "AGREED_ADJUSTMENT", side: "ADJUSTMENT", amountCents: -3000, postingKey: "agreed-adjustment:t1" });
    const built = plan({ kind: "review-close", taskId: "t1", officerMemberId: "officer" }, [concession],
      live([["BOOKING_REVENUE", CHARGE, 20000]])) as Legs;
    expect(built).toMatchObject({ eventKey: "review-close:t1", origin: "OFFICER", actorMemberId: "officer",
      source: { kind: "OFFICER_FACT", id: "t1" } });
    expect(legsOf(built)).toEqual([
      ["MEMBER_RECEIVABLE", "CREDIT", 3000, null],
      ["BOOKING_REVENUE", "DEBIT", 20000, CHARGE],
      ["BOOKING_REVENUE", "CREDIT", 17000, CHARGE],
    ]);
  });

  it("refuses lines that would take a component below zero, a settlement line, and another booking's line", () => {
    const refuse = (lines: LegacyChargeLine[], liveGross = live([])) => {
      try {
        plan({ kind: "modification", modificationId: "m" }, lines, liveGross);
      } catch (error) {
        if (error instanceof MemberMoneyPlanError) return error.problems.join("; ");
        throw error;
      }
      return "";
    };
    expect(refuse([line({ kind: "GUEST_NIGHT", amountCents: -5000 })], live([["BOOKING_REVENUE", CHARGE, 4000]]))).toMatch(/would carry -1000/);
    expect(refuse([line({ kind: "CARD_CAPTURE", side: "SETTLEMENT", amountCents: -100 })])).toMatch(/not a charge/);
    expect(refuse([line({ kind: "GUEST_NIGHT", amountCents: 100, bookingId: "other" })])).toMatch(/another booking/);
  });
});

describe("the component rule the census shares (#4627)", () => {
  it("names the folded component, each fee by its key, a fee reversal by its target's, and nothing for settlement", () => {
    expect(journalComponentOfLegacyLine(line({ kind: "PROMOTION", amountCents: -1 }))).toEqual({ account: "BOOKING_REVENUE", chargeIdentity: CHARGE });
    expect(journalComponentOfLegacyLine(line({ kind: "AGREED_ADJUSTMENT", amountCents: 1 }))?.chargeIdentity).toBe(CHARGE);
    expect(journalComponentOfLegacyLine(line({ kind: "CANCELLATION_FEE", amountCents: 1, postingKey: "k" }))).toEqual({ account: "FEE_REVENUE", chargeIdentity: "k" });
    expect(journalComponentOfLegacyLine(line({ kind: "CHANGE_FEE", amountCents: -1, reversesLineId: "x", reversedPostingKey: "fee" }))?.chargeIdentity).toBe("fee");
    expect(journalComponentOfLegacyLine(line({ kind: "BANK_RECEIPT", amountCents: -1 }))).toBeNull();
    expect(() => journalComponentOfLegacyLine(line({ kind: "CHANGE_FEE", amountCents: -1, reversesLineId: "x", reversedPostingKey: null })))
      .toThrow(MemberMoneyPlanError);
  });
});

describe("D4: a member merge's transfer (#4627)", () => {
  it("moves each open receivable balance to the survivor, booking by booking, and posts no revenue", () => {
    const built = planMemberMergeTransfer({
      fromMemberId: "loser", toMemberId: "master", actorMemberId: "admin",
      balances: [{ bookingId: "b1", lodgeId: "l1", cents: 7000 }, { bookingId: "b2", lodgeId: "l1", cents: 0 }],
    }) as Legs;
    expect(built).toMatchObject({ kind: "ADJUSTMENT", eventKey: "merge:loser:master", origin: "OFFICER", actorMemberId: "admin" });
    expect(built.legs.map((leg) => [leg.side, leg.debtor, leg.booking?.bookingId])).toEqual([
      ["CREDIT", { kind: "MEMBER", memberId: "loser" }, "b1"],
      ["DEBIT", { kind: "MEMBER", memberId: "master" }, "b1"],
    ]);
    expect(built.legs.every((leg) => leg.type === "amount")).toBe(true);
    expect(() => buildMemberMoneyBatch(context, built)).not.toThrow();
    expect(planMemberMergeTransfer({ fromMemberId: "a", toMemberId: "b", actorMemberId: "c", balances: [] })).toBeNull();
  });
});
