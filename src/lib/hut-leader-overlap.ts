/**
 * Calculate the number of overlapping days between two date ranges.
 * Returns 0 if no overlap.
 */
export function calculateOverlapDays(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): number {
  const overlapStart = aStart > bStart ? aStart : bStart;
  const overlapEnd = aEnd < bEnd ? aEnd : bEnd;
  const diffMs = overlapEnd.getTime() - overlapStart.getTime();
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
}
