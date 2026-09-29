/**
 * The edit planner (#3582): per guest-night, from the edit's own before and
 * after, reversing the LIVE line and never one already reversed, and posting
 * nothing unless the lines add up to what the edit moved.
 */
import { describe, expect, it } from "vitest";

import { bookingLedgerBalance } from "@/lib/booking-ledger-balance";
import { planConfirmationChargeLines } from "@/lib/booking-ledger-confirmation-posting";
import {
  liveChargeLines,
  planAgreedAdjustmentLine,
  planModificationChargeLines,
  pricingSideFromLiveLedger,
  type ModificationPostingInput,
  type PostedChargeLine,
} from "@/lib/booking-ledger-modification-posting";
import { ledgerLineAmountCents, type BookingLedgerPosting } from "@/lib/booking-ledger-write";
import type { ModificationPricingSide } from "@/lib/booking-modification-lines";

const D1 = new Date("2026-08-01T00:00:00.000Z");
const D2 = new Date("2026-08-02T00:00:00.000Z");
const D3 = new Date("2026-08-03T00:00:00.000Z");

type Guest = ModificationPricingSide["guests"][number];

function guest(id: string, nights: Array<[Date, number]>, over: Partial<Guest> = {}): Guest {
  return {
    guestKey: id,
    ageTier: "ADULT",
    isMember: true,
    rateMembershipTypeId: "rate-m",
    name: `Guest ${id}`,
    nights: nights.map(([stayDate, priceCents]) => ({ stayDate, priceCents, priceSource: "SOLD" as const })),
    ...over,
  };
}

function side(guests: Guest[], promoAdjustmentCents = 0): ModificationPricingSide {
  return { guests, promoAdjustmentCents };
}

/** Posted lines as the ledger would hold them, with an id per line. */
function asPosted(postings: readonly BookingLedgerPosting[]): PostedChargeLine[] {
  return postings
    .filter((p) => p.kind === "GUEST_NIGHT" || p.kind === "PROMOTION")
    .map((p) => ({
      id: `line:${p.postingKey}`,
      kind: p.kind as "GUEST_NIGHT" | "PROMOTION",
      sign: p.sign,
      quantity: p.quantity,
      unitCents: p.unitCents,
      bookingGuestId: p.bookingGuestId ?? null,
      nightStart: p.nightStart ?? null,
      nightEndExclusive: p.nightEndExclusive ?? null,
      rateMembershipTypeId: p.rateMembershipTypeId ?? null,
      ageTier: p.ageTier ?? null,
      guestNames: [...(p.guestNames ?? [])],
      narration: p.narration,
      // Already a line id: the planner names the reversed line by its id.
      reversesLineId: p.reversesLineId ?? null,
    }));
}

/** A booking confirmed on the ledger: two adults, two nights each, at $50, promo -$20. */
function confirmed(promo = -2_000) {
  const plan = planConfirmationChargeLines({
    id: "b1",
    lodgeId: "l1",
    totalPriceCents: 20_000,
    promoAdjustmentCents: promo,
    guests: ["g1", "g2"].map((id) => ({
      id,
      firstName: "Guest",
      lastName: id,
      ageTier: "ADULT" as const,
      rateMembershipTypeId: "rate-m",
      nights: [
        { stayDate: D1, priceCents: 5_000 },
        { stayDate: D2, priceCents: 5_000 },
      ],
    })),
  });
  return plan.postings;
}

const BEFORE = side([guest("g1", [[D1, 5_000], [D2, 5_000]]), guest("g2", [[D1, 5_000], [D2, 5_000]])], -2_000);

function input(over: Partial<ModificationPostingInput>): ModificationPostingInput {
  return {
    bookingId: "b1",
    lodgeId: "l1",
    bookingModificationId: "m1",
    before: BEFORE,
    after: BEFORE,
    changeFeeCents: 0,
    expectedCents: 0,
    postedLines: asPosted(confirmed()),
    ...over,
  };
}

function sum(postings: readonly BookingLedgerPosting[]): number {
  return postings.reduce((total, p) => total + ledgerLineAmountCents(p), 0);
}

