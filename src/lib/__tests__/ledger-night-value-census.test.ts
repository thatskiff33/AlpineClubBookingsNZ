import { describe, expect, it } from "vitest";

import { summarizeLedgerNightValues } from "@/lib/ledger-night-value-census";

/**
 * #4317 review M3: the read-only count the owner runs before wave A2 ships —
 * bookings confirmed on the ledger whose live per-night lines an auto-priced
 * edit would not match, and so leave unposted until wave B's re-base.
 */

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);
const BOOKING = {
  id: "b1",
  checkIn: D("2026-08-01"),
  checkOut: D("2026-08-03"),
  status: "CONFIRMED",
  deletedAt: null as Date | null,
};

function line(id: string, guestId: string, night: string, unitCents: number, over: Record<string, unknown> = {}) {
  const start = D(night);
  return {
    id,
    bookingId: "b1",
    kind: "GUEST_NIGHT",
    sign: 1,
    quantity: 1,
    unitCents,
    bookingGuestId: guestId,
    nightStart: start,
    nightEndExclusive: new Date(start.getTime() + 86_400_000),
    reversesLineId: null,
    anchorKind: "CONFIRMATION",
    ...over,
  };
}

const sold = (night: string, priceCents: number | null) => ({
  stayDate: D(night),
  priceCents,
  priceSource: priceCents === null ? ("UNKNOWN" as const) : ("SOLD" as const),
});

describe("summarizeLedgerNightValues", () => {
  it("counts nothing for a booking whose lines are its valued nights", () => {
    expect(
      summarizeLedgerNightValues({
        bookings: [BOOKING],
        guests: [{ id: "g1", bookingId: "b1", priceCents: 10_000, nights: [sold("2026-08-01", 5_000), sold("2026-08-02", 5_000)] }],
        lines: [line("l1", "g1", "2026-08-01", 5_000), line("l2", "g1", "2026-08-02", 5_000)],
      }),
    ).toEqual({
      bookingsOnLedger: 1,
      bookingsWhoseLinesDifferFromValues: 0,
      linesDifferingFromValues: 0,
      valuedNightsWithoutLiveLine: 0,
      sampleBookingIds: [],
    });
  });

  it("counts R3 lines that differ from the even split, and a blank the confirmation skipped", () => {
    const result = summarizeLedgerNightValues({
      bookings: [BOOKING],
      guests: [
        // $50 + $50 rows against $120: valued $60 each, so both lines differ.
        { id: "g1", bookingId: "b1", priceCents: 12_000, nights: [sold("2026-08-01", 5_000), sold("2026-08-02", 5_000)] },
        // A blank the confirmation posted nothing for: valued $40, no live line.
        { id: "g2", bookingId: "b1", priceCents: 8_000, nights: [sold("2026-08-01", 4_000), sold("2026-08-02", null)] },
      ],
      lines: [
        line("l1", "g1", "2026-08-01", 5_000),
        line("l2", "g1", "2026-08-02", 5_000),
        line("l3", "g2", "2026-08-01", 4_000),
      ],
    });
    expect(result).toEqual({
      bookingsOnLedger: 1,
      bookingsWhoseLinesDifferFromValues: 1,
      linesDifferingFromValues: 2,
      valuedNightsWithoutLiveLine: 1,
      sampleBookingIds: ["b1"],
    });
  });

  it("reads only LIVE lines: a reversed line and its re-post count once, at the re-post", () => {
    const result = summarizeLedgerNightValues({
      bookings: [BOOKING],
      guests: [{ id: "g1", bookingId: "b1", priceCents: 11_000, nights: [sold("2026-08-01", 5_000), sold("2026-08-02", 6_000)] }],
      lines: [
        line("l1", "g1", "2026-08-01", 5_000),
        line("l2", "g1", "2026-08-02", 5_000),
        line("r2", "g1", "2026-08-02", 5_000, { sign: -1, reversesLineId: "l2", anchorKind: "MODIFICATION" }),
        line("p2", "g1", "2026-08-02", 6_000, { anchorKind: "MODIFICATION" }),
      ],
    });
    expect(result.bookingsWhoseLinesDifferFromValues).toBe(0);
  });

  it.each([
    ["a cancelled booking", { status: "CANCELLED" }],
    ["a deleted booking", { deletedAt: D("2026-07-15") }],
  ])("does not count %s, which no edit can reach (review round 2)", (_name, over) => {
    // The same disagreeing R3 lines as above, on a booking that takes no edit.
    const result = summarizeLedgerNightValues({
      bookings: [{ ...BOOKING, ...over }],
      guests: [
        { id: "g1", bookingId: "b1", priceCents: 12_000, nights: [sold("2026-08-01", 5_000), sold("2026-08-02", 5_000)] },
      ],
      lines: [line("l1", "g1", "2026-08-01", 5_000), line("l2", "g1", "2026-08-02", 5_000)],
    });
    expect(result).toEqual({
      bookingsOnLedger: 0,
      bookingsWhoseLinesDifferFromValues: 0,
      linesDifferingFromValues: 0,
      valuedNightsWithoutLiveLine: 0,
      sampleBookingIds: [],
    });
  });

  it("ignores a booking not confirmed on the ledger", () => {
    const result = summarizeLedgerNightValues({
      bookings: [BOOKING],
      guests: [{ id: "g1", bookingId: "b1", priceCents: 12_000, nights: [sold("2026-08-01", 5_000)] }],
      lines: [],
    });
    expect(result.bookingsOnLedger).toBe(0);
    expect(result.bookingsWhoseLinesDifferFromValues).toBe(0);
  });
});
