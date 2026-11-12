/**
 * Exact occupancy oracle for the contention scenario. Keeping this free of
 * k6 imports lets Vitest prove that a missing capacity hold cannot pass.
 */
export function evaluateContentionOccupancy(input) {
  const expectedFinal = Math.min(
    input.capacity,
    input.baseline + input.attempts
  );
  return {
    expectedFinal: expectedFinal,
    passed:
      input.baseline >= 0 &&
      input.baseline <= input.capacity &&
      input.finalOccupied === expectedFinal,
  };
}

/**
 * Ceiling oracle for scenarios that cannot know the exact final occupancy
 * because their writes interleave creates, moves and cancels (#4940,
 * `mixed-writes.js`). Every observed night must be a finite, non-negative
 * count at or under its lodge's capacity. A missing or non-numeric reading
 * fails rather than passing as zero, so an availability response that drops
 * a night cannot turn the gate green.
 *
 * `readings` is one entry per lodge night: `{ lodgeId, night, occupied,
 * capacity }`. An empty list fails too: a teardown that observed nothing has
 * proved nothing.
 */
export function evaluateOccupancyCeiling(readings) {
  const violations = [];
  const list = Array.isArray(readings) ? readings : [];
  for (const reading of list) {
    const occupied = Number(reading && reading.occupied);
    const capacity = Number(reading && reading.capacity);
    const valid =
      isFinite(occupied) &&
      isFinite(capacity) &&
      occupied >= 0 &&
      capacity > 0 &&
      reading.occupied !== null &&
      reading.occupied !== undefined;
    if (!valid || occupied > capacity) {
      violations.push({
        lodgeId: reading && reading.lodgeId,
        night: reading && reading.night,
        occupied: reading && reading.occupied,
        capacity: reading && reading.capacity,
      });
    }
  }
  return {
    passed: list.length > 0 && violations.length === 0,
    violations: violations,
  };
}
