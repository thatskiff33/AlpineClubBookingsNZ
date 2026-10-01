/**
 * Posting an edit's lines and a review closure's (#3582), against a mocked
 * store: who posts, who does not, and — one fixture per direction — that a
 * closure's re-price and its agreed share never both record the same money.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: log }));

import { bookingLedgerBalance } from "@/lib/booking-ledger-balance";
import { planConfirmationChargeLines } from "@/lib/booking-ledger-confirmation-posting";
import {
  postModificationLedgerLines,
  postReviewClosureLedgerLines,
} from "@/lib/booking-ledger-modification-sync";
import { buildBookingLedgerRows } from "@/lib/booking-ledger-write";
import type { BookingPriceRebase } from "@/lib/booking-review-price-rebase";

const D1 = new Date("2026-08-01T00:00:00.000Z");
const D2 = new Date("2026-08-02T00:00:00.000Z");

type Row = ReturnType<typeof buildBookingLedgerRows>[number] & { id: string };

/** A booking confirmed on the ledger: two adults, two nights each at $50, paid $200 by card. */
function confirmedLedger(): Row[] {
  const plan = planConfirmationChargeLines({
    id: "b1",
    lodgeId: "l1",
    totalPriceCents: 20_000,
    promoAdjustmentCents: 0,
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
  const capture = buildBookingLedgerRows([
    {
      bookingId: "b1",
      lodgeId: "l1",
      side: "SETTLEMENT",
      kind: "CARD_CAPTURE",
      sign: 1,
      quantity: 1,
      unitCents: 20_000,
      anchorKind: "PAYMENT_TRANSACTION",
      anchorId: "txn-1",
      settlementMethod: "CARD",
      narration: "Card payment",
      postingKey: "capture:txn-1",
    },
  ]);
  return [...buildBookingLedgerRows(plan.postings), ...capture].map((row) => ({ ...row, id: `line:${row.postingKey}` }));
}

function store(ledger: Row[], guests: unknown[] = []) {
  const written: Row[] = [];
  const createMany = vi.fn(async ({ data }: { data: Row[] }) => {
    written.push(...data.map((row) => ({ ...row, id: `line:${row.postingKey}` })));
    return { count: data.length };
  });
  return {
    written,
    createMany,
    store: {
      bookingLedgerLine: {
        findFirst: vi.fn(async ({ where }: { where: { anchorKind: string } }) =>
          ledger.find((row) => row.anchorKind === where.anchorKind) ? { id: "x" } : null,
        ),
        findMany: vi.fn(async ({ where }: { where: { kind: { in: string[] } } }) =>
          ledger
            .filter((row) => where.kind.in.includes(row.kind))
            .map((row) => ({ ...row, reversesLineId: row.reversesLineId ?? null })),
        ),
        createMany,
      },
      bookingGuest: { findMany: vi.fn(async () => guests) },
    } as never,
  };
}

function owed(lines: readonly Row[]): number {
  return bookingLedgerBalance(lines).owedCents;
}

const G1_AFTER = {
  id: "g1",
  firstName: "Guest",
  lastName: "g1",
  ageTier: "ADULT" as const,
  isMember: true,
  rateMembershipTypeId: "rate-m",
  nights: [
    { stayDate: D1, priceCents: 5_000 },
    { stayDate: D2, priceCents: 5_000 },
  ],
};

function rebase(previousFinal: number, newFinal: number): BookingPriceRebase {
  return {
    previousTotalPriceCents: previousFinal,
    previousDiscountCents: 0,
    previousPromoAdjustmentCents: 0,
    previousFinalPriceCents: previousFinal,
    newTotalPriceCents: newFinal,
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    newFinalPriceCents: newFinal,
    promoRemoved: false,
  };
}

/** The settlement line the share's own writer posts (§5.2) — never this module. */
function settlementOf(direction: "REFUND_TO_MEMBER" | "CHARGE_TO_MEMBER", cents: number): Row {
  const [row] = buildBookingLedgerRows([
    {
      bookingId: "b1",
      lodgeId: "l1",
      side: "SETTLEMENT",
      kind: direction === "REFUND_TO_MEMBER" ? "CARD_REFUND" : "CARD_CAPTURE",
      sign: direction === "REFUND_TO_MEMBER" ? -1 : 1,
      quantity: 1,
      unitCents: cents,
      anchorKind: direction === "REFUND_TO_MEMBER" ? "PAYMENT_REFUND" : "PAYMENT_TRANSACTION",
      anchorId: "settle-1",
      settlementMethod: "CARD",
      narration: "settlement",
      postingKey: "settle-1",
    },
  ]);
  return { ...row!, id: "line:settle-1" };
}

const SIDES_REMOVE_G2 = {
  before: {
    guests: ["g1", "g2"].map((id) => ({
      guestKey: id,
      ageTier: "ADULT" as const,
      isMember: true,
      rateMembershipTypeId: "rate-m",
      name: `Guest ${id}`,
      nights: [
        { stayDate: D1, priceCents: 5_000, priceSource: "SOLD" as const },
        { stayDate: D2, priceCents: 5_000, priceSource: "SOLD" as const },
      ],
    })),
    promoAdjustmentCents: 0,
  },
  after: {
    guests: [
      {
        guestKey: "g1",
        ageTier: "ADULT" as const,
        isMember: true,
        rateMembershipTypeId: "rate-m",
        name: "Guest g1",
        nights: [
          { stayDate: D1, priceCents: 5_000 },
          { stayDate: D2, priceCents: 5_000 },
        ],
      },
    ],
    promoAdjustmentCents: 0,
  },
};

describe("postModificationLedgerLines (#3582)", () => {
  const row = { id: "m1", priceDiffCents: -10_000, changeFeeCents: 0 };
  const base = { bookingId: "b1", lodgeId: "l1", bookingModification: row, site: "guest-removal" };

  it("posts an edit's reversals on a booking confirmed on the ledger, leaving owed(b) at the refund due", async () => {
    const ledger = confirmedLedger();
    const s = store(ledger);
    await postModificationLedgerLines({ ...base, store: s.store, sides: SIDES_REMOVE_G2 });
    expect(s.createMany).toHaveBeenCalledTimes(1);
    expect(s.written.every((row) => row.anchorKind === "MODIFICATION" && row.anchorId === "m1")).toBe(true);
    expect(owed([...ledger, ...s.written])).toBe(-10_000);
  });

  it("posts nothing on a booking not yet confirmed on the ledger — the confirmation will read the booking as it then is", async () => {
    // An ADD needs no live line, so only the fence stops it posting.
    const s = store(confirmedLedger().filter((row) => row.anchorKind !== "CONFIRMATION"));
    await postModificationLedgerLines({
      ...base,
      bookingModification: { ...row, priceDiffCents: 10_000 },
      store: s.store,
      sides: { before: SIDES_REMOVE_G2.after, after: SIDES_REMOVE_G2.before },
    });
    expect(s.createMany).not.toHaveBeenCalled();
    // CONTROL: the same add on a booking confirmed without g2 posts.
    const confirmed = store(confirmedLedger().filter((row) => row.bookingGuestId !== "g2"));
    await postModificationLedgerLines({
      ...base,
      bookingModification: { ...row, priceDiffCents: 10_000 },
      store: confirmed.store,
      sides: { before: SIDES_REMOVE_G2.after, after: SIDES_REMOVE_G2.before },
    });
    expect(confirmed.written.map((row) => row.amountCents)).toEqual([5_000, 5_000]);
  });

  it("an admin date SHIFT (#3741) re-dates every night at its own figure: four reversals, four re-posts, netting to zero", async () => {
    const D3 = new Date("2026-08-08T00:00:00.000Z");
    const D4 = new Date("2026-08-09T00:00:00.000Z");
    const side = (dates: Date[]) => ({
      guests: ["g1", "g2"].map((id) => ({
        guestKey: id,
        ageTier: "ADULT" as const,
        isMember: true,
        rateMembershipTypeId: "rate-m",
        name: `Guest ${id}`,
        nights: dates.map((stayDate) => ({ stayDate, priceCents: 5_000 })),
      })),
      promoAdjustmentCents: 0,
    });
    const ledger = confirmedLedger();
    const s = store(ledger);
    await postModificationLedgerLines({
      ...base,
      bookingModification: { ...row, priceDiffCents: 0 },
      site: "admin-date-shift",
      store: s.store,
      sides: { before: side([D1, D2]), after: side([D3, D4]) },
    });
    expect(s.written.filter((line) => line.reversesLineId).map((line) => line.nightStart)).toEqual([D1, D2, D1, D2]);
    expect(s.written.filter((line) => !line.reversesLineId).map((line) => line.nightStart)).toEqual([D3, D4, D3, D4]);
    expect(owed([...ledger, ...s.written])).toBe(owed(ledger));
  });

  it("posts nothing, and reads nothing, for a parked edit (no sides)", async () => {
    const s = store(confirmedLedger());
    await postModificationLedgerLines({ ...base, store: s.store, sides: null });
    expect(s.createMany).not.toHaveBeenCalled();
  });

  it("logs and posts nothing when the lines do not sum to the edit's figure", async () => {
    log.warn.mockClear();
    const s = store(confirmedLedger());
    await postModificationLedgerLines({
      ...base,
      bookingModification: { ...row, priceDiffCents: -9_000 },
      store: s.store,
      sides: SIDES_REMOVE_G2,
    });
    expect(s.createMany).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "SUM_MISMATCH" }), expect.any(String));
  });
});

