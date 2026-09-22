/**
 * The one door into the ledger: what it computes, and what it refuses
 * (#3580, programme #3527).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  BookingLedgerPostingError,
  ledgerLineAmountCents,
  postBookingLedgerLines,
  type BookingLedgerPosting,
} from "@/lib/booking-ledger-write";

const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const NEXT_MORNING = new Date("2026-08-02T00:00:00.000Z");

function guestNight(overrides: Partial<BookingLedgerPosting> = {}): BookingLedgerPosting {
  return {
    bookingId: "booking-1",
    lodgeId: "lodge-1",
    side: "CHARGE",
    kind: "GUEST_NIGHT",
    sign: 1,
    quantity: 1,
    unitCents: 6500,
    anchorKind: "CONFIRMATION",
    anchorId: "booking-1",
    bookingGuestId: "guest-1",
    nightStart: NIGHT,
    nightEndExclusive: NEXT_MORNING,
    narration: "A Member — one night",
    ...overrides,
  };
}

function store() {
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  return { store: { bookingLedgerLine: { createMany } } as never, createMany };
}

describe("postBookingLedgerLines", () => {
  it("computes the amount from the parts, so a caller cannot hand over a figure that disagrees", () => {
    expect(ledgerLineAmountCents({ sign: 1, unitCents: 6500, quantity: 2 })).toBe(13_000);
    expect(ledgerLineAmountCents({ sign: -1, unitCents: 6500, quantity: 2 })).toBe(-13_000);
  });

  it("writes one row per posting, with the computed amount", async () => {
    const { store: s, createMany } = store();
    const written = await postBookingLedgerLines(s, [guestNight(), guestNight({ quantity: 2 })]);
    expect(written).toBe(2);
    const rows = createMany.mock.calls[0]?.[0].data as Array<Record<string, unknown>>;
    expect(rows[0]?.amountCents).toBe(6500);
    expect(rows[1]?.amountCents).toBe(13_000);
    expect(rows[0]?.guestNames).toEqual([]);
  });

  it("writes nothing, and touches no store, for an empty posting list", async () => {
    const { store: s, createMany } = store();
    expect(await postBookingLedgerLines(s, [])).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a negative unit price", guestNight({ unitCents: -1 })],
    ["a fractional unit price", guestNight({ unitCents: 12.5 })],
    ["a negative quantity", guestNight({ quantity: -1 })],
    ["a guest-night naming no strand", guestNight({ bookingGuestId: null })],
    ["a guest-night naming no nights", guestNight({ nightStart: null })],
    ["a change fee that names a strand", guestNight({ kind: "CHANGE_FEE" })],
    [
      "a settlement with no method",
      guestNight({
        side: "SETTLEMENT",
        kind: "CARD_CAPTURE",
        bookingGuestId: null,
        nightStart: null,
        nightEndExclusive: null,
      }),
    ],
    ["a charge that claims a settlement method", guestNight({ settlementMethod: "CARD" })],
  ])("refuses %s before it reaches the database", async (_label, posting) => {
    const { store: s, createMany } = store();
    await expect(postBookingLedgerLines(s, [posting])).rejects.toBeInstanceOf(
      BookingLedgerPostingError,
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it("names the invariant when it refuses", async () => {
    const { store: s } = store();
    await expect(
      postBookingLedgerLines(s, [guestNight({ unitCents: -1 })]),
    ).rejects.toThrow(/INV-MONEY-032/);
  });

  it("accepts the settlement and adjustment shapes the design names", async () => {
    const { store: s, createMany } = store();
    await postBookingLedgerLines(s, [
      guestNight({
        side: "SETTLEMENT",
        kind: "CARD_CAPTURE",
        settlementMethod: "CARD",
        anchorKind: "PAYMENT_TRANSACTION",
        anchorId: "txn-1",
        bookingGuestId: null,
        nightStart: null,
        nightEndExclusive: null,
        narration: "Card payment",
      }),
      guestNight({
        side: "ADJUSTMENT",
        kind: "AGREED_ADJUSTMENT",
        sign: -1,
        anchorKind: "REVIEW_TASK",
        anchorId: "task-1",
        bookingGuestId: null,
        nightStart: null,
        nightEndExclusive: null,
        postedByMemberId: "officer-1",
        narration: "Adjustment agreed with member: rounding",
      }),
    ]);
    const rows = createMany.mock.calls[0]?.[0].data as Array<Record<string, unknown>>;
    expect(rows[0]?.settlementMethod).toBe("CARD");
    expect(rows[1]?.amountCents).toBe(-6500);
    expect(rows[1]?.postedByMemberId).toBe("officer-1");
  });
});
