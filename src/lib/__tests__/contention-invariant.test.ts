import { describe, expect, it } from "vitest";
import {
  evaluateContentionOccupancy,
  evaluateOccupancyCeiling,
} from "../../../load/lib/contention-invariant.js";

describe("contention occupancy invariant", () => {
  it("requires the exact capacity-limited occupancy delta", () => {
    expect(
      evaluateContentionOccupancy({
        baseline: 0,
        finalOccupied: 20,
        capacity: 20,
        attempts: 100,
      }),
    ).toEqual({ expectedFinal: 20, passed: true });

    expect(
      evaluateContentionOccupancy({
        baseline: 4,
        finalOccupied: 14,
        capacity: 20,
        attempts: 10,
      }),
    ).toEqual({ expectedFinal: 14, passed: true });
  });

  it("fails when even one expected capacity hold is omitted", () => {
    expect(
      evaluateContentionOccupancy({
        baseline: 0,
        finalOccupied: 19,
        capacity: 20,
        attempts: 100,
      }).passed,
    ).toBe(false);
    expect(
      evaluateContentionOccupancy({
        baseline: 4,
        finalOccupied: 13,
        capacity: 20,
        attempts: 10,
      }).passed,
    ).toBe(false);
  });

  it("fails an already over-capacity baseline", () => {
    expect(
      evaluateContentionOccupancy({
        baseline: 21,
        finalOccupied: 20,
        capacity: 20,
        attempts: 1,
      }).passed,
    ).toBe(false);
  });
});

describe("occupancy ceiling invariant (#4940)", () => {
  const night = (occupied: unknown, capacity: unknown = 20) => ({
    lodgeId: "lodge-a",
    night: "2026-10-29",
    occupied,
    capacity,
  });

  it("passes when every observed night is at or under capacity", () => {
    expect(
      evaluateOccupancyCeiling([night(0), night(19), night(20)]),
    ).toEqual({ passed: true, violations: [] });
  });

  it("fails a single night one bed over capacity", () => {
    const result = evaluateOccupancyCeiling([night(20), night(21)]);
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([night(21)]);
  });

  it("fails a missing, non-numeric or negative reading rather than reading it as zero", () => {
    for (const bad of [undefined, null, "n/a", Number.NaN, -1]) {
      expect(evaluateOccupancyCeiling([night(bad)]).passed).toBe(false);
    }
    expect(evaluateOccupancyCeiling([night(3, null)]).passed).toBe(false);
  });

  it("fails when nothing was observed", () => {
    expect(evaluateOccupancyCeiling([]).passed).toBe(false);
  });
});
