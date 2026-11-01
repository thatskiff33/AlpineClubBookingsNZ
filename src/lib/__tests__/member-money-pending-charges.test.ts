/**
 * A bank-transfer booking's charge before settlement (#4628, Ledger M3c).
 * Pure: every plan is also run through the M3a builder, which refuses an
 * unbalanced or ill-shaped batch. What the database accepts, door by door, is
 * `booking-ledger-pending-charge.realdb.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { planConfirmationChargeLines, type ConfirmationPostingBooking } from "@/lib/booking-ledger-confirmation-posting";
import { modificationChangeFeePosting } from "@/lib/booking-ledger-modification-posting";
import { ledgerLineAmountCents, type BookingLedgerPosting } from "@/lib/booking-ledger-write";
import { bookingChargeIdentity, MemberMoneyPlanError, type MemberMoneyPlan } from "@/lib/member-money";
import {
  planPendingBookingCharge,
  standingComponentTargets,
  type PendingChargeEvent,
  type StandingChargeLine,
} from "@/lib/member-money/internal/booking-pending-charges";
import { buildMemberMoneyBatch } from "@/lib/member-money/internal/plan";
import { memberMoneyTestContext } from "./support/member-money-fixtures";

const BOOKING = "b1";
const LODGE = "l1";
const MEMBER = { kind: "MEMBER", memberId: "m1" } as const;
const CHARGE = bookingChargeIdentity(BOOKING);
const FEE = "modification:m0:change-fee";
const context = memberMoneyTestContext();

const NIGHT = new Date("2027-08-01T00:00:00.000Z");
const booking = (nightCents: number[], promoAdjustmentCents = 0): ConfirmationPostingBooking => ({
  id: BOOKING,
  lodgeId: LODGE,
  totalPriceCents: nightCents.reduce((sum, cents) => sum + cents, 0),
  promoAdjustmentCents,
  guests: nightCents.map((priceCents, index) => ({
    id: `g${index}`, firstName: "Pending", lastName: `g${index}`, ageTier: "ADULT", rateMembershipTypeId: null,
    nights: [{ stayDate: NIGHT, priceCents }],
  })),
});

/** What the door's legacy side hands the journal: the planned lines, as standing charge lines. */
const standing = (postings: readonly BookingLedgerPosting[]): StandingChargeLine[] => postings.map((posting) => ({
  kind: posting.kind, amountCents: ledgerLineAmountCents(posting), postingKey: posting.postingKey,
  reversesLineId: posting.reversesLineId ?? null, reversedPostingKey: posting.reversesLineId ?? null,
}));

const live = (entries: Array<["BOOKING_REVENUE" | "FEE_REVENUE", string, number]>) =>
  entries.map(([account, chargeIdentity, liveGrossCents]) => ({ account, chargeIdentity, liveGrossCents }));

function plan(event: PendingChargeEvent, lines: StandingChargeLine[], liveComponents = live([])) {
  return planPendingBookingCharge({ bookingId: BOOKING, lodgeId: LODGE, event, debtor: MEMBER, standing: lines, liveComponents });
}

type Legs = Extract<MemberMoneyPlan, { legs: unknown }>;
const legsOf = (built: MemberMoneyPlan | null) => (built as Legs).legs.map((leg) => ({
  account: leg.account, side: leg.side, cents: leg.type === "amount" ? leg.amountCents : leg.grossCents,
  ...(leg.chargeIdentity ? { chargeIdentity: leg.chargeIdentity } : {}),
  ...(leg.obligationKey ? { obligation: leg.obligationKey } : {}),
}));

/** The live components a plan's revenue legs leave, as a door would read them back. */
function liveAfter(built: MemberMoneyPlan | null, before = live([])) {
  const gross = new Map(before.map((component) => [`${component.account}|${component.chargeIdentity}`, component.liveGrossCents]));
  for (const leg of (built as Legs | null)?.legs ?? []) {
    if (leg.type !== "revenue") continue;
    const key = `${leg.account}|${leg.chargeIdentity}`;
    gross.set(key, (gross.get(key) ?? 0) + (leg.side === "CREDIT" ? leg.grossCents : -leg.grossCents));
  }
  return [...gross].map(([key, liveGrossCents]) => {
    const [account, chargeIdentity] = key.split("|") as ["BOOKING_REVENUE" | "FEE_REVENUE", string];
    return { account, chargeIdentity, liveGrossCents };
  });
}

