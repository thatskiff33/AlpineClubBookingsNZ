/**
 * The one door into the ledger: what it computes, and what it refuses
 * (#3580, programme #3527).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildBookingLedgerRows,
  writeBookingLedgerRows,
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
    postingKey: `test:${Math.random()}`,
    ...overrides,
  };
}

function store() {
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  return { store: { bookingLedgerLine: { createMany } } as never, createMany };
}

describe("the posting key (#3595)", () => {
  it("writes with ON CONFLICT DO NOTHING, so a repeat is skipped rather than refused", async () => {
    // A refused statement would abort the caller's transaction (#3590's
    // review); a skipped one leaves it untouched. `skipDuplicates` is the
    // difference, so it is pinned here.
    const { store: s, createMany } = store();
    await postBookingLedgerLines(s, [guestNight({ postingKey: "k1" })]);
    expect(createMany.mock.calls[0]?.[0]).toMatchObject({ skipDuplicates: true });
    const rows = createMany.mock.calls[0]?.[0].data as Array<Record<string, unknown>>;
    expect(rows[0]?.postingKey).toBe("k1");
  });

  it("refuses an empty key before anything is sent", async () => {
    const { store: s, createMany } = store();
    await expect(
      postBookingLedgerLines(s, [guestNight({ postingKey: "  " })]),
    ).rejects.toBeInstanceOf(BookingLedgerPostingError);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("refuses the same key twice in one batch — a planner bug, not a replay", async () => {
    // Otherwise the write would silently keep the first row and drop the
    // second, hiding the bug that produced them.
    const { store: s, createMany } = store();
    await expect(
      postBookingLedgerLines(s, [guestNight({ postingKey: "dup" }), guestNight({ postingKey: "dup" })]),
    ).rejects.toThrow(/appears twice in one batch/);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("reports how many rows were really inserted, so a replay reads as 0", async () => {
    const createMany = vi.fn(async () => ({ count: 0 }));
    const s = { bookingLedgerLine: { createMany } } as never;
    expect(await postBookingLedgerLines(s, [guestNight({ postingKey: "already-there" })])).toBe(0);
  });
});

describe("buildBookingLedgerRows", () => {
  it("throws in pure JavaScript, before any statement reaches the database", async () => {
    // The distinction the settle door depends on: a bad PLAN is safe to
    // swallow inside a transaction because nothing has been sent yet. A
    // refused STATEMENT is not, and is deliberately never wrapped.
    const { store: s, createMany } = store();
    expect(() => buildBookingLedgerRows([guestNight({ unitCents: -1 })])).toThrow(
      BookingLedgerPostingError,
    );
    expect(createMany).not.toHaveBeenCalled();
    expect(await writeBookingLedgerRows(s, [])).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});

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
    // Review of #3580: the equality alone let this through — a line naming a
    // strand and no nights satisfied it while still claiming a guest.
    [
      "a settlement that names a strand but no nights",
      guestNight({
        side: "SETTLEMENT",
        kind: "CARD_CAPTURE",
        settlementMethod: "CARD",
        nightStart: null,
        nightEndExclusive: null,
      }),
    ],
    [
      "an adjustment that names only a night",
      guestNight({
        side: "ADJUSTMENT",
        kind: "AGREED_ADJUSTMENT",
        bookingGuestId: null,
        nightEndExclusive: null,
      }),
    ],
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
