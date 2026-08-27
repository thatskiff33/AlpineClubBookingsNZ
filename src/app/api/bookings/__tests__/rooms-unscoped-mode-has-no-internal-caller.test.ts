import { describe, expect, it } from "vitest";

// The call-site sweep reads comment-stripped source. This file used to drop
// whole comment LINES only, which left a trailing comment on a line of code in
// place; the shared scanner tracks string and template literals, so it can strip
// those too without eating a `//` inside a URL. `commentBlocks` below
// deliberately still reads the RAW source — it is the sweep that reads exactly
// the part the other one throws away.
import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * `INV-INT-016` — the no-`lodgeId` mode of `GET /api/bookings/rooms` is kept for
 * consumers OUTSIDE this repository, and no client inside it may use it (#2678
 * surface 4).
 *
 * Three parts, and they are not the same claim:
 *
 *  - **The mode stays.** It is the pre-multi-lodge signature, and forked booking
 *    wizards and external integrations still call it that way, so requiring
 *    `lodgeId` would break them for no internal gain. From inside this tree the
 *    branch looks like dead code since #2677, which is exactly why it needs a
 *    rule with the reason attached rather than a test alone —
 *    `docs/invariants/integrations.md`.
 *  - **Nothing in `src/` calls it unscoped.** Internal reuse of the mode IS the
 *    #2664 defect: a picker on a booking whose lodge is already fixed loading
 *    club-wide room options and offering another lodge's rooms, which the writer
 *    then refuses. #2673 moved the requested-room picker onto a booking-scoped
 *    route and #2677 moved the wizard onto `?lodgeId=`; this stops the shape
 *    coming back.
 *  - **No comment in `src/` describes the mode's archived-lodge behaviour
 *    without citing the rule** (#2727). The prose about this endpoint is what
 *    kept the leak looking settled, so a paragraph that discusses it and
 *    archived lodges must point at `#2727` / `INV-INT-016` rather than restate a
 *    filter that has since changed.
 *
 * The call-site sweep reads COMMENT-STRIPPED source, because several files
 * discuss the unscoped mode at length in prose — including the route that
 * replaced it — and a plain text search reads those explanations as call sites.
 * The prose sweep reads exactly the part the other one throws away.
 */

const ROUTE = "/api/bookings/rooms";

function sourceFiles({ includeTests = false } = {}): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" && !includeTests) continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name) && !includeTests) continue;
      files.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
    }
  };
  walk(path.resolve(process.cwd(), "src"));
  return files;
}

/**
 * Runs of consecutive comment lines, as one string each. Prose about this
 * endpoint is written in long blocks, so the block — not the line — is the unit
 * a claim and its issue anchor share.
 */
function commentBlocks(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of source.split("\n")) {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) {
      current.push(line);
      continue;
    }
    if (current.length) blocks.push(current.join("\n"));
    current = [];
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

describe("INV-INT-016: /api/bookings/rooms unscoped mode (#2678)", () => {
  it("has no caller in src/ that omits lodgeId", () => {
    const unscoped: string[] = [];
    for (const file of sourceFiles()) {
      // The endpoint's own handler names its path in a URL only incidentally;
      // it is the thing being called, not a caller.
      if (file === "src/app/api/bookings/rooms/route.ts") continue;
      const code = stripComments(readFileSync(file, "utf8"));
      // Every literal reference to the route, with whatever query string is
      // attached, up to the closing quote or template backtick.
      for (const match of code.matchAll(
        new RegExp(`${ROUTE}([^"'\`\\n]*)`, "g"),
      )) {
        const query = match[1];
        if (query.includes("lodgeId")) continue;
        unscoped.push(`${file}: ${match[0]}`);
      }
    }
    expect(
      unscoped.sort(),
      `A client in src/ calls ${ROUTE} without a lodgeId. That is the #2664 ` +
        "defect: room options for a booking (or a wizard step) whose lodge is " +
        "already fixed must be scoped to that lodge server-side, or the picker " +
        "offers rooms the writer will refuse. The unscoped mode exists for " +
        "FORKED and EXTERNAL consumers only — see INV-INT-016 in " +
        "docs/invariants/integrations.md.",
    ).toEqual([]);
  });

  it("still SERVES the unscoped mode, so a fork's pre-multi-lodge call keeps working", () => {
    // The complement, and the half a "no internal caller" test cannot state on
    // its own: the rule is "keep it and stop calling it", not "remove it". A
    // future tidy-up that deletes the branch because nothing internal uses it
    // fails here rather than shipping a breaking change to a documented
    // endpoint.
    const route = stripComments(
      readFileSync("src/app/api/bookings/rooms/route.ts", "utf8"),
    );
    // The unscoped branch: no `lodgeId` on the query string falls through to an
    // eligibility-filtered cross-lodge listing rather than a 400.
    expect(route).toContain("getEligibleLodgeIdsForMember");
    expect(route).not.toMatch(/lodgeId\s+is\s+required/i);
    // A missing lodgeId must not be turned into a refusal.
    expect(route).not.toMatch(
      /if\s*\(\s*!lodgeId\s*\)[\s\S]{0,120}status:\s*400/,
    );
  });

  it("has no comment in src/ describing this endpoint's archived-lodge behaviour without anchoring it to #2727", () => {
    // #2727's own review found the leak still asserted in the PRESENT TENSE by
    // two surviving comments (`use-booking-wizard.ts` and its room-options-scope
    // test) after the route and three docs copies had been corrected. That is
    // the same defect class the issue was filed to close — a settled-sounding
    // DESCRIPTION of the leak, in a file no gate reads — so pin it rather than
    // fix the two copies and hope.
    //
    // The rule is deliberately not a banned-phrase list, which only moves the
    // wording. Any comment block in `src/` that discusses BOTH this endpoint and
    // archived lodges must cite `#2727` or `INV-INT-016`, so the reader is
    // always one hop from the current rule and the next person to write such a
    // paragraph has to go and read it. Tests are swept too: one of the two stale
    // copies was a test header.
    const unanchored: string[] = [];
    for (const file of sourceFiles({ includeTests: true })) {
      for (const block of commentBlocks(readFileSync(file, "utf8"))) {
        if (!block.includes(ROUTE)) continue;
        if (!/archiv/i.test(block)) continue;
        if (/#2727|INV-INT-016/.test(block)) continue;
        unanchored.push(`${file}: ${block.trim().split("\n")[0].trim()}`);
      }
    }
    expect(
      unanchored.sort(),
      `A comment in src/ describes ${ROUTE} and archived lodges without citing ` +
        "#2727 or INV-INT-016. Since #2727 the unscoped mode DOES filter on " +
        "Lodge.active, so any such paragraph written before that reads as a " +
        "live claim that it does not. Rewrite it in the past tense and cite the " +
        "rule — docs/invariants/integrations.md, INV-INT-016.",
    ).toEqual([]);
  });
});
