// #2779 — the "Save as Draft" explainer on the admin booking wizard's review
// step, and the one owner type it must NOT make a promise to.
//
// WHY THIS MATTERS ENOUGH TO PIN. The explainer tells the officer that saving a
// draft "leaves the booking for the member to pay for themselves … it appears on
// their dashboard". For a member owner that is exactly right, and it is the whole
// point of #2779. For the OTHER owner this same wizard books — a non-login
// non-member (#1935) — every clause of it is false: they have no account, no
// dashboard, and nothing is emailed about a draft. The officer reads the promise,
// presses Save as Draft, tells nobody, and 72 hours later `draft-cleanup` DELETES
// the booking. Nobody could have paid it, and the bed the officer believed was
// held was never held.
//
// WHY A SOURCE-TEXT CONTRACT AND NOT A RENDER TEST. Same reasoning as
// `issue-2779-draft-pickup-card.test.ts`: the wizard is a ~1,300-line client
// component that owns member search, a quote round-trip, capacity, promos,
// credit, hosting justification and two confirm dialogs. Standing all of that up
// tests the mocks. What has to be true here is one branch and which sentence sits
// on each side of it.
//
// Comments are stripped before matching, so the paragraph explaining the branch
// can never stand in for the branch.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Comments are stripped so only EXECUTABLE text is matched.
import { stripComments } from "@/lib/__tests__/support/strip-comments";

const PAGE = "src/app/(admin)/admin/book/page.tsx";

function readPageSource(): string {
  // Test helper: a fixed repo file under process.cwd(), not user input.
  return readFileSync(path.resolve(process.cwd(), PAGE), "utf8");
}

/**
 * Collapse runs of whitespace.
 *
 * JSX prose is wrapped by the formatter at whatever column the surrounding
 * indentation leaves, so "pay for themselves" is split across lines in the file.
 * Matching raw text would make these assertions fail on a reindent that changed
 * no words — which teaches the next agent to delete them.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("#2779 Save as Draft explainer is owner-type aware", () => {
  const source = stripComments(readPageSource());

  it("branches on the owner having no account", () => {
    const branch = source.indexOf("selectedMember?.isNonMember ? (");
    const nonMemberNote = source.indexOf(
      'data-testid="save-as-draft-nonmember-note"',
    );
    const memberNote = source.indexOf('data-testid="save-as-draft-member-note"');

    expect(branch, "the explainer must be branched, not unconditional").toBeGreaterThan(-1);
    expect(nonMemberNote).toBeGreaterThan(branch);
    expect(memberNote).toBeGreaterThan(nonMemberNote);
  });

  it("never promises a non-member owner will see or pay the draft", () => {
    const nonMemberNote = source.indexOf(
      'data-testid="save-as-draft-nonmember-note"',
    );
    const memberNote = source.indexOf('data-testid="save-as-draft-member-note"');
    const nonMemberCopy = flatten(source.slice(nonMemberNote, memberNote));

    expect(nonMemberCopy).toContain("will not reach this owner");
    expect(nonMemberCopy).toContain("non-member with no account");
    // The consequence, not just the fact: an unconfirmed draft is deleted and the
    // beds were never held.
    expect(nonMemberCopy).toContain("72 hours");
    expect(nonMemberCopy).toContain("Confirm Booking");
    // The member promise must not appear on this side of the branch.
    expect(nonMemberCopy).not.toContain("their dashboard");
    expect(nonMemberCopy).not.toContain("pay for themselves");
  });

  it("keeps the pick-up-and-pay explanation for an owner who has a login", () => {
    const memberNote = source.indexOf('data-testid="save-as-draft-member-note"');
    const memberCopy = flatten(source.slice(memberNote));

    expect(memberCopy).toContain(
      "leaves the booking for the member to pay for themselves",
    );
    expect(memberCopy).toContain("Saved for you by the club");
    // The two edges INV-LOCKOUT-070 requires stated wherever the journey is
    // offered: the 72-hour clock and the $0 dead end.
    expect(memberCopy).toContain("72 hours");
    expect(memberCopy).toContain("A $0 booking has nothing to pay");
  });
});
