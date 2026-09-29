/**
 * #3407 — a lodge with no capacity says it is not set up for bookings yet,
 * rather than quoting a limit of zero (owner decision, 14 Sep 2026).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "@/lib/__tests__/support/strip-comments";
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

/*
  Census (reads `src/` from disk, so `test:related` cannot select it). Every
  party-size refusal that quotes a lodge's limit must reach the person through
  `lodgeGuestLimitMessage`, or a lodge with no capacity quotes "0 guests" again.
  The shape it polices: a template literal saying a party exceeds / is larger
  than a limit that interpolates a CAPACITY value directly. Inside the helper's
  callback the interpolation is `${limit}`, which this does not match.

  Comments are stripped first (the shared `stripComments`): an odd number of
  backticks in a comment would otherwise flip the literal pairing for the rest
  of the file, and a comment naming the helper would count as a door.
*/
describe("no party-size refusal interpolates a capacity directly (#3407)", () => {
  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") {
          found.push(...sourceFiles(full));
        }
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
    return found;
  }

  const REFUSAL = /(?:exceeds?|larger than)/i;
  const CAPACITY_INTERPOLATION = /\$\{[^}]*[Cc]apacity[^}]*\}/;

  function violations(source: string): string[] {
    return (source.match(/`[^`]*`/g) ?? []).filter(
      (literal) => REFUSAL.test(literal) && CAPACITY_INTERPOLATION.test(literal),
    );
  }

  it("finds none in src/, and the helper is actually used at the doors", () => {
    const files = sourceFiles(join(process.cwd(), "src"));
    const offenders: string[] = [];
    let helperCalls = 0;
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const literal of violations(source)) {
        offenders.push(`${relative(process.cwd(), file).split("\\").join("/")}: ${literal}`);
      }
      // Call sites only: the helper's own definition is not a door.
      if (!file.endsWith("lodge-booking-readiness.ts")) {
        helperCalls += (source.match(/lodgeGuestLimitMessage\(/g) ?? []).length;
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard, over real call sites only (comments stripped, the
    // definition excluded): the fifteen doors that quote a limit today. This
    // issue converted sixteen — fourteen member and officer refusals, the
    // public school form's client-side one, and the group-discount policy's
    // minimum-size check — and its review then deleted one of them, the
    // add-guests payload pre-check, which measured the default lodge before
    // the booking's own lodge was known.
    expect(helperCalls).toBeGreaterThanOrEqual(15);
  });

  it("would flag the pre-#3407 spelling", () => {
    expect(
      violations("x = `A booking cannot exceed ${lodgeCapacity} guests`;"),
    ).toHaveLength(1);
    expect(
      violations("x = lodgeGuestLimitMessage(c, (limit) => `A booking cannot exceed ${limit} guests`);"),
    ).toHaveLength(0);
  });
});
