// #2779 — the member-facing surfaces of the pick-up-and-pay journey, and the
// guides that describe them, held together.
//
// WHY. The journey exists for exactly one person: a member whose unpaid
// subscription stops them booking, who has to be told that a booking the club
// saved for them can still be opened and paid. The first cut of this work updated
// the operator guides and the invariant, and left the MEMBER guides — the set
// that mirrors to the club wiki — still telling that member to press a "Resume"
// button that a club-saved draft does not have. Nothing catches that: neither
// `docs:linkcheck` nor `docs:indexcheck` reads prose for truth.
//
// So the pin is a lockstep one rather than a spell-check. Each control label is
// asserted to appear in BOTH the component that renders it and the member guide
// that names it, so renaming the control in the app fails here until the guide
// (and the in-app help corpus distilled from it — see docs/user-guide/README.md)
// is brought with it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  // Test helper: fixed repo paths under process.cwd(), never user input.
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * Collapse runs of whitespace.
 *
 * Guides are hard-wrapped at 80 columns and JSX prose is wrapped by the
 * formatter, so a phrase this file asserts on is routinely split across two
 * lines. Matching raw text would make the assertions fail on a reflow that
 * changed no words — which is how a lockstep test earns a reputation for noise
 * and gets deleted.
 */
function flat(relativePath: string): string {
  return read(relativePath).replace(/\s+/g, " ");
}

const DASHBOARD = "src/app/(authenticated)/dashboard/page.tsx";
const MEMBER_HELP = "src/lib/help/member-help.ts";
const BOOKING_GUIDE = "docs/user-guide/booking-a-stay.md";
const CHANGE_GUIDE = "docs/user-guide/changing-or-cancelling-a-booking.md";

/** The two control labels the member is told to look for. */
const CLUB_SAVED_LABEL = "Saved for you by the club";
const PAY_CTA = "Review & pay";

describe("#2779 member guides describe the controls the app renders", () => {
  it("the dashboard really renders the label and CTA the guides name", () => {
    const dashboard = flat(DASHBOARD);

    expect(dashboard).toContain(CLUB_SAVED_LABEL);
    expect(dashboard).toContain(PAY_CTA);
    // And still the ordinary word for a draft the member started themselves,
    // which is what the guides' existing "Resume" paragraph describes.
    expect(dashboard).toContain('"Resume"');
  });

  it("Booking a stay tells a locked-out member the door that is open", () => {
    const guide = flat(BOOKING_GUIDE);

    // The section, and its anchor — the change/cancel guide links to it.
    expect(guide).toContain("### A booking the club saved for you");
    expect(guide).toContain(CLUB_SAVED_LABEL);
    expect(guide).toContain(PAY_CTA);
    // The point of the whole journey, said in the member's own words.
    expect(guide).toMatch(/subscription is unpaid|unpaid subscription/);
    expect(guide).toMatch(/stops you \*starting\* a booking/);
    // Both edges INV-LOCKOUT-070 requires wherever the journey is offered.
    expect(guide).toContain("72 hours");
    expect(guide).toMatch(/\$0/);
  });

  it("Changing or cancelling stops calling a club-saved draft 'Resume'", () => {
    const guide = flat(CHANGE_GUIDE);

    expect(guide).toContain(CLUB_SAVED_LABEL);
    expect(guide).toContain(PAY_CTA);
    // The deletion, stated as deletion: a member told a draft "expires" looks
    // for a lapsed booking that is not there.
    expect(guide).toMatch(/removed 72 hours|removed \*\*72 hours\*\*/);
    expect(guide).toContain("deleted, not cancelled");
    // Cross-link to the fuller explanation, so the anchor above stays live.
    expect(guide).toContain("booking-a-stay.md#a-booking-the-club-saved-for-you");
  });

  it("the in-app help corpus carries the same answer", () => {
    // docs/user-guide/README.md makes this a standing rule: change a member
    // guide, review the matching corpus entry in the same pull request. The
    // widget is where a member actually asks "what is this booking I did not
    // make?".
    const corpus = flat(MEMBER_HELP);

    expect(corpus).toContain(CLUB_SAVED_LABEL);
    expect(corpus).toContain(PAY_CTA);
    expect(corpus).toContain("72 hours");
  });
});
