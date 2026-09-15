/**
 * HOW THE CONTACT CACHE'S FRESHNESS IS REPORTED TO A SCREEN — one shape
 * (#3058, `INV-SSOT`).
 *
 * `xero-contact-cache-freshness.ts` is the one place that ASKS how old the
 * shared Xero contact cache is. This is the one place that says how the answer
 * is SPELLED on the way out to an admin panel, and the two are separate modules
 * for the reason every `-shape` leaf here is: the reader reaches
 * `@/lib/prisma`, and a `"use client"` panel must be able to name the shape
 * without that on its graph (`INV-OPS-013`).
 *
 * Before this, two screens restated the shape independently — the
 * missing-contact census (`INV-INT-022`) and the erased-member review
 * (`INV-INT-024`) — and each engine hand-copied three fields across the
 * boundary from the reader's own names (`lastRefreshedAt`, `ageHours`,
 * `stale`). Asking one question in one place does not help if the answer is
 * then transcribed twice: a fourth fact about the cache would have reached
 * neither screen until somebody remembered both transcriptions.
 *
 * Both snapshots now EXTEND this, and both engines spread
 * {@link reportContactCacheFreshness} rather than naming fields. A field added
 * here appears on both screens, or fails to compile.
 */

export interface ReportedContactCacheFreshness {
  /** When the contact sync last completed, ISO, or `null` if it never has. */
  contactCacheLastRefreshedAt: string | null;
  /**
   * How old that cache is, in whole hours, and whether it is old enough to
   * mislead. EXISTENCE was checked from the start; AGE was not, and age is
   * exactly what turns a "no cached match" row into a duplicate — a six-month
   * old cache reads identically to a five-minute-old one.
   */
  contactCacheAgeHours: number | null;
  contactCacheStale: boolean;
}

/**
 * The reader's own field names, restated here so the mapper below is a LEAF.
 *
 * Structurally identical to `XeroContactCacheFreshness`, which is what the
 * reader returns — so the reader's value is accepted without a cast, and a
 * change to it that this no longer matches is a compile error at every call
 * site rather than a silent divergence.
 */
export interface ContactCacheFreshnessFacts {
  lastRefreshedAt: string | null;
  ageHours: number | null;
  stale: boolean;
}

/** The one translation between the reader's names and a screen's. */
export function reportContactCacheFreshness(
  freshness: ContactCacheFreshnessFacts,
): ReportedContactCacheFreshness {
  return {
    contactCacheLastRefreshedAt: freshness.lastRefreshedAt,
    contactCacheAgeHours: freshness.ageHours,
    contactCacheStale: freshness.stale,
  };
}
