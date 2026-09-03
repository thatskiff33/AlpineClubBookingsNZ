/**
 * Deterministic identity: sorted JSON, and the sha256 digest of it.
 *
 * `JSON.stringify` is insertion-ordered, so two objects carrying the same fields
 * in a different order serialise differently and therefore hash differently.
 * Every derived-identity digest in this codebase depends on that not happening:
 * a booking-exception proposal hash (`booking-exception-requests.ts`) proves a
 * stored row was not tampered with, an `EDIT_FINANCIAL_REVIEW` occurrence key
 * (`edit-financial-review-occurrence.ts`, #3030) is what stops one unpriceable
 * booking edit raising two review tasks, and the diagnostics knowledge bundle's
 * integrity digest (`diagnostics/knowledge/hash.ts`) is compared against bytes
 * already written to disk. In all three cases a key that shifts with field order
 * is not an identity at all.
 *
 * `INV-SSOT`: this is the ONE home for everything those three share — the
 * recursive key sorter, deterministic stringification, the
 * sorted-deduplicated night list that makes a date set order-independent before
 * it reaches any of them, and the sha256 that turns the bytes into a key.
 *
 * ## Why this was two modules until #3218, and why it is one now
 *
 * #3030 collected the sorter here from the two private copies it had grown
 * (`booking-exception-requests.ts` and `diagnostics/knowledge/hash.ts`), and had
 * to split the result in half. `booking-exception-requests.ts` was reached from
 * seven `"use client"` entry points, so everything it imported was compiled into
 * the browser bundle; `client-server-boundary-census.test.ts` failed exactly as
 * `INV-OPS-013` intends when `node:crypto` arrived on the client graph through
 * the new shared module. The canonicalisation therefore lived in a
 * `stable-json.ts` that imported nothing at all, the sha256 lived here, and
 * `computeProposalHash` kept its own direct `node:crypto` import as the single
 * allowlisted census edge. That left "sha256 of stable JSON" written in two
 * places, which `INV-SSOT` would normally refuse — an accepted exception, taken
 * because the boundary outranked the duplication.
 *
 * **#2851 removed the boundary.** The two values the client actually wanted
 * moved to `@/lib/booking-exception-request-shared`, nothing under `"use client"`
 * reaches either module, and the census allowlist that named the single edge no
 * longer exists in any form. #3218 collapsed the two halves back together and
 * retired the exception rather than leaving one on the books describing a
 * constraint that had expired.
 *
 * The collapse was **measured, not argued**. `computeProposalHash` now calls
 * `stableDigest` instead of spelling the same composition out, and the literal
 * digests pinned in `__tests__/stable-digest.test.ts`,
 * `__tests__/booking-exception-requests.test.ts`,
 * `__tests__/edit-financial-review.test.ts` and
 * `diagnostics/knowledge/__tests__/hash.test.ts` passed the change UNCHANGED.
 * That is what makes byte-identity a fact here: a stored `proposalHash` still
 * validates, because a digest that had moved would have failed a named test on a
 * known hash instead of surfacing months later as an unexplained mismatch.
 *
 * If the client boundary ever moves back, the fix is the one #2851 used — split
 * the client-safe values into a module that imports nothing — not a re-split of
 * this one and not an allowlist entry.
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
 * caller picks the wrong one. Until #3218 there were still two spellings, and
 * this is now the only one.
 */
export function stableDigest(value: unknown): string {
  return sha256Hex(stableStringify(value));
}
