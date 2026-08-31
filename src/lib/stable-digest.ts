/**
 * The sha256 half of deterministic identity: sorted JSON, then a digest.
 *
 * This is deliberately a SEPARATE module from `@/lib/stable-json`, and the
 * separation is a boundary rather than a filing preference.
 *
 * `stable-json.ts` is reached from the browser bundle. `booking-exception-requests.ts`
 * imports its canonicalisation, and that module is imported by seven
 * `"use client"` entry points — the booking editor, the review step, the officer
 * approval card and the admin policy-exception panel among them. Anything
 * `stable-json.ts` imports is therefore compiled into the client bundle, so it
 * imports nothing at all.
 *
 * `node:crypto` obviously cannot go there. When #3030 first collected the
 * hashing helpers alongside the canonicalisation, `client-server-boundary-census.test.ts`
 * failed exactly as `INV-OPS-013` intends: a `"use client"` module reached
 * `node:crypto` through a path the census allowlist did not name. Keeping the
 * digest here is what fixes that at the structure rather than by widening the
 * allowlist — an allowlist entry for a shared digest helper would license every
 * future client module that imports it, which is the opposite of what the
 * invariant is for.
 *
 * The one hasher that IS on the client graph, `computeProposalHash` in
 * `booking-exception-requests.ts`, therefore does NOT import this module. It
 * keeps its own direct `node:crypto` import, which is the single edge the
 * census allowlist has always carried, with the reasoning attached there. That
 * leaves the "sha256 of stable JSON" composition stated in two places rather
 * than one, which `INV-SSOT` would normally refuse — the boundary wins, the
 * duplication is three lines, and both are pinned by fixed-digest tests
 * (`booking-exception-requests.test.ts`, `edit-financial-review.test.ts`) so a
 * drift between them fails loudly instead of silently re-identifying stored
 * rows.
 *
 * SINCE #2851 THE BOUNDARY THIS RESTS ON IS GONE, and the accepted exception
 * above now stands on a weaker footing than it did. `booking-exception-requests.ts`
 * is no longer reached from any `"use client"` entry point, so `stable-json.ts`
 * has zero client reach and the census allowlist that named the single edge no
 * longer exists — nothing forces `computeProposalHash` to keep its own
 * `node:crypto` import. The duplication survives because the boundary moved
 * once and can move back, not because it is impossible to remove; the
 * fixed-digest tests still make a drift between the two fail loudly.
 * **Collapsing them is #3218**, which is a production edit on a booking path
 * and a reversal of this decision rather than a correction to it.
 *
 * Server-only callers — `edit-financial-review.ts` (#3030) and the diagnostics
 * knowledge bundle — use this module.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "@/lib/stable-json";

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The digest of a structure: sorted JSON, then sha256, as lowercase hex.
 *
 * One function rather than two statements at each server call site, because
 * "stable JSON" and "sha256 of it" drifting apart is not hypothetical — before
 * #3030 one of the two hashers passed the `"utf8"` encoding argument and the
 * other did not. Node defaults to utf8 so the bytes agreed, which is the worst
 * kind of near-miss: identical output, two spellings, and nothing to fail when
 * a third caller picks the wrong one.
 */
export function stableDigest(value: unknown): string {
  return sha256Hex(stableStringify(value));
}
