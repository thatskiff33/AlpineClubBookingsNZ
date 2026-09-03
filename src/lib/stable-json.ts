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
 * recursive key sorter, deterministic stringification, and the
 * sorted-deduplicated night list that makes a date set order-independent before
 * it reaches any of them. #3030 collected them
 * here; before that the sorter existed TWICE (privately in
 * `booking-exception-requests.ts` and again in `diagnostics/knowledge/hash.ts`)
 * and the sorted-night helper existed once with a second copy about to be
 * written. Two copies that drift produce two different identities for the same
 * object, and nothing fails loudly when they do — which is precisely why the
 * digests are PINNED by test (`booking-exception-requests.test.ts`,
 * `edit-financial-review.test.ts`, `diagnostics/knowledge/__tests__/hash.test.ts`)
 * rather than merely recomputed on both sides. Those three pin what each CALLER
 * builds. `__tests__/stable-digest.test.ts` (#3218) pins the machinery here —
 * the sorter's exact bytes on hostile input, and the digest they produce — so a
 * change to the serialisation fails on its own account rather than only through
 * whichever caller's fixture happened to notice.
 *
 * THIS MODULE IS CLIENT-SAFE, AND MUST STAY THAT WAY. It imports nothing —
 * not `node:crypto`, not the club-time boundary, nothing. That is load-bearing
 * rather than tidy: `booking-exception-requests.ts` is reached from seven
 * `"use client"` entry points (the booking editor, the review step, the officer
 * approval card, the admin requests panel), so everything it imports is
 * compiled into the browser bundle. `INV-OPS-013` and
 * `client-server-boundary-census.test.ts` enforce that, and they caught this
 * module the first time round: collecting the hashing helpers here dragged
 * `node:crypto` onto the client graph through a path no allowlist covered.
 *
 * So the sha256 helpers live next door in `stable-digest.ts`, which is
 * server-only, and the one client-reachable hasher
 * (`computeProposalHash`) keeps its own direct `node:crypto` import — the
 * single edge the census allowlist has always named, with its reasoning
 * attached there. Splitting the module along the boundary is what keeps that
 * allowlist one entry long instead of growing it to cover a shared helper that
 * any client module could then import.
 *
 * SINCE #2851 THIS IS HYGIENE RATHER THAN NECESSITY, and the change is recorded
 * rather than left to be discovered. `booking-exception-requests.ts` is no
 * longer reached from any `"use client"` entry point — the two constants the
 * client actually wanted moved to `@/lib/booking-exception-request-shared` —
 * so this module has zero client reach today and the census allowlist that
 * named the single edge no longer exists. Everything above describes why the
 * split was FORCED; what keeps it now is that the boundary moved once and can
 * move back, and keeping a client-safe module client-safe costs nothing while
 * re-establishing it costs a review. **Collapsing this into `stable-digest.ts`
 * is #3218** — a production edit on a booking path and a reversal of a recorded
 * decision, not something a branch sync may take.
 *
 * What deliberately stays OUT of here: `canonicalStringify`, whose 2-space
 * indent and trailing newline are load-bearing for the diagnostics bundle's
 * on-disk bytes and its byte ceilings. That formatting is specific to that
 * bundle, so it stays in `diagnostics/knowledge/hash.ts` and imports the sorter
 * from here.
 */

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