describe("planModificationChargeLines — an edit's own lines, per guest-night (#3582)", () => {
  it("reverses each removed night's live line, anchored on the modification, and sums to the edit's delta", () => {
    const after = side([guest("g1", [[D1, 5_000], [D2, 5_000]])], -2_000);
    const plan = planModificationChargeLines(input({ after, expectedCents: -10_000 }));
    expect(plan.kind).toBe("lines");
    if (plan.kind !== "lines") return;
    expect(plan.postings).toHaveLength(2);
    for (const posting of plan.postings) {
      expect(posting).toMatchObject({
        kind: "GUEST_NIGHT",
        sign: -1,
        unitCents: 5_000,
        bookingGuestId: "g2",
        anchorKind: "MODIFICATION",
        anchorId: "m1",
      });
      expect(posting.postingKey).toBe(`reversal:${posting.reversesLineId}`);
    }
    expect(plan.postings.map((p) => p.reversesLineId)).toEqual([
      "line:confirmation:b1:night:g2:2026-08-01",
      "line:confirmation:b1:night:g2:2026-08-02",
    ]);
    expect(sum(plan.postings)).toBe(-10_000);
  });

  it("posts a fresh GUEST_NIGHT per added night, keyed on the modification, in the after shape", () => {
    const after = side(
      [...BEFORE.guests, guest("g3", [[D1, 3_000]], { ageTier: "CHILD", rateMembershipTypeId: "rate-c", name: "Kid" })],
      -2_000,
    );
    const plan = planModificationChargeLines(input({ after, expectedCents: 3_000 }));
    expect(plan).toEqual({
      kind: "lines",
      postings: [
        expect.objectContaining({
          kind: "GUEST_NIGHT",
          sign: 1,
          unitCents: 3_000,
          bookingGuestId: "g3",
          ageTier: "CHILD",
          rateMembershipTypeId: "rate-c",
          guestNames: ["Kid"],
          nightStart: D1,
          nightEndExclusive: D2,
          postingKey: "modification:m1:night:g3:2026-08-01",
        }),
      ],
    });
  });

  it("reprices a night as a reversal plus a re-post, never a netted delta", () => {
    const after = side([guest("g1", [[D1, 5_000], [D2, 6_000]]), guest("g2", [[D1, 5_000], [D2, 5_000]])], -2_000);
    const plan = planModificationChargeLines(input({ after, expectedCents: 1_000 }));
    if (plan.kind !== "lines") throw new Error(plan.reason);
    expect(plan.postings.map((p) => [p.sign, p.unitCents, p.postingKey])).toEqual([
      [-1, 5_000, "reversal:line:confirmation:b1:night:g1:2026-08-02"],
      [1, 6_000, "modification:m1:night:g1:2026-08-02"],
    ]);
  });

  it("re-sells every night of a guest whose category moved, even at the same price", () => {
    const after = side([guest("g1", [[D1, 5_000], [D2, 5_000]], { isMember: false }), BEFORE.guests[1]!], -2_000);
    const plan = planModificationChargeLines(input({ after, expectedCents: 0 }));
    if (plan.kind !== "lines") throw new Error(plan.reason);
    expect(plan.postings).toHaveLength(4);
    expect(sum(plan.postings)).toBe(0);
  });

  it("reverses the live promotion and re-posts what it now comes to", () => {
    const after = side(BEFORE.guests.slice(0, 1), -1_000);
    const plan = planModificationChargeLines(input({ after, expectedCents: -10_000 + 1_000 }));
    if (plan.kind !== "lines") throw new Error(plan.reason);
    const promos = plan.postings.filter((p) => p.kind === "PROMOTION");
    expect(promos.map((p) => [p.sign, p.unitCents, p.postingKey])).toEqual([
      [1, 2_000, "reversal:line:confirmation:b1:promotion"],
      [-1, 1_000, "modification:m1:promotion"],
    ]);
  });

  it("posts a CHANGE_FEE when the edit charged one, and sums to priceDiff + fee", () => {
    const after = side([guest("g1", [[D2, 5_000], [D3, 5_000]]), guest("g2", [[D2, 5_000], [D3, 5_000]])], -2_000);
    const plan = planModificationChargeLines(input({ after, changeFeeCents: 1_500, expectedCents: 0 + 1_500 }));
    if (plan.kind !== "lines") throw new Error(plan.reason);
    expect(plan.postings.find((p) => p.kind === "CHANGE_FEE")).toMatchObject({
      sign: 1,
      unitCents: 1_500,
      postingKey: "modification:m1:change-fee",
    });
    expect(sum(plan.postings)).toBe(1_500);
  });

  it("posts nothing unless the lines sum to the edit's own figure", () => {
    const after = side(BEFORE.guests.slice(0, 1), -2_000);
    expect(planModificationChargeLines(input({ after, expectedCents: -9_999 }))).toEqual({
      kind: "none",
      reason: "SUM_MISMATCH",
      plannedCents: -10_000,
    });
  });

  it("posts nothing for a removed night with no live line (an earlier edit that posted nothing)", () => {
    const after = side(BEFORE.guests.slice(0, 1), -2_000);
    const postedLines = asPosted(confirmed()).filter((line) => line.bookingGuestId !== "g2");
    expect(planModificationChargeLines(input({ after, expectedCents: -10_000, postedLines }))).toEqual({
      kind: "none",
      reason: "NO_LIVE_LINE",
    });
  });

  it("posts nothing where the live line is not the price the edit says it gave back", () => {
    const before = side([guest("g1", [[D1, 5_000], [D2, 5_000]]), guest("g2", [[D1, 4_000], [D2, 6_000]])], -2_000);
    const after = side(BEFORE.guests.slice(0, 1), -2_000);
    expect(planModificationChargeLines(input({ before, after, expectedCents: -10_000 }))).toEqual({
      kind: "none",
      reason: "LIVE_LINE_DISAGREES",
    });
  });

  it("posts nothing where the ledger's live promotion is not the one the edit started from", () => {
    const after = side(BEFORE.guests.slice(0, 1), -1_000);
    const postedLines = asPosted(confirmed(-3_000));
    expect(planModificationChargeLines(input({ after, expectedCents: -9_000, postedLines }))).toEqual({
      kind: "none",
      reason: "LIVE_PROMOTION_DISAGREES",
    });
  });

  it("posts nothing where two live lines claim the same night", () => {
    const posted = asPosted(confirmed());
    const twin = { ...posted.find((l) => l.bookingGuestId === "g2")!, id: "line:twin" };
    const after = side(BEFORE.guests.slice(0, 1), -2_000);
    expect(planModificationChargeLines(input({ after, expectedCents: -10_000, postedLines: [...posted, twin] }))).toEqual({
      kind: "none",
      reason: "AMBIGUOUS_LIVE_LINE",
    });
  });

  it("posts nothing for an added night the ledger already charges — never the same night twice", () => {
    // The edit's before side does not know g2, but the ledger does.
    const before = side(BEFORE.guests.slice(0, 1), -2_000);
    expect(planModificationChargeLines(input({ before, after: BEFORE, expectedCents: 10_000 }))).toEqual({
      kind: "none",
      reason: "NIGHT_ALREADY_LIVE",
    });
  });

  it("refuses a negative change fee rather than posting a line the door would refuse", () => {
    expect(planModificationChargeLines(input({ changeFeeCents: -1, expectedCents: -1 }))).toEqual({
      kind: "none",
      reason: "INVALID_CHANGE_FEE",
    });
  });

  it("refuses an unpriced or inexactly-sourced night exactly as the stored lines do (one differ)", () => {
    const unpriced = side([guest("g1", [[D1, 5_000]]), { ...guest("g2", []), nights: [{ stayDate: D1, priceCents: null }] }]);
    expect(planModificationChargeLines(input({ before: unpriced, expectedCents: 0 })).kind).toBe("none");
    const inexact = side([
      guest("g1", [[D1, 5_000], [D2, 5_000]]),
      { ...guest("g2", []), nights: [{ stayDate: D1, priceCents: 5_000, priceSource: "EVEN_SPLIT" as const }, { stayDate: D2, priceCents: 5_000, priceSource: "SOLD" as const }] },
    ], -2_000);
    expect(
      planModificationChargeLines(input({ before: inexact, after: side(BEFORE.guests.slice(0, 1), -2_000), expectedCents: -10_000 })),
    ).toEqual({ kind: "none", reason: "INEXACT_STORED_NIGHT_PRICE" });
  });

  it("TWO EDITS: the second reverses the first edit's re-post, never the line the first already reversed", () => {
    // Edit 1 reprices g1's second night from $50 to $60.
    const after1 = side([guest("g1", [[D1, 5_000], [D2, 6_000]]), BEFORE.guests[1]!], -2_000);
    const first = planModificationChargeLines(input({ after: after1, expectedCents: 1_000 }));
    if (first.kind !== "lines") throw new Error(first.reason);
    const ledgerAfterEdit1 = asPosted([...confirmed(), ...first.postings]);

    // Edit 2 removes g1 altogether.
    const second = planModificationChargeLines(
      input({
        bookingModificationId: "m2",
        before: after1,
        after: side([BEFORE.guests[1]!], -2_000),
        expectedCents: -11_000,
        postedLines: ledgerAfterEdit1,
      }),
    );
    if (second.kind !== "lines") throw new Error(second.reason);
    const reversed = second.postings.map((p) => p.reversesLineId);
    expect(reversed).toContain("line:modification:m1:night:g1:2026-08-02");
    expect(reversed).not.toContain("line:confirmation:b1:night:g1:2026-08-02");
    // Every line is reversed at most once across both edits, and the ledger
    // charges exactly what is left: g2's two nights less the promotion.
    const all = asPosted([...confirmed(), ...first.postings, ...second.postings]);
    const targets = all.flatMap((l) => (l.reversesLineId ? [l.reversesLineId] : []));
    expect(new Set(targets).size).toBe(targets.length);
    expect(liveChargeLines(all).reduce((s, l) => s + l.sign * l.unitCents * l.quantity, 0)).toBe(10_000 - 2_000);
  });
});

