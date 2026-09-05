// #2919 — the live member booking page must supply EVERY declared
// booking-message token, and must resolve {{CLUB_LODGE_NAME}} from the
// BOOKING'S lodge.
//
// WHY A SOURCE-TEXT CONTRACT. `BookingMessageMergeData` is
// `Partial<Record<BookingMessageToken, ...>>`, deliberately so (the issue's
// decision record keeps it Partial rather than redesigning the contract), which
// means a token the page forgets is perfectly legal to the compiler and
// `renderBookingMessageTemplate` quietly substitutes "". That is exactly how
// this defect shipped: the admin preview rendered {{CLUB_LODGE_NAME}} from
// club-level settings while the member's page rendered a blank, and nothing
// anywhere failed. This file is the check the type system declines to be.
//
// The alternative — standing up the async React Server Component, which loads a
// booking, a session, module flags, payments, credits and lodge settings before
// it builds anything — would test the mocks, not the rule (the same reasoning
// arrival-instructions-consent-gate.test.ts records for the door-code gate).
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Comments are stripped so only EXECUTABLE text is matched.
import { stripComments } from "@/lib/__tests__/support/strip-comments";
import {
  BOOKING_MESSAGE_DEFINITIONS,
  renderBookingMessageTemplate,
} from "@/lib/booking-message-definitions";

const PAGE = "src/app/(authenticated)/bookings/[id]/page.tsx";

function readPageSource(): string {
  // Test helper: a fixed repo file under process.cwd(), not user input.
  return readFileSync(path.resolve(process.cwd(), PAGE), "utf8");
}

/** The executable text of the `const bookingMessageData = { ... }` literal. */
function bookingMessageDataLiteral(source: string): string {
  const code = stripComments(source);
  const start = code.indexOf("const bookingMessageData = {");
  expect(start).toBeGreaterThan(-1);
  const open = code.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  throw new Error("Unbalanced braces in bookingMessageData");
}

/** Top-level property names of an object literal's source text. */
function topLevelKeys(literal: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (depth === 1) {
      const rest = literal.slice(i);
      const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest);
      if (match && !/[\w$.]/.test(literal[i - 1] ?? "")) {
        keys.push(match[1]);
        i += match[0].length - 1;
      }
    }
  }
  return keys;
}

/** Every token any booking message may insert. */
const DECLARED_TOKENS = Array.from(
  new Set(BOOKING_MESSAGE_DEFINITIONS.flatMap((definition) => definition.tokens)),
).sort();

describe("the member booking page's booking-message merge data (#2919)", () => {
  it("supplies every token a booking message is allowed to insert", () => {
    const supplied = new Set(
      topLevelKeys(bookingMessageDataLiteral(readPageSource())),
    );
    const missing = DECLARED_TOKENS.filter((token) => !supplied.has(token));

    // A token an admin can insert but this page never supplies renders as an
    // empty string to the member while the admin preview shows a value.
    expect(missing).toEqual([]);
  });

  it("resolves the lodge name from THIS booking's lodge, not the club default", () => {
    const code = stripComments(readPageSource());
    const literal = bookingMessageDataLiteral(code);

    expect(literal).toContain("CLUB_LODGE_NAME: bookingLodgeEmailSettings.lodgeName");
    // And that settings object is the BOOKING's lodge identity — the club-level
    // `loadEmailMessageSettings()` (no lodge) would reinstate the defect.
    expect(code).toContain(
      "const bookingLodgeEmailSettings = await loadEmailMessageSettingsForLodge(",
    );
    expect(code).toMatch(
      /const bookingLodgeEmailSettings = await loadEmailMessageSettingsForLodge\(\s*booking\.lodgeId,?\s*\)/,
    );
  });

  it("renders an unsupplied token as a blank, which is why the list above must be complete", () => {
    const template = "Your stay at {{CLUB_LODGE_NAME}}.";

    expect(renderBookingMessageTemplate(template, {})).toBe("Your stay at .");
    expect(
      renderBookingMessageTemplate(template, { CLUB_LODGE_NAME: "Second Lodge" }),
    ).toBe("Your stay at Second Lodge.");
  });
});
