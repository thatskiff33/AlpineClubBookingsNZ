/**
 * #3407 — a lodge with no capacity says it is not set up for bookings yet,
 * rather than quoting a limit of zero (owner decision, 14 Sep 2026).
 */

import { describe, expect, it } from "vitest";
import {
  LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE,
  isLodgeSetUpForBookings,
  lodgeGuestLimitMessage,
} from "@/lib/lodge-booking-readiness";
import {
  MAX_CONFIGURED_LODGE_CAPACITY,
  MIN_CONFIGURED_LODGE_CAPACITY,
  resolveEffectiveLodgeCapacity,
} from "@/lib/lodge-effective-capacity";

const bookingDoor = (limit: number) => `A booking cannot exceed ${limit} guests`;

describe("isLodgeSetUpForBookings — a resolved zero IS unconfigured_lodge", () => {
  /*
    The helper reads the resolved number rather than the source. That is only
    honest if the two answer the same question, so this walks the resolver over
    every configured capacity the save bounds allow (at both ends and in the
    middle) crossed with bed inventories on both sides of it, and requires
    "set up" to agree with `source !== "unconfigured_lodge"` on every one.
  */
  const configuredCapacities: Array<number | null> = [
    null,
    MIN_CONFIGURED_LODGE_CAPACITY,
    2,
    12,
    MAX_CONFIGURED_LODGE_CAPACITY,
  ];
  const bedCounts = [0, 1, 2, 12, 40];

  it("agrees with the resolver's source for every saveable input", () => {
    const seen = new Set<string>();
    for (const configuredCapacity of configuredCapacities) {
      for (const activeBedCount of bedCounts) {
        const resolved = resolveEffectiveLodgeCapacity({
          configuredCapacity,
          activeBedCount,
        });
        seen.add(resolved.source);
        expect(
          isLodgeSetUpForBookings(resolved.capacity),
          `${resolved.source} with configured=${configuredCapacity} beds=${activeBedCount}`,
        ).toBe(resolved.source !== "unconfigured_lodge");
      }
    }
    // Every source was exercised, so the agreement is not vacuous for any.
    expect([...seen].sort()).toEqual(
      ["capacity_override", "capped_beds", "configured_beds", "unconfigured_lodge"].sort(),
    );
  });

  it("depends on the save bound staying at one guest", () => {
    // If the minimum ever fell to 0, a configured lodge could resolve to 0 and
    // be told it is not set up. This pins the premise the helper rests on.
    expect(MIN_CONFIGURED_LODGE_CAPACITY).toBe(1);
  });
});

describe("lodgeGuestLimitMessage — the refusal every party-size door shows", () => {
  it("names the situation at an unconfigured lodge instead of quoting zero", () => {
    const message = lodgeGuestLimitMessage(0, bookingDoor);
    expect(message).toBe(LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE);
    expect(message).toContain("not set up for bookings yet");
    expect(message).not.toMatch(/\b0\b/);
  });

  // The three bookable states of the issue's table, each unchanged.
  it.each([
    ["capacity_override (module off, capacity 18)", { configuredCapacity: 18, activeBedCount: 0 }, 18],
    ["configured_beds (12 beds, no capacity)", { configuredCapacity: null, activeBedCount: 12 }, 12],
    ["capped_beds (40 beds, capacity 30)", { configuredCapacity: 30, activeBedCount: 40 }, 30],
  ])("keeps the door's own wording at %s", (_label, input, limit) => {
    const resolved = resolveEffectiveLodgeCapacity(input);
    expect(resolved.capacity).toBe(limit);
    expect(lodgeGuestLimitMessage(resolved.capacity, bookingDoor)).toBe(
      `A booking cannot exceed ${limit} guests`,
    );
  });
});