describe("postReviewClosureLedgerLines — one record of the share's money, per direction (#3582)", () => {
  const base = { bookingId: "b1", lodgeId: "l1", manualRefundTaskId: "t1", note: "Agreed", officerMemberId: "o1" };

  it("REFUND, re-priced: the re-price reverses the removed guest and posts NO adjustment; owed(b) settles to zero", async () => {
    const ledger = confirmedLedger();
    const s = store(ledger, [G1_AFTER]);
    await postReviewClosureLedgerLines({
      ...base,
      store: s.store,
      rebase: rebase(20_000, 10_000),
      rebaseHistoryId: "rb1",
      settlement: { direction: "REFUND_TO_MEMBER", amountCents: 10_000 },
    });
    expect(s.written.map((row) => [row.kind, row.amountCents, row.anchorId])).toEqual([
      ["GUEST_NIGHT", -5_000, "rb1"],
      ["GUEST_NIGHT", -5_000, "rb1"],
    ]);
    expect(owed([...ledger, ...s.written, settlementOf("REFUND_TO_MEMBER", 10_000)])).toBe(0);
  });

  it("CHARGE, re-priced: the re-price posts the added nights and NO adjustment; owed(b) settles to zero", async () => {
    const ledger = confirmedLedger();
    const g2 = { ...G1_AFTER, id: "g2", lastName: "g2" };
    const g3 = { ...G1_AFTER, id: "g3", lastName: "g3", nights: [{ stayDate: D1, priceCents: 3_000 }] };
    const s = store(ledger, [G1_AFTER, g2, g3]);
    await postReviewClosureLedgerLines({
      ...base,
      store: s.store,
      rebase: rebase(20_000, 23_000),
      rebaseHistoryId: "rb1",
      settlement: { direction: "CHARGE_TO_MEMBER", amountCents: 3_000 },
    });
    expect(s.written.map((row) => [row.kind, row.amountCents, row.postingKey])).toEqual([
      ["GUEST_NIGHT", 3_000, "modification:rb1:night:g3:2026-08-01"],
    ]);
    expect(owed([...ledger, ...s.written, settlementOf("CHARGE_TO_MEMBER", 3_000)])).toBe(0);
  });

  it("REFUND, re-price declined: the AGREED_ADJUSTMENT (−) is the one record; owed(b) settles to zero", async () => {
    const ledger = confirmedLedger();
    const s = store(ledger);
    await postReviewClosureLedgerLines({
      ...base,
      store: s.store,
      rebase: null,
      rebaseHistoryId: null,
      settlement: { direction: "REFUND_TO_MEMBER", amountCents: 10_000 },
    });
    expect(s.written.map((row) => [row.kind, row.side, row.amountCents, row.anchorKind, row.narration])).toEqual([
      ["AGREED_ADJUSTMENT", "ADJUSTMENT", -10_000, "REVIEW_TASK", "Adjustment agreed with member: Agreed"],
    ]);
    expect(owed([...ledger, ...s.written, settlementOf("REFUND_TO_MEMBER", 10_000)])).toBe(0);
  });

  it("CHARGE, nothing moved and the charges carry the price: NO adjustment — owed(b) follows the booking's own figures", async () => {
    // The booking's price did not move, so its own figures say the captured
    // share is money paid over the price, and the ledger says the same. A share
    // the price does not carry is §5.3's limit, not a line.
    const ledger = confirmedLedger();
    const s = store(ledger);
    await postReviewClosureLedgerLines({
      ...base,
      store: s.store,
      rebase: rebase(20_000, 20_000),
      rebaseHistoryId: null,
      settlement: { direction: "CHARGE_TO_MEMBER", amountCents: 2_500 },
    });
    expect(s.createMany).not.toHaveBeenCalled();
    expect(owed([...ledger, ...s.written, settlementOf("CHARGE_TO_MEMBER", 2_500)])).toBe(20_000 - 22_500);
  });

  it("REFUND, re-price could not be planned: the charges do not carry the price, so the share stands in", async () => {
    const ledger = confirmedLedger();
    // No guest rows read back: the plan reverses all four nights (−$200)
    // against a −$100 movement, so it is refused and nothing re-prices.
    const s = store(ledger, []);
    await postReviewClosureLedgerLines({
      ...base,
      store: s.store,
      rebase: rebase(20_000, 10_000),
      rebaseHistoryId: "rb1",
      settlement: { direction: "REFUND_TO_MEMBER", amountCents: 10_000 },
    });
    expect(s.written.map((row) => [row.kind, row.amountCents])).toEqual([["AGREED_ADJUSTMENT", -10_000]]);
  });

  it("a DISMISSAL posts no adjustment, and its re-price still posts", async () => {
    const ledger = confirmedLedger();
    const s = store(ledger, [G1_AFTER]);
    await postReviewClosureLedgerLines({
      ...base,
      store: s.store,
      rebase: rebase(20_000, 10_000),
      rebaseHistoryId: "rb1",
      settlement: null,
    });
    expect(s.written.map((row) => row.kind)).toEqual(["GUEST_NIGHT", "GUEST_NIGHT"]);
  });

  it("posts nothing at all on a booking not yet confirmed on the ledger", async () => {
    const s = store(confirmedLedger().filter((row) => row.anchorKind !== "CONFIRMATION"), [G1_AFTER]);
    await postReviewClosureLedgerLines({
      ...base,
      store: s.store,
      rebase: rebase(20_000, 10_000),
      rebaseHistoryId: "rb1",
      settlement: { direction: "REFUND_TO_MEMBER", amountCents: 10_000 },
    });
    expect(s.createMany).not.toHaveBeenCalled();
  });
});

