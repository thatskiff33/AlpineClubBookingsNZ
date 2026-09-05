import { describe, expect, it } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import {
  preservedNightPriceWrites,
  proposedNightPriceSources,
  repricedNightPriceSources,
  storedNightPriceDetailsByKey,
} from "@/lib/stored-night-price-write";
import { storedSoldPriceEvidenceForGuest } from "@/lib/stored-sold-price-evidence";

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe("BookingGuestNight price provenance", () => {
  it("preserves the recorded source and marks a structurally new unknown night UNKNOWN", () => {
    const stored = new Map([
      [
        requireCalendarDate("2026-08-01"),
        { priceCents: 3_001, priceSource: "EVEN_SPLIT" as const },
      ],
      [
        requireCalendarDate("2026-08-02"),
        { priceCents: 3_000, priceSource: "OFFICER_PRICED" as const },
      ],
    ]);

    expect(
      preservedNightPriceWrites(stored, [
        D("2026-08-01"),
        D("2026-08-02"),
        D("2026-08-03"),
      ]),
    ).toEqual([
      { priceCents: 3_001, priceSource: "EVEN_SPLIT" },
      { priceCents: 3_000, priceSource: "OFFICER_PRICED" },
      { priceCents: null, priceSource: "UNKNOWN" },
    ]);
  });

  it("uses the pricing engine's lock vector, not equal amounts, to distinguish retained history from a fresh sale", () => {
    expect(
      repricedNightPriceSources(
        [
          {
            stayDate: D("2026-08-01"),
            priceCents: 3_001,
            priceSource: "EVEN_SPLIT",
          },
        ],
        [D("2026-08-01"), D("2026-08-02")],
      ),
    ).toEqual(["EVEN_SPLIT", "SOLD"]);
  });

  it("uses one retained/new rule for edit writers and refuses missing stored provenance", () => {
    const augustFirst = requireCalendarDate("2026-08-01");
    const augustSecond = requireCalendarDate("2026-08-02");
    expect(
      proposedNightPriceSources({
        proposedNightKeys: [augustFirst, augustSecond],
        retainedNightKeys: new Set([augustFirst]),
        storedNightDetailsByKey: new Map([
          [
            augustFirst,
            { priceCents: 3_001, priceSource: "OFFICER_PRICED" },
          ],
        ]),
        newNightSource: "SOLD",
      }),
    ).toEqual(["OFFICER_PRICED", "SOLD"]);

    expect(() =>
      storedNightPriceDetailsByKey([
        {
          stayDate: D("2026-08-01"),
          priceCents: 3_001,
          priceSource: undefined as never,
        },
      ]),
    ).toThrow(/loaded without price provenance/);
  });

  it("does not change the stage-1 sold-evidence verdict because of provenance", () => {
    const booking = {
      checkIn: D("2026-08-01"),
      checkOut: D("2026-08-03"),
    };
    const result = storedSoldPriceEvidenceForGuest(
      {
        priceCents: 6_001,
        nights: [
          {
            stayDate: D("2026-08-01"),
            priceCents: 3_001,
            priceSource: "EVEN_SPLIT",
          },
          {
            stayDate: D("2026-08-02"),
            priceCents: 3_000,
            priceSource: "UNKNOWN",
          },
        ],
      },
      booking,
    );

    expect(result).toEqual({
      kind: "exact",
      nightPrices: [
        { date: "2026-08-01", priceCents: 3_001 },
        { date: "2026-08-02", priceCents: 3_000 },
      ],
      totalCents: 6_001,
    });
  });
});
