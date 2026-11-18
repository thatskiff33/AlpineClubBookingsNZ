// The stored modification delta's value readers, moved verbatim from
// `booking-exception-request-service.ts` to keep that file under its size
// ceiling (#5145).

export function optionalDateOnly(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A stored explicit night set, canonicalised: date-only strings, deduped, sorted.
 * Absent or empty becomes `undefined` so the stored delta stays byte-stable
 * (`normalizeStoredExceptionDelta`'s contract) and a re-freeze of the same request
 * writes the same JSON.
 */
export function optionalNightList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nights = [
    ...new Set(
      value.filter(
        (night): night is string => typeof night === "string" && night.length > 0,
      ),
    ),
  ].sort();
  return nights.length > 0 ? nights : undefined;
}
