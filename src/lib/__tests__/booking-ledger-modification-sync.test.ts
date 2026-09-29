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
  const base = {
    bookingId: "b1",
    lodgeId: "l1",
    bookingModificationId: "m1",
    priceDiffCents: -10_000,
    changeFeeCents: 0,
    site: "guest-removal",
  };

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
      priceDiffCents: 10_000,
      store: s.store,
      sides: { before: SIDES_REMOVE_G2.after, after: SIDES_REMOVE_G2.before },
    });
    expect(s.createMany).not.toHaveBeenCalled();
    // CONTROL: the same add on a booking confirmed without g2 posts.
    const confirmed = store(confirmedLedger().filter((row) => row.bookingGuestId !== "g2"));
    await postModificationLedgerLines({
      ...base,
      priceDiffCents: 10_000,
      store: confirmed.store,
      sides: { before: SIDES_REMOVE_G2.after, after: SIDES_REMOVE_G2.before },
    });
    expect(confirmed.written.map((row) => row.amountCents)).toEqual([5_000, 5_000]);
  });

  it("posts nothing, and reads nothing, for a parked edit (no sides)", async () => {
    const s = store(confirmedLedger());
    await postModificationLedgerLines({ ...base, store: s.store, sides: null });
    expect(s.createMany).not.toHaveBeenCalled();
  });

  it("logs and posts nothing when the lines do not sum to the edit's figure", async () => {
    log.warn.mockClear();
    const s = store(confirmedLedger());
    await postModificationLedgerLines({ ...base, priceDiffCents: -9_000, store: s.store, sides: SIDES_REMOVE_G2 });
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

  it("CHARGE, no history row (nothing moved): the AGREED_ADJUSTMENT (+) is the one record; owed(b) settles to zero", async () => {
    const ledger = confirmedLedger();
    const s = store(ledger);
    await postReviewClosureLedgerLines({
      ...base,
      store: s.store,
      rebase: rebase(20_000, 20_000),
      rebaseHistoryId: null,
      settlement: { direction: "CHARGE_TO_MEMBER", amountCents: 2_500 },
    });
    expect(s.written.map((row) => [row.kind, row.amountCents, row.postingKey])).toEqual([
      ["AGREED_ADJUSTMENT", 2_500, "agreed-adjustment:t1"],
    ]);
    expect(owed([...ledger, ...s.written, settlementOf("CHARGE_TO_MEMBER", 2_500)])).toBe(0);
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