describe("a review closure's before, read from the ledger (#3582)", () => {
  it("re-prices a parked removal: the departed guest's live nights reversed, summing to the re-base's movement", () => {
    const postedLines = asPosted(confirmed());
    const before = pricingSideFromLiveLedger(postedLines, [{ id: "g1", isMember: true }], -2_000);
    expect(before?.guests.map((g) => g.guestKey).sort()).toEqual(["g1", "g2"]);
    const plan = planModificationChargeLines(
      input({
        bookingModificationId: "rebase-1",
        before: before!,
        after: side([{ ...guest("g1", [[D1, 5_000], [D2, 5_000]]), nights: [{ stayDate: D1, priceCents: 5_000 }, { stayDate: D2, priceCents: 5_000 }] }], -1_000),
        expectedCents: 9_000 - 18_000,
        postedLines,
      }),
    );
    if (plan.kind !== "lines") throw new Error(plan.reason);
    expect(plan.postings.every((p) => p.anchorId === "rebase-1")).toBe(true);
    expect(sum(plan.postings)).toBe(-9_000);
  });

  it("cannot state a before from a live line at any grain but one night", () => {
    const [first, ...rest] = asPosted(confirmed());
    const wide = { ...first!, quantity: 2, nightEndExclusive: D3 };
    expect(pricingSideFromLiveLedger([wide, ...rest], [], -2_000)).toBeNull();
  });
});

describe("planAgreedAdjustmentLine (#3582, §5.3)", () => {
  it("signs by direction, names the officer, narrates the note, and keys on the task", () => {
    const base = { bookingId: "b1", lodgeId: "l1", manualRefundTaskId: "t1", amountCents: 4_000, note: "Goodwill", officerMemberId: "o1" };
    expect(planAgreedAdjustmentLine({ ...base, direction: "CHARGE_TO_MEMBER" })).toMatchObject({
      side: "ADJUSTMENT",
      kind: "AGREED_ADJUSTMENT",
      sign: 1,
      anchorKind: "REVIEW_TASK",
      anchorId: "t1",
      postedByMemberId: "o1",
      narration: "Adjustment agreed with member: Goodwill",
      postingKey: "agreed-adjustment:t1",
    });
    const refund = planAgreedAdjustmentLine({ ...base, direction: "REFUND_TO_MEMBER" });
    expect(bookingLedgerBalance([{ side: refund.side, amountCents: ledgerLineAmountCents(refund) }]).adjustedCents).toBe(-4_000);
  });
});
