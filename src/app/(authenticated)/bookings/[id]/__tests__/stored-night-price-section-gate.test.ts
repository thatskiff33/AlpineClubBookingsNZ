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
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

const PAGE = "src/app/(authenticated)/bookings/[id]/page.tsx";

function readPageSource(): string {
  // Test helper: a fixed repo file under process.cwd(), not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), PAGE), "utf8");
}

describe("#3214 stored-night-price section gate", () => {
  const source = stripComments(readPageSource());

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
    const reads = source.match(/bookingHasOpenFinancialReview\(/g) ?? [];
    expect(reads).toHaveLength(1);
  });

  it("hands the offers to the admin tools card", () => {
    expect(source).toContain("storedNightPriceOffers={storedNightPriceOffers}");
  });
});
