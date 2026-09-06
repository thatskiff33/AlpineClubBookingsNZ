// #3214 (epic #2797) — the booking page's gate on the "Record what these nights
// sold for" section.
//
// WHY THIS IS A SOURCE-TEXT CONTRACT AND NOT A RENDER TEST. The same reasoning
// its two neighbours in this directory give: the section lives inside an async
// React Server Component two thousand lines long that loads a booking, a
// session, module flags, payments, credits, group state and lodge settings
// before it renders anything, and standing all of that up tests the mocks.
//
// What has to be true here is narrow, structural, and each item is a real
// failure mode rather than tidiness:
//
//  * it must be ADMIN-ONLY. The list names guest strands and says which of them
//    the club cannot price — neither is a thing a member may receive;
//  * it must be withheld while a financial review is OPEN. The settle screen
//    owns these figures then, and its target also includes the amount being
//    settled, so two surfaces would be asking for one set of figures against two
//    different targets. The route refuses on the same condition under its own
//    transaction, so this is about what to OFFER — but a screen that offers work
//    the route will refuse is its own defect;
//  * it must read `financialReviewPending` rather than asking again. The page
//    already holds that flag, and a second query is a second answer that can
//    disagree with the member's own banner on the same page load — the exact
//    reasoning the file states for `financialReviewWarnings`;
//  * it must be skipped for a DELETED booking, which prices nothing.
//
// Comments are stripped before matching, so the paragraph explaining a guard can
// never stand in for the guard.
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

// #2958 split the page: the admin-gated reads live in `_lib`, the tools card's
// render site in `_components`, and the one financial-review read in the
// history module. The gate is asserted where it now lives; the ONE-read rule is
// asserted over the whole route directory, because that is the unit the page
// load spans.
const ROUTE_DIR = "src/app/(authenticated)/bookings/[id]";
const ADMIN_TOOLS = `${ROUTE_DIR}/_lib/booking-detail-admin-tools.ts`;
const ADMIN_TOOLS_SECTION = `${ROUTE_DIR}/_components/booking-admin-tools-section.tsx`;

function readSource(relative: string): string {
  // Test helper: a fixed repo file under process.cwd(), not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

/** Every production source file the booking page load spans, comments stripped. */
function readRouteSources(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  };
  walk(path.resolve(process.cwd(), ROUTE_DIR));
  expect(files.length).toBeGreaterThan(10);
  return files.map((file) => stripComments(readFileSync(file, "utf8"))).join("\n");
}

describe("#3214 stored-night-price section gate", () => {
  const source = stripComments(readSource(ADMIN_TOOLS));

  it("is admin-only, live-booking-only and withheld while a review is open", () => {
    expect(source).toContain(
      "canSeeAdminTools && !isDeleted && !financialReviewPending",
    );
    expect(source).toContain(
      "await strandNightPriceOffersForBooking(booking.id, prisma)",
    );
  });

  it("reuses the flag the page already read rather than querying again", () => {
    // ONE read of "is a review open on this booking", so the member's banner and
    // this section cannot disagree about the same booking on the same page load.
    const reads = readRouteSources().match(/bookingHasOpenFinancialReview\(/g) ?? [];
    expect(reads).toHaveLength(1);
    // …and this module does not read it at all: it is handed the flag.
    expect(source).not.toContain("bookingHasOpenFinancialReview");
  });

  it("hands the offers to the admin tools card", () => {
    expect(stripComments(readSource(ADMIN_TOOLS_SECTION))).toContain(
      "storedNightPriceOffers={storedNightPriceOffers}",
    );
  });
});