describe("the binding R01 (#4628)", () => {
  it("charges the lines the confirmation would post, folded, as one obligation with one receivable leg", () => {
    const built = plan({ kind: "binding" }, standing(planConfirmationChargeLines(booking([6000, 6000], -1500)).postings));
    expect(built).toMatchObject({ kind: "CHARGE", eventKey: `booking-charge:${BOOKING}`, source: { kind: "BOOKING", id: BOOKING, version: "binding" } });
    expect((built as Legs).obligations).toEqual([expect.objectContaining({ key: `booking-charge:${BOOKING}`, kind: "CHARGE", faceCents: 10500 })]);
    expect(legsOf(built)).toEqual([
      { account: "MEMBER_RECEIVABLE", side: "DEBIT", cents: 10500, obligation: `booking-charge:${BOOKING}` },
      { account: "BOOKING_REVENUE", side: "CREDIT", cents: 10500, chargeIdentity: CHARGE },
    ]);
    expect(() => buildMemberMoneyBatch(context, built!)).not.toThrow();
  });

  it("keeps a fee added to the amount owed a component of its own, keyed as its later legacy line will be", () => {
    const fee = modificationChangeFeePosting({ bookingId: BOOKING, lodgeId: LODGE, bookingModificationId: "m0", changeFeeCents: 2500 });
    const built = plan({ kind: "binding" }, standing([...planConfirmationChargeLines(booking([8000])).postings, fee]));
    expect(legsOf(built)).toEqual([
      { account: "MEMBER_RECEIVABLE", side: "DEBIT", cents: 10500, obligation: `booking-charge:${BOOKING}` },
      { account: "BOOKING_REVENUE", side: "CREDIT", cents: 8000, chargeIdentity: CHARGE },
      { account: "FEE_REVENUE", side: "CREDIT", cents: 2500, chargeIdentity: FEE },
    ]);
    expect(() => buildMemberMoneyBatch(context, built!)).not.toThrow();
  });

  it("posts an explicit ZERO event when nothing is yet owed", () => {
    expect(plan({ kind: "binding" }, standing(planConfirmationChargeLines(booking([0])).postings))).toMatchObject({ kind: "ZERO" });
    expect(plan({ kind: "binding" }, [])).toMatchObject({ kind: "ZERO", eventKey: `booking-charge:${BOOKING}` });
  });
});

