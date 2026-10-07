import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * Every `redeemPromoCode(` call site, against a reviewed allowlist (#3826,
 * epic #3813 C1).
 *
 * WHY: since #3826 the database no longer refuses a booking's second
 * PromoRedemption — the unique is per booking AND code. While the
 * `multiPromoCodes` switch is off, `nextPromoApplicationOrder`
 * (`promo-redemption-slot.ts`) refuses it instead, by an UNLOCKED
 * read-then-write. That is safe only while every caller serialises writers to
 * the booking: it created the booking in the same transaction (nothing else can
 * see the row yet), or it holds the global lifecycle lock
 * `pg_advisory_xact_lock(1)`. A writer added without either can race a second
 * code onto a booking the previously deployed release reads as one-to-one.
 *
 * So the call sites are enumerated from the tree, comments stripped, and any
 * file or count not below fails. Extending the allowlist is the deliberate act
 * of a writer that has established the precondition — C2 of epic #3813 is
 * expected to be the next.
 */
const PRECONDITION =
  "redeemPromoCode's switch probe (nextPromoApplicationOrder, promo-redemption-slot.ts) is an unlocked read-then-write: its caller must either have created the booking in the same transaction or hold pg_advisory_xact_lock(1). Establish that, then add the call site here and say which in the comment.";

const REVIEWED_CALL_SITES: Record<string, { count: number; why: string }> = {
  "src/lib/booking-create.ts": {
    count: 3,
    why: "each call follows tx.booking.create in the same transaction",
  },
  "src/lib/booking-modify-plan.ts": {
    count: 1,
    why: "applyPromoCodeChanges, called only by booking-batch-modification-service.ts inside its pg_advisory_xact_lock(1) transaction",
  },
  "prisma/demo-seed.ts": {
    count: 1,
    why: "the demo seed, a single offline writer, on the booking it created a few statements earlier; no request path runs it",
  },
};

// A call, not the declaration in promo.ts.
const CALL = /(?<!function\s+)\bredeemPromoCode\s*\(/g;
// The function reached under another name, or handed on as a value, would be a
// call site this census cannot see. An alias is caught anywhere, import lists
// included; a by-value use is looked for only after the import and re-export
// lists are removed, because naming the function there is how a caller reaches it.
const ALIAS = /\bredeemPromoCode\s+as\b/;
const MODULE_LISTS = /\b(?:import|export)\s*(?:type\s*)?\{[^}]*\}\s*(?:from\s*["'][^"']+["'])?/g;
const BY_VALUE = /[=,(:]\s*redeemPromoCode\b(?!\s*\()/;

function census(): { calls: Record<string, number>; escapes: string[] } {
  const calls: Record<string, number> = {};
  const escapes: string[] = [];
  for (const file of sourceFiles()) {
    const raw = readFileSync(file, "utf8");
    if (!raw.includes("redeemPromoCode")) continue;
    const code = stripComments(raw);
    const path = relativeSource(file);
    const count = code.match(CALL)?.length ?? 0;
    if (count > 0) calls[path] = count;
    if (ALIAS.test(code) || BY_VALUE.test(code.replace(MODULE_LISTS, ""))) {
      escapes.push(path);
    }
  }
  return { calls, escapes };
}

describe("#3826: every redeemPromoCode call site serialises writers to its booking", () => {
  const { calls, escapes } = census();

  it("finds the reviewed call sites (the census is not vacuous)", () => {
    for (const path of Object.keys(REVIEWED_CALL_SITES)) {
      expect(calls[path], `${path} no longer calls redeemPromoCode; drop it from the allowlist`).toBeGreaterThan(0);
    }
  });

  it("refuses any call site not on the reviewed allowlist", () => {
    const unexpected = Object.entries(calls)
      .filter(([path, count]) => REVIEWED_CALL_SITES[path]?.count !== count)
      .map(([path, count]) => `${path} (${count} call${count === 1 ? "" : "s"}, reviewed ${REVIEWED_CALL_SITES[path]?.count ?? 0})`);
    expect(unexpected, `Unreviewed redeemPromoCode call site(s): ${unexpected.join("; ")}. ${PRECONDITION}`).toEqual([]);
  });

  it("refuses redeemPromoCode reached under an alias or passed as a value", () => {
    expect(escapes, `redeemPromoCode is aliased or passed by reference in: ${escapes.join(", ")}. The census cannot follow it. ${PRECONDITION}`).toEqual([]);
  });
});
