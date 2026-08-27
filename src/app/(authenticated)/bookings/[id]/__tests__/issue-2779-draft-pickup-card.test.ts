// #2779 — the member booking page's DRAFT "Complete Booking" card, which is
// where a subscription-locked member actually pays for a booking an admin saved
// on their behalf (`INV-LOCKOUT-069`).
//
// WHY THIS IS A SOURCE-TEXT CONTRACT AND NOT A RENDER TEST. Same reasoning as
// `arrival-instructions-consent-gate.test.ts` beside it: the card lives inside an
// async React Server Component two thousand lines long that loads a booking, a
// session, module flags, payments, credits, group state and lodge settings before
// it renders anything. Standing all of that up tests the mocks. What has to be
// true here is narrow and structural, and each item below is a way the journey
// has a real failure mode:
//
//  * the card must stay OWNER-ONLY. It holds the member's own card-entry
//    controls (#1303), and #2779 changed the copy inside it — a widened
//    condition would put those controls in front of every officer who opens the
//    booking;
//  * the copy must distinguish a booking the CLUB made from one the member
//    saved. A booking a member never made, described as "your saved draft", reads
//    as somebody's mistake — and this member is being asked to pay for it;
//  * the deletion deadline must be stated HERE, not only on the dashboard. The
//    nightly `draft-cleanup` job DELETES an expired draft rather than cancelling
//    it, so a member who waits a week finds nothing at all (`INV-LOCKOUT-070`).
//
// Comments are stripped before matching, so the paragraph explaining a guard can
// never stand in for the guard.
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const PAGE = "src/app/(authenticated)/bookings/[id]/page.tsx";

function readPageSource(): string {
  // Test helper: a fixed repo file under process.cwd(), not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), PAGE), "utf8");
}

/** Strip `//` and block comments so only EXECUTABLE text is matched. */
function stripComments(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" = "code";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        i++;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        i++;
        continue;
      }
      out += c;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      continue;
    }
    if (c === "*" && next === "/") {
      state = "code";
      i++;
    }
  }
  return out;
}

describe("#2779 draft pick-up-and-pay card (INV-LOCKOUT-069/070)", () => {
  const source = stripComments(readPageSource());

  it("stays owner-only, DRAFT-only and priced-only", () => {
    // A $0 draft deliberately gets the ConfirmDraftButton branch instead — there
    // is nothing to pay, so an unpaid member cannot pick that one up at all and
    // an admin confirms it (INV-LOCKOUT-070).
    expect(source).toContain(
      "{isBookingOwner && !isDeleted && isDraft && booking.finalPriceCents > 0 && (",
    );
    expect(source).toContain(
      "{canManageBooking && !isDeleted && isDraft && booking.finalPriceCents === 0 && (",
    );
  });

  it("says the club saved it when an admin created it on the member's behalf", () => {
    expect(source).toContain("booking.createdBy");
    expect(source).toContain(
      "The club saved this booking for you. Review the details above, then pay to confirm it.",
    );
    // And still says the ordinary thing for a draft the member saved themselves.
    expect(source).toContain("This is a saved draft.");
  });

  it("exposes the card title as a real level-2 heading", () => {
    // A member navigating by headings has to be able to LAND on the pay door.
    // `CardTitle` renders a bare <div> with no role by default, so without this
    // the card is findable by sighted scanning only — on the one page a
    // subscription-locked member is sent to in order to pay. Level 2 because the
    // page's only <h1> is "Booking Details".
    //
    // #2796: asserted through the `headingLevel` PROP, not the raw ARIA this
    // test originally pinned. The mechanism moved into `CardTitle` itself, and
    // the contract test at
    // `src/components/ui/__tests__/card-title-heading-contract.test.ts` now
    // FORBIDS any call site hand-writing `role="heading"` / `aria-level`. Two
    // guards asserting the same property in two different spellings is how they
    // end up contradicting each other — which is exactly what happened here, and
    // CI caught it. The prop emits identical DOM and keeps the level
    // type-checked. Why it is ARIA rather than a native <h2>, and how to choose
    // a level, are recorded once in `docs/ARCHITECTURE.md` → "Card titles and
    // heading semantics (#2796)" rather than restated here.
    expect(source).toMatch(
      /<CardTitle headingLevel=\{2\}>\s*Complete Booking\s*<\/CardTitle>/,
    );
    // The other payment door on the same page, kept consistent.
    expect(source).toMatch(
      /<CardTitle headingLevel=\{2\}>\s*Complete Payment\s*<\/CardTitle>/,
    );
    expect(source).toContain('<h1 className="text-3xl font-bold">Booking Details</h1>');
  });

  it("states the deletion deadline on the page that takes the money", () => {
    expect(source).toContain('data-testid="draft-expiry-notice"');
    expect(source).toContain("booking.draftExpiresAt ? (");
    // A real INSTANT, so it renders in the club's PERSISTED timezone through the
    // request's binding rather than through `APP_TIME_ZONE` (CT-4, #2870;
    // INV-CONFIG-002). The deadline itself is unchanged; what moved is which
    // clock decides what "9:00 pm" means for a club that is not New Zealand.
    expect(source).toContain("club.instantDateTime(booking.draftExpiresAt)");
    // "removed", not "cancelled": the job deletes the row.
    expect(source).toMatch(/is removed and the booking will need to be made again/);
  });
});