describe("a pending charge re-stated before settlement (#4628)", () => {
  it("corrects the whole live component and charges what the edited booking stands at (R02), naming no obligation", () => {
    const built = plan({ kind: "modification", modificationId: "m1" }, standing(planConfirmationChargeLines(booking([6000, 3000])).postings),
      live([["BOOKING_REVENUE", CHARGE, 12000]]));
    expect(built).toMatchObject({ kind: "ADJUSTMENT", eventKey: "modification:m1", obligations: [] });
    expect(legsOf(built)).toEqual([
      { account: "MEMBER_RECEIVABLE", side: "CREDIT", cents: 3000 },
      { account: "BOOKING_REVENUE", side: "DEBIT", cents: 12000, chargeIdentity: CHARGE },
      { account: "BOOKING_REVENUE", side: "CREDIT", cents: 9000, chargeIdentity: CHARGE },
    ]);
    expect(() => buildMemberMoneyBatch(context, built!)).not.toThrow();
  });

  it("posts nothing for an event that leaves every component where it was", () => {
    const lines = standing(planConfirmationChargeLines(booking([6000, 6000])).postings);
    expect(plan({ kind: "modification", modificationId: "m1" }, lines, live([["BOOKING_REVENUE", CHARGE, 12000]]))).toBeNull();
  });

  it("leaves only what the club keeps on a cancellation (R04): the kept fee folded into the charge, a kept change fee standing", () => {
    const lines: StandingChargeLine[] = [
      { kind: "GUEST_NIGHT", amountCents: 12000, postingKey: "n1", reversesLineId: null, reversedPostingKey: null },
      { kind: "CHANGE_FEE", amountCents: 2000, postingKey: FEE, reversesLineId: null, reversedPostingKey: null },
      { kind: "GUEST_NIGHT", amountCents: -12000, postingKey: "reversal:n1", reversesLineId: "n1", reversedPostingKey: "n1" },
      { kind: "CANCELLATION_FEE", amountCents: 3000, postingKey: "cancellation-fee", reversesLineId: null, reversedPostingKey: null },
    ];
    const built = plan({ kind: "cancellation" }, lines, live([["BOOKING_REVENUE", CHARGE, 12000], ["FEE_REVENUE", FEE, 2000]]));
    expect(built).toMatchObject({ kind: "ADJUSTMENT", eventKey: `cancellation:${BOOKING}:0` });
    expect(legsOf(built)).toEqual([
      { account: "MEMBER_RECEIVABLE", side: "CREDIT", cents: 9000 },
      { account: "BOOKING_REVENUE", side: "DEBIT", cents: 12000, chargeIdentity: CHARGE },
      { account: "BOOKING_REVENUE", side: "CREDIT", cents: 3000, chargeIdentity: CHARGE },
    ]);
  });

  it("reverses a change fee the cancellation takes back, by the fee's own identity", () => {
    const lines: StandingChargeLine[] = [
      { kind: "CHANGE_FEE", amountCents: 2000, postingKey: FEE, reversesLineId: null, reversedPostingKey: null },
      { kind: "CHANGE_FEE", amountCents: -2000, postingKey: `reversal:${FEE}`, reversesLineId: FEE, reversedPostingKey: FEE },
    ];
    expect(standingComponentTargets(BOOKING, lines).get(`FEE_REVENUE\u0000${FEE}`)?.grossCents).toBe(0);
    expect(legsOf(plan({ kind: "cancellation" }, lines, live([["FEE_REVENUE", FEE, 2000]])))).toEqual([
      { account: "MEMBER_RECEIVABLE", side: "CREDIT", cents: 2000 },
      { account: "FEE_REVENUE", side: "DEBIT", cents: 2000, chargeIdentity: FEE },
    ]);
  });

  it("refuses a component the planned lines would leave negative, and a line that is not a charge", () => {
    expect(() => plan({ kind: "binding" }, [{ kind: "PROMOTION", amountCents: -500, postingKey: "p", reversesLineId: null, reversedPostingKey: null }]))
      .toThrow(MemberMoneyPlanError);
    expect(() => plan({ kind: "binding" }, [{ kind: "CARD_CAPTURE", amountCents: -500, postingKey: "c", reversesLineId: null, reversedPostingKey: null }]))
      .toThrow(/not a charge/);
  });
});

describe("the confirmation bridge's equality (#4628)", () => {
  it("a confirmation planned from the same rows needs no restatement: its lines are the binding's components", () => {
    const rows = booking([6000, 4500], -1000);
    const r01 = plan({ kind: "binding" }, standing(planConfirmationChargeLines(rows).postings));
    // The legacy confirmation later writes exactly these lines (`planConfirmationPostings`).
    const confirmation = standing(planConfirmationChargeLines(rows).postings);
    expect(plan({ kind: "restatement" }, confirmation, liveAfter(r01))).toBeNull();
  });

  it("restates once, to the confirmation's lines, when a writer moved the price without posting", () => {
    const r01 = plan({ kind: "binding" }, standing(planConfirmationChargeLines(booking([6000, 6000])).postings));
    const built = plan({ kind: "restatement" }, standing(planConfirmationChargeLines(booking([6000, 7000])).postings), liveAfter(r01));
    expect(built).toMatchObject({ kind: "ADJUSTMENT", eventKey: `charge-restatement:${BOOKING}`, obligations: [] });
    expect(legsOf(built)).toEqual([
      { account: "MEMBER_RECEIVABLE", side: "DEBIT", cents: 1000 },
      { account: "BOOKING_REVENUE", side: "DEBIT", cents: 12000, chargeIdentity: CHARGE },
      { account: "BOOKING_REVENUE", side: "CREDIT", cents: 13000, chargeIdentity: CHARGE },
    ]);
    expect(() => buildMemberMoneyBatch(context, built!)).not.toThrow();
  });
});
