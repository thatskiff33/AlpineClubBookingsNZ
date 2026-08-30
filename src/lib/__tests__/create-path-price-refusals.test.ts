/**
 * #3167 (epic #2797): the create-path writers refuse a missing price instead of
 * writing a zero.
 *
 * Epic #2797's rule is that zero is a real financial number, never an honest
 * representation of "not yet known", and #3031 made stored night prices
 * load-bearing — an edit reads them back as sold-price evidence. Three writers
 * on the CREATE and ADD paths still carried a `?? 0`; this file covers the
 * booking-create one and the shared helpers all four writers now share.
 *
 * The other two live with their own harnesses: the add-guest route in
 * `partial-stay-edit-pricing.test.ts` (real pricing engine, real route) and the
 * booking-request hold in `booking-request-quotes.test.ts`.
 *
 * EVERY refusal here is paired with a CONTROL — a complete breakdown that still
 * writes the correct amounts — because a guard with no control passes just as
 * happily against a function that always throws.
 */

import { describe, expect, it } from "vitest";
import { AgeTier } from "@prisma/client";

import { buildGuestCreateData, type PricedGuest } from "@/lib/booking-create-guests";
import type { BookingGuestInput } from "@/lib/booking-create-types";
import {
  requiredGuestPriceCents,
  requiredNightPriceCents,
} from "@/lib/required-price-cents";
import { dateOnlyFromParts } from "@/lib/date-only";

const CHECK_IN = dateOnlyFromParts(2026, 7, 1);
const CHECK_OUT = dateOnlyFromParts(2026, 7, 4);
const NIGHTS = [
  dateOnlyFromParts(2026, 7, 1),
  dateOnlyFromParts(2026, 7, 2),
  dateOnlyFromParts(2026, 7, 3),
];

function guestInput(overrides: Partial<BookingGuestInput> = {}): BookingGuestInput {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    ageTier: AgeTier.ADULT,
    isMember: false,
    ...overrides,
  };
}

function pricedGuest(overrides: Partial<PricedGuest> = {}): PricedGuest {
  return {
    priceCents: 24_000,
    perNightCents: [8_000, 8_000, 8_000],
    nightDates: NIGHTS,
    ...overrides,
  };
}

describe("buildGuestCreateData refuses a short per-night vector (#3167)", () => {
  it("CONTROL: writes one night row per priced night at the engine's own amounts", () => {
    const data = buildGuestCreateData(
      [guestInput()],
      { guests: [pricedGuest()] },
      CHECK_IN,
      CHECK_OUT
    );

    expect(data).toHaveLength(1);
    expect(data[0].priceCents).toBe(24_000);
    expect(data[0].nights.create).toHaveLength(3);
    expect(data[0].nights.create.map((n) => n.priceCents)).toEqual([
      8_000, 8_000, 8_000,
    ]);
    expect(data[0].nights.create.map((n) => n.stayDate)).toEqual(NIGHTS);
  });

  it("CONTROL: a genuine free night is still written as a real zero", () => {
    // The point of the refusal is that a MISSING price is not a zero. A priced
    // zero is a legitimate amount and must survive untouched, or the guard has
    // simply moved the corruption.
    const data = buildGuestCreateData(
      [guestInput()],
      { guests: [pricedGuest({ perNightCents: [8_000, 0, 8_000], priceCents: 16_000 })] },
      CHECK_IN,
      CHECK_OUT
    );

    expect(data[0].nights.create.map((n) => n.priceCents)).toEqual([8_000, 0, 8_000]);
  });

  it("REFUSAL: throws rather than writing a zero when the vector is shorter than the nights", () => {
    expect(() =>
      buildGuestCreateData(
        [guestInput()],
        { guests: [pricedGuest({ perNightCents: [8_000, 8_000] })] },
        CHECK_IN,
        CHECK_OUT
      )
    ).toThrow(/No priced amount for the night of .* in the booking-create guest writer/);
  });

  it("REFUSAL: names the exact night that had no priced amount", () => {
    expect(() =>
      buildGuestCreateData(
        [guestInput()],
        { guests: [pricedGuest({ perNightCents: [8_000] })] },
        CHECK_IN,
        CHECK_OUT
      )
    ).toThrow(NIGHTS[1].toISOString());
  });

  it("REFUSAL: a guest with no priced nights writes nothing and refuses nothing", () => {
    // An empty night list is not a short vector — it is a guest the engine
    // priced over no nights at all — so the envelope falls back to the booking
    // range and no row is written. The guard must not fire here.
    const data = buildGuestCreateData(
      [guestInput()],
      { guests: [pricedGuest({ perNightCents: [], nightDates: [], priceCents: 0 })] },
      CHECK_IN,
      CHECK_OUT
    );

    expect(data[0].nights.create).toHaveLength(0);
    expect(data[0].stayStart).toEqual(CHECK_IN);
    expect(data[0].stayEnd).toEqual(CHECK_OUT);
  });
});

describe("requiredNightPriceCents (#3031, #3167)", () => {
  const stayDate = NIGHTS[0];

  it("CONTROL: returns the priced amount, including a genuine zero", () => {
    expect(requiredNightPriceCents([8_000, 0], 0, stayDate, "a writer")).toBe(8_000);
    expect(requiredNightPriceCents([8_000, 0], 1, stayDate, "a writer")).toBe(0);
  });

  it("REFUSAL: throws past the end of the vector, and names the writer", () => {
    expect(() => requiredNightPriceCents([8_000], 1, stayDate, "a writer")).toThrow(
      /No priced amount for the night of .* in a writer \(#3031\)/
    );
  });

  it("REFUSAL: throws when there is no vector at all", () => {
    expect(() => requiredNightPriceCents(undefined, 0, stayDate, "a writer")).toThrow(
      /No priced amount for the night of/
    );
  });
});

describe("requiredGuestPriceCents (#3167)", () => {
  it("CONTROL: returns the split amount, including a genuine zero", () => {
    expect(requiredGuestPriceCents([6_000, 0], 0, "a writer")).toBe(6_000);
    expect(requiredGuestPriceCents([6_000, 0], 1, "a writer")).toBe(0);
  });

  it("REFUSAL: throws past the end of the split, naming the guest position and the writer", () => {
    expect(() => requiredGuestPriceCents([6_000], 1, "a writer")).toThrow(
      "No priced amount for guest 2 in a writer (#3167)"
    );
  });

  it("REFUSAL: throws when there is no split at all", () => {
    expect(() => requiredGuestPriceCents(undefined, 0, "a writer")).toThrow(
      /No priced amount for guest 1/
    );
  });
});
