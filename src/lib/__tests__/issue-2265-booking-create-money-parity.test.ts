import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

/**
 * #2265 (epic #2245, E1) scope item 2 — make the draft and confirmed create
 * branches structurally hard to diverge again.
 *
 * `POST /api/bookings` builds TWO hand-written argument objects over the same
 * parsed request body: one for `createDraftBooking`, one for
 * `createConfirmedBooking`. That is exactly how the member's credit election
 * was lost — the draft object simply never named `applyCreditCents`, nothing
 * rejected it, and the field was silently discarded on every save-as-draft.
 *
 * This guard reads the route source and asserts that every money-bearing field
 * appears in BOTH objects. It is a source-level check on purpose: the bug was
 * an absent key, so no behavioural test of the draft path could have caught it
 * without someone first thinking to write a credit-on-a-draft test.
 */

const ROUTE_PATH = join(
  process.cwd(),
  "src",
  "app",
  "api",
  "bookings",
  "route.ts",
);

/**
 * Fields that change what the member is charged, or what their charge is paid
 * with. A field listed here MUST be forwarded by both create branches; if a new
 * money-bearing input is added to the route, add it here too.
 */
const MONEY_BEARING_FIELDS = [
  "applyCreditCents",
  "promoCodeStr",
  "promoGuestIndexes",
  "workPartyEventId",
  "groupDiscount",
] as const;

/**
 * Collect the top-level keys of the object literal passed to `fnName(...)`,
 * ignoring anything nested inside a sub-object, sub-array or call.
 */
function topLevelArgumentKeys(rawSource: string, fnName: string): string[] {
  // Strip comments first: a field merely *mentioned* in prose must not satisfy
  // the guard, and a bracket inside a comment would derail the depth scan.
  const source = stripComments(rawSource);

  const opener = `${fnName}({`;
  const start = source.indexOf(opener);
  if (start < 0) {
    throw new Error(`Could not find a ${opener} call in ${ROUTE_PATH}`);
  }

  let depth = 1;
  let closed = false;
  let body = "";
  for (let index = start + opener.length; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) {
        closed = true;
        break;
      }
      continue;
    }
    // Only depth 1 is the argument object's own body; nested content is
    // discarded outright, so a nested key can never be counted.
    if (depth === 1) body += char;
  }
  if (!closed) {
    throw new Error(`Unbalanced argument object for ${fnName}`);
  }

  // Nested content is already gone, so every remaining comma separates two
  // top-level entries. Each entry is either `name` (shorthand) or `name: ...`.
  const keys = new Set<string>();
  for (const entry of body.split(",")) {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(entry);
    if (match) keys.add(match[1]);
  }
  return [...keys];
}

describe("#2265 booking create branches carry the same money-bearing fields", () => {
  const source = readFileSync(ROUTE_PATH, "utf8");
  const draftKeys = topLevelArgumentKeys(source, "createDraftBooking");
  const confirmedKeys = topLevelArgumentKeys(source, "createConfirmedBooking");

  it.each(MONEY_BEARING_FIELDS)(
    "forwards %s on the draft branch as well as the confirmed branch",
    (field) => {
      expect(confirmedKeys).toContain(field);
      expect(draftKeys).toContain(field);
    },
  );

  it("still finds a real, non-trivial argument object on each branch", () => {
    // Guards the guard: a parser that silently returned nothing would make
    // every assertion above vacuous.
    expect(draftKeys).toContain("effectiveMemberId");
    expect(confirmedKeys).toContain("effectiveMemberId");
    expect(draftKeys.length).toBeGreaterThan(10);
    expect(confirmedKeys.length).toBeGreaterThan(10);
  });

  it("does not mistake a nested key for a top-level one (fixture proof)", () => {
    const fixture = `
      await createDraftBooking({
        effectiveMemberId,
        groupDiscount: { nested: notATopLevelKey },
      });
    `;
    const keys = topLevelArgumentKeys(fixture, "createDraftBooking");
    expect(keys).toContain("groupDiscount");
    expect(keys).not.toContain("nested");
    expect(keys).not.toContain("notATopLevelKey");
  });
});