/**
 * TWO SIBLING REVIEWS FROM ONE PARKED EDIT (review F1 of #3740). A parked edit
 * that moved two strands raises one task per strand, and every closure re-bases
 * the WHOLE booking — so the first closure's re-price already carries every
 * sibling's money. The rule held after every closure, in every order: `owed(b)`
 * on the ledger equals what the booking's own figures say (its final price less
 * what has been paid, net of refunds).
 */
describe("postReviewClosureLedgerLines — sibling reviews never count one parked edit's money twice (#3582)", () => {
  function guestRow(id: string) {
    return { ...G1_AFTER, id, lastName: id };
  }

  /** A confirmed, fully paid booking of `ids`, two $50 nights each. */
  function confirmedWith(ids: string[]): Row[] {
    const plan = planConfirmationChargeLines({
      id: "b1",
      lodgeId: "l1",
      totalPriceCents: ids.length * 10_000,
      promoAdjustmentCents: 0,
      guests: ids.map((id) => ({
        id,
        firstName: "Guest",
        lastName: id,
        ageTier: "ADULT" as const,
        rateMembershipTypeId: "rate-m",
        nights: [D1, D2].map((stayDate) => ({ stayDate, priceCents: 5_000 })),
      })),
    });
    const capture = buildBookingLedgerRows([
      {
        bookingId: "b1",
        lodgeId: "l1",
        side: "SETTLEMENT",
        kind: "CARD_CAPTURE",
        sign: 1,
        quantity: 1,
        unitCents: ids.length * 10_000,
        anchorKind: "PAYMENT_TRANSACTION",
        anchorId: "txn-3",
        settlementMethod: "CARD",
        narration: "Card payment",
        postingKey: "capture:txn-3",
      },
    ]);
    return [...buildBookingLedgerRows(plan.postings), ...capture].map((row) => ({
      ...row,
      id: `line:${row.postingKey}`,
    }));
  }

  type Share = { direction: "REFUND_TO_MEMBER" | "CHARGE_TO_MEMBER"; amountCents: number };
  type Step = {
    task: string;
    rebase: BookingPriceRebase | null;
    rebaseHistoryId: string | null;
    guests: string[];
    settlement: Share | null;
  };

  /** Close each step in turn on the growing ledger; each share's settlement follows its closure. */
  async function closeInTurn(ledger: Row[], steps: Step[]): Promise<Row[]> {
    let lines = [...ledger];
    for (const step of steps) {
      const s = store(lines, step.guests.map(guestRow));
      await postReviewClosureLedgerLines({
        bookingId: "b1",
        lodgeId: "l1",
        manualRefundTaskId: step.task,
        note: `share ${step.task}`,
        officerMemberId: "o1",
        store: s.store,
        rebase: step.rebase,
        rebaseHistoryId: step.rebaseHistoryId,
        settlement: step.settlement,
      });
      lines = [...lines, ...s.written];
      if (step.settlement) {
        const key = `settle-${step.task}`;
        lines.push({
          ...settlementOf(step.settlement.direction, step.settlement.amountCents),
          postingKey: key,
          id: `line:${key}`,
        });
      }
    }
    return lines;
  }

  const refund: Share = { direction: "REFUND_TO_MEMBER", amountCents: 10_000 };
  const charge: Share = { direction: "CHARGE_TO_MEMBER", amountCents: 10_000 };
  const adjustmentsOf = (lines: Row[]) => lines.filter((row) => row.kind === "AGREED_ADJUSTMENT");

  for (const [first, second] of [
    ["tB", "tC"],
    ["tC", "tB"],
  ] as const) {
    it(`REFUND, ${first} then ${second}: the first re-price carries both removals and the second closure posts nothing; owed(b) = 0`, async () => {
      // g1, gB and gC at $100 each, paid $300. A parked edit removes gB and gC.
      const lines = await closeInTurn(confirmedWith(["g1", "gB", "gC"]), [
        { task: first, rebase: rebase(30_000, 10_000), rebaseHistoryId: "rb1", guests: ["g1"], settlement: refund },
        { task: second, rebase: rebase(10_000, 10_000), rebaseHistoryId: null, guests: ["g1"], settlement: refund },
      ]);
      expect(adjustmentsOf(lines)).toEqual([]);
      // The booking: final $100; paid $300 less $200 refunded.
      expect(owed(lines)).toBe(10_000 - (30_000 - 20_000));
    });
  }

  it("REFUND, dismiss then complete: the dismissal's re-price stands and the completion adds nothing; owed(b) matches the booking", async () => {
    const lines = await closeInTurn(confirmedWith(["g1", "gB", "gC"]), [
      { task: "tB", rebase: rebase(30_000, 10_000), rebaseHistoryId: "rb1", guests: ["g1"], settlement: null },
      { task: "tC", rebase: rebase(10_000, 10_000), rebaseHistoryId: null, guests: ["g1"], settlement: refund },
    ]);
    expect(adjustmentsOf(lines)).toEqual([]);
    // The booking: final $100; paid $300 less $100 refunded — the club owes $100.
    expect(owed(lines)).toBe(10_000 - (30_000 - 10_000));
  });

  it("REFUND, declined then re-priced: the first share stands in, and the re-price that carries it reverses it; owed(b) = 0", async () => {
    const lines = await closeInTurn(confirmedWith(["g1", "gB", "gC"]), [
      { task: "tB", rebase: null, rebaseHistoryId: null, guests: ["g1", "gC"], settlement: refund },
      { task: "tC", rebase: rebase(30_000, 10_000), rebaseHistoryId: "rb2", guests: ["g1"], settlement: refund },
    ]);
    expect(adjustmentsOf(lines).map((row) => [row.amountCents, row.anchorId, row.reversesLineId ?? null])).toEqual([
      [-10_000, "tB", null],
      [10_000, "tC", "line:agreed-adjustment:tB"],
    ]);
    expect(owed(lines)).toBe(10_000 - (30_000 - 20_000));
  });

  it("REFUND, three siblings: a stand-in already reversed is never reversed again, and the last closure posts nothing", async () => {
    const lines = await closeInTurn(confirmedWith(["g1", "gB", "gC", "gD"]), [
      { task: "tB", rebase: null, rebaseHistoryId: null, guests: ["g1", "gC", "gD"], settlement: refund },
      { task: "tC", rebase: rebase(40_000, 10_000), rebaseHistoryId: "rb2", guests: ["g1"], settlement: refund },
      { task: "tD", rebase: rebase(10_000, 10_000), rebaseHistoryId: null, guests: ["g1"], settlement: refund },
    ]);
    expect(adjustmentsOf(lines).map((row) => row.anchorId)).toEqual(["tB", "tC"]);
    expect(owed(lines)).toBe(10_000 - (40_000 - 30_000));
  });

  it("REFUND, declined then re-priced on a ledger whose PROMOTION drifted: the re-price still reverses the stand-in (#3740 delta L1)", async () => {
    // A $10 promotion line the booking's own figures no longer carry: the
    // re-price plans from the re-base's promotion (none), passes its sum, and
    // the charges miss the final price by exactly the drift.
    const [drift] = buildBookingLedgerRows([
      {
        bookingId: "b1",
        lodgeId: "l1",
        side: "CHARGE",
        kind: "PROMOTION",
        sign: -1,
        quantity: 1,
        unitCents: 1_000,
        anchorKind: "CONFIRMATION",
        anchorId: "b1",
        narration: "Promotion applied",
        postingKey: "confirmation:b1:promotion",
      },
    ]);
    const lines = await closeInTurn([...confirmedWith(["g1", "gB", "gC"]), { ...drift!, id: "line:drift" }], [
      { task: "tB", rebase: null, rebaseHistoryId: null, guests: ["g1", "gC"], settlement: refund },
      { task: "tC", rebase: rebase(30_000, 10_000), rebaseHistoryId: "rb2", guests: ["g1"], settlement: refund },
    ]);
    expect(adjustmentsOf(lines).map((row) => [row.amountCents, row.reversesLineId ?? null])).toEqual([
      [-10_000, null],
      [10_000, "line:agreed-adjustment:tB"],
    ]);
    // Off from the booking's figure by the drift alone, never by a second count.
    expect(owed(lines)).toBe(10_000 - (30_000 - 20_000) - 1_000);
  });

  for (const [first, second] of [
    ["tB", "tC"],
    ["tC", "tB"],
  ] as const) {
    it(`CHARGE, ${first} then ${second}: the first re-price carries both additions and the second posts nothing; owed(b) = 0`, async () => {
      // g1 at $100, paid $100. A parked edit adds gB and gC.
      const lines = await closeInTurn(confirmedWith(["g1"]), [
        {
          task: first,
          rebase: rebase(10_000, 30_000),
          rebaseHistoryId: "rb1",
          guests: ["g1", "gB", "gC"],
          settlement: charge,
        },
        {
          task: second,
          rebase: rebase(30_000, 30_000),
          rebaseHistoryId: null,
          guests: ["g1", "gB", "gC"],
          settlement: charge,
        },
      ]);
      expect(adjustmentsOf(lines)).toEqual([]);
      expect(owed(lines)).toBe(30_000 - 30_000);
    });
  }

  it("CHARGE, declined then re-priced: the stand-in (+) is reversed by the re-price that carries it; owed(b) = 0", async () => {
    const lines = await closeInTurn(confirmedWith(["g1"]), [
      { task: "tB", rebase: null, rebaseHistoryId: null, guests: ["g1", "gB", "gC"], settlement: charge },
      {
        task: "tC",
        rebase: rebase(10_000, 30_000),
        rebaseHistoryId: "rb2",
        guests: ["g1", "gB", "gC"],
        settlement: charge,
      },
    ]);
    expect(adjustmentsOf(lines).map((row) => row.amountCents)).toEqual([10_000, -10_000]);
    expect(owed(lines)).toBe(30_000 - 30_000);
  });
});
