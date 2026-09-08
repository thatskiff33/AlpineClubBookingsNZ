/**
 * ## WHY THIS IS ITS OWN MODULE, AND NOT PART OF `stable-digest.ts`
 *
 * That is where it belongs by subject — right beside `canonicalNights`, the
 * other order-normalising helper — and it was written there first. It cannot
 * stay there, and the reason is a rule `stable-digest.ts`'s own docblock states:
 * that module imports `node:crypto`, and `INV-OPS-013`'s client/server boundary
 * census refuses `node:crypto` on the browser graph.
 *
 * At least one identity path is deliberately browser-side.
 * `hosting-coverage-override-client.ts` computes a mutation signature in the
 * browser and says in its first paragraph "keep this module free of Prisma, Node
 * crypto and server-only imports"; six `"use client"` modules reach it. So a
 * comparator living next to the sha256 could not be the ONE home — the browser
 * path would have to keep its own copy, which is the duplication this module
 * exists to end.
 *
 * This file therefore imports NOTHING, which is exactly the remedy #2851 used
 * when the same boundary bit `booking-exception-requests.ts`. Do not add an
 * import to it, and do not re-export it from `stable-digest.ts`: one symbol
 * reachable by one specifier is what lets `identity-ordering-census.test.ts`
 * enforce the rule by grepping for a second copy.
 */
/**
 * Ordinal (code-unit) string comparison, for every ORDER that is part of an
 * IDENTITY. Returns -1, 0 or 1, so it drops straight into `Array#sort`.
 *
 * **Never `localeCompare` on an identity path.** `localeCompare` with no locale
 * argument uses whatever collation the runtime resolves from its environment,
 * and that ordering is not the same in every locale — nor, more quietly, in
 * every ICU build. A sort that decides the ORDER of a list which is then
 * serialised and hashed therefore makes the resulting key depend on a setting
 * nothing in this repository pins. The key is re-derived later, on a machine
 * that may resolve differently, and the mismatch surfaces as "this was
 * tampered with" rather than as "the configuration moved" (#3252).
 *
 * ## The evidence, measured rather than argued
 *
 * The production container (`node:24.17-alpine`, `TZ` pinned and no `LANG`)
 * resolves `en-US` on **ICU 78.3**; a development machine resolved `en-NZ` on
 * **ICU 78.2**. The very thing nothing pins is ALREADY different between two
 * environments meant to agree, moved by an ordinary base-image rebuild that
 * nobody thought of as a change. Measured on the live server, these pairs order
 * one way under `localeCompare` and the other way here:
 *
 * | pair | `localeCompare` | this |
 * | --- | --- | --- |
 * | `"de la Cruz"` vs `"Delacruz"` | −1 | **+1** |
 * | `"Smith"` vs `"smith"` | +1 | **−1** |
 * | `"Ändersson"` vs `"Zeller"` | −1 under `en`/`de` | **+1**, and +1 under `da`/`sv` |
 *
 * A surname with a space in it is not exotic in this club's membership, so the
 * divergent case is ordinary rather than contrived.
 *
 * ## What this is NOT for
 *
 * Anything a person READS — a screen, an email, a CSV, a report. There
 * locale-aware ordering is correct, and this comparator would put `Zeller`
 * before `Ändersson` in a way no human calls alphabetical. The distinction is
 * the whole rule: **an identity is ordered for reproducibility, a list is
 * ordered for a reader.** `INV-SSOT-001` is why there is one of these rather
 * than a fourth hand-rolled copy — `hut-leader-coverage.ts`,
 * `email-message-token-contract.ts` and `adult-member-hosting-same-owner.ts`
 * each wrote their own, each with a docblock explaining the same fact.
 *
 * `identity-ordering-census.test.ts` enforces both halves: no second
 * hand-rolled copy, and no bare `localeCompare` in an identity module.
 */
export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
