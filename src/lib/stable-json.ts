/**
 * Deterministic serialisation, for anything that HASHES a structure.
 *
 * `JSON.stringify` is insertion-ordered, so two objects carrying the same fields
 * in a different order serialise differently and therefore hash differently.
 * Every derived-identity digest in this codebase depends on that not happening:
 * a booking-exception proposal hash (`booking-exception-requests.ts`) proves a
 * stored row was not tampered with, an `EDIT_FINANCIAL_REVIEW` occurrence key
 * (`edit-financial-review.ts`, #3030) is what stops one unpriceable booking edit
 * raising two review tasks, and the diagnostics knowledge bundle's integrity
 * digest (`diagnostics/knowledge/hash.ts`) is compared against bytes already
 * written to disk. In all three cases a key that shifts with field order is not
 * an identity at all.
 *
 * `INV-SSOT`: this is the ONE home for the pieces those three share — the
 * recursive key sorter, the sha256-hex of a string, the "sorted JSON, then
 * sha256" composition, and the sorted-deduplicated night list that makes a date
 * set order-independent before it reaches any of them. #3030 collected them
 * here; before that the sorter existed TWICE (privately in
 * `booking-exception-requests.ts` and again in `diagnostics/knowledge/hash.ts`)
 * and the sorted-night helper existed once with a second copy about to be
 * written. Two copies that drift produce two different identities for the same
 * object, and nothing fails loudly when they do — which is precisely why the
 * digests are PINNED by test (`booking-exception-requests.test.ts`,
 * `edit-financial-review.test.ts`, `diagnostics/knowledge/__tests__/hash.test.ts`)
 * rather than merely recomputed on both sides.
 *
 * What deliberately stays OUT of here: `canonicalStringify`, whose 2-space
 * indent and trailing newline are load-bearing for the diagnostics bundle's
 * on-disk bytes and its byte ceilings. That formatting is specific to that
 * bundle, so it stays in `diagnostics/knowledge/hash.ts` and imports the sorter
 * from here.
 */

import { createHash } from "node:crypto";

/** Deterministic JSON with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Recursively sort object keys. Arrays keep their order — a caller that needs an
 * order-independent array sorts it itself, because for some arrays the order IS
 * the data.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortKeysDeep(record[key]);
    }
    return out;
  }
  return value;
}

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The digest of a structure: sorted JSON, then sha256, as lowercase hex.
 *
 * One function rather than two statements at each call site, because "stable
 * JSON" and "sha256 of it" drifting apart is not hypothetical — before #3030 one
 * of the two hashers passed the `"utf8"` encoding argument and the other did
 * not. Node defaults to utf8 so the bytes agreed, which is the worst kind of
 * near-miss: identical output, two spellings, and nothing to fail when a third
 * caller picks the wrong one.
 */
export function stableDigest(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/**
 * Sort and de-duplicate a night list, so a digest over it cannot depend on the
 * order a caller happened to walk the nights in.
 *
 * Takes `readonly string[]` rather than `readonly CalendarDate[]` on purpose:
 * both callers hold branded calendar dates, which are assignable to `string`,
 * and this module stays free of the club-time boundary it does not need.
 */
export function canonicalNights(nights: readonly string[]): string[] {
  return [...new Set(nights)].sort();
}
