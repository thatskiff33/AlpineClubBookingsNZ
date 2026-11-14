import { describe, expect, it } from "vitest";
import {
  CARD_TITLE_OPEN,
  headingClassification,
  lineOf,
  read,
  SOURCE_FILES,
} from "./support/card-title-source";

/**
 * #4951 (`INV-PUB-005`) — every `CardTitle` classifies itself, ratcheted to
 * get there.
 *
 * The owner decided on #2796 (D1) that every card title says whether it is a
 * heading and at what level: `headingLevel={1…6}`, or `headingLevel="none"`
 * when the call site has looked and decided it is not part of the outline. An
 * opt-in that defaults to "no heading" is never finished — leaving the prop out
 * always compiles — so this census makes leaving it out fail instead:
 *
 * 1. **Member-facing code may not omit it at all.** Those are the screens a
 *    member reaches from an email link or their account, where #4951 found the
 *    screen-reader heading list empty.
 * 2. **Everywhere else is held at a falling baseline.** Admin and finance
 *    titles, and the member components used from more than one kind of page
 *    (the edit-booking panel, the booking editor, the guest-consent card), are
 *    swept area by area; each sweep lowers the baseline in the same change.
 *    When it reaches zero, `headingLevel` becomes required by the type and
 *    this census retires.
 *
 * Limits of a count. It is one number, so two sweeps that land together both
 * edit it, and a change that classifies one title while adding another
 * unclassified one in the same PR leaves it unchanged. Review a diff that
 * touches `CardTitle` for the second case; the first is a plain merge conflict
 * on one line.
 */

/** Roots where an unclassified `CardTitle` is never allowed. */
const MEMBER_FACING_ROOTS = [
  "src/app/(public)/",
  "src/app/(authenticated)/",
  "src/app/(website-dynamic)/",
];

/**
 * Shared member screens that live outside those roots (#4951 §2): the cards
 * a member or delegate reaches from an email link, held to the same rule.
 */
const MEMBER_FACING_SHARED_FILES = [
  "src/components/member-guest-delegate-consent-card.tsx",
  "src/components/membership-cancellation-confirm-card.tsx",
  "src/components/nomination-confirm-card.tsx",
  "src/components/partner-invite-claim-card.tsx",
  // Cards that only /dashboard and /bookings/[id] render, directly under the
  // page's h1, so each is level 2 like the cards declared in those pages.
  "src/components/additional-payment-card.tsx",
  "src/components/confirm-draft-button.tsx",
  "src/components/dashboard/lodge-kiosk-card.tsx",
  "src/components/group-booking/organiser-group-booking-card.tsx",
  "src/components/message-board-card.tsx",
  "src/components/recent-news-card.tsx",
  "src/components/refund-appeal-button.tsx",
  "src/components/self-remove-from-booking-card.tsx",
  "src/components/waitlist-offer-card.tsx",
];

/**
 * The number of production `CardTitle`s that still omit `headingLevel`. Only
 * ever lower it: a sweep that classifies titles sets it to the new count.
 */
const UNCLASSIFIED_BASELINE = 253;

function isMemberFacing(file: string) {
  return (
    MEMBER_FACING_ROOTS.some((root) => file.startsWith(root)) ||
    MEMBER_FACING_SHARED_FILES.includes(file)
  );
}

function unclassifiedCardTitles(): string[] {
  const sites: string[] = [];
  for (const file of SOURCE_FILES) {
    const source = read(file);
    for (const match of source.matchAll(CARD_TITLE_OPEN)) {
      if (headingClassification(match[1] ?? "") === "omitted") {
        sites.push(`${file}:${lineOf(source, match.index)}`);
      }
    }
  }
  return sites;
}

describe("every CardTitle declares a heading level or \"none\" (#4951)", () => {
  const unclassified = unclassifiedCardTitles();

  it("no member-facing CardTitle omits headingLevel", () => {
    const memberFacing = unclassified.filter((site) =>
      isMemberFacing(site.slice(0, site.lastIndexOf(":")))
    );
    expect(
      memberFacing,
      "Give each of these CardTitles a headingLevel from its page's real " +
        "outline: 1 when the card is the page's whole content and nothing else " +
        "renders an h1 in that state, 2 under an existing h1, and \"none\" when " +
        "it is not a heading at all (INV-PUB-005; docs/ARCHITECTURE.md, \"Card " +
        "titles and heading semantics\"):\n" +
        memberFacing.join("\n")
    ).toEqual([]);
  });

  it("holds the unclassified count at the ratcheted baseline", () => {
    expect(
      unclassified.length,
      unclassified.length > UNCLASSIFIED_BASELINE
        ? "A new CardTitle omits headingLevel. Classify it — a level, or " +
            "\"none\" — rather than raising the baseline."
        : `CardTitles were classified — lower UNCLASSIFIED_BASELINE to ` +
            `${unclassified.length} in this file so the ratchet holds.`
    ).toBe(UNCLASSIFIED_BASELINE);
  });

  it("scans a tree that actually contains what it claims to", () => {
    // A census that silently finds nothing passes for the wrong reason.
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
    for (const root of MEMBER_FACING_ROOTS) {
      expect(SOURCE_FILES.some((file) => file.startsWith(root))).toBe(true);
    }
    for (const file of MEMBER_FACING_SHARED_FILES) {
      expect(SOURCE_FILES).toContain(file);
    }
  });
});

describe("headingClassification reads every spelling a call site can use", () => {
  it.each([
    ["", "omitted"],
    [' className="text-sm"', "omitted"],
    [" headingLevel={1}", "heading"],
    [" headingLevel={ 2 } className=\"x\"", "heading"],
    [' headingLevel="none"', "none"],
    [' headingLevel={"none"}', "none"],
    [" headingLevel={level}", "heading"],
    [" headingLevel={undefined}", "omitted"],
    [" headingLevel={ null }", "omitted"],
    [' headingLevel="undefined"', "heading"],
  ] as const)("%j is %s", (attrs, expected) => {
    expect(headingClassification(attrs)).toBe(expected);
  });
});
