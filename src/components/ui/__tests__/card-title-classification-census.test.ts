import { describe, expect, it } from "vitest";
import { FINANCE_HUB } from "@/lib/admin-hubs/hubs/finance";
import {
  CARD_TITLE_OPEN,
  headingClassification,
  lineOf,
  MEMBER_FACING_ROOTS,
  read,
  SOURCE_FILES,
} from "./support/card-title-source";

/**
 * #4951 (`INV-PUB-006`) — every `CardTitle` classifies itself, ratcheted to
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
 *    titles are swept area by area; each sweep lowers the baseline in the same
 *    change and adds what it swept to the lists below, so it cannot regress.
 *    When it reaches zero, `headingLevel` becomes required by the type and
 *    this census retires.
 *
 * Limits of a count. It is one number, so two sweeps that land together both
 * edit it, and a change that classifies one title while adding another
 * unclassified one in the same PR leaves it unchanged. Review a diff that
 * touches `CardTitle` for the second case; the first is a plain merge conflict
 * on one line.
 */

/**
 * Roots swept since #4951 that the shared `MEMBER_FACING_ROOTS` list does not
 * hold (#5216). Kept here rather than added to that list because the tab-title
 * guard (`member-route-titles.test.ts`) reads it too, and these pages are not
 * in its scope. The public website is two roots: `src/app/(website)/` holds
 * its pages, and `src/components/website/` holds the cards those pages draw,
 * the membership application form among them (#5372). Both are needed: the
 * pages root alone holds no card title.
 */
const SWEPT_ROOTS = [
  "src/app/(website)/",
  "src/components/website/",
  // #5216 PR 2, the Finance area: the admin Finance hub's pages, the finance
  // workspace (`/finance`) and the charts only it draws.
  "src/app/(admin)/admin/finance/",
  "src/app/(finance)/",
  "src/components/finance/",
];

/**
 * Where the Finance hub's pages lived before the admin hubs epic (#4468) moved
 * them under `admin/finance/`. None holds a file today; they are forbidden too,
 * so a branch cut before the move, or a move undone, cannot bring an
 * unclassified Finance title back by path.
 */
const LEGACY_SWEPT_ROOTS = [
  "src/app/(admin)/admin/payments/",
  "src/app/(admin)/admin/internet-banking/",
  "src/app/(admin)/admin/refund-requests/",
  "src/app/(admin)/admin/subscriptions/",
  "src/app/(admin)/admin/reports/",
  "src/app/(admin)/admin/xero/",
];

/** Every root where an unclassified `CardTitle` is never allowed. */
const FORBIDDEN_ROOTS = [...MEMBER_FACING_ROOTS, ...SWEPT_ROOTS];

/**
 * Shared member screens that live outside `MEMBER_FACING_ROOTS`, the roots
 * where an unclassified `CardTitle` is never allowed (#4951 §2): the cards
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
  // #5216: the member bucket #4951 left at the baseline. Every card below
  // renders directly under /bookings/[id]'s "Booking Details" h1 (the booking
  // editor's read view, the edit-booking panel that replaces it, the guest's
  // consent card and the officer's cards on the same page), so each is level
  // 2. /join/apply's card is under `src/components/website/`, a swept root.
  "src/components/admin/admin-booking-tools-card.tsx",
  "src/components/admin/booking-additional-payment-panel.tsx",
  "src/components/admin/confirm-pending-guests-button.tsx",
  "src/components/booking-editor.tsx",
  "src/components/edit-booking/account-credit-card.tsx",
  "src/components/edit-booking/admin-override-card.tsx",
  "src/components/edit-booking/change-request-card.tsx",
  "src/components/edit-booking/edit-dates-card.tsx",
  "src/components/edit-booking/edit-guests-card.tsx",
  "src/components/edit-booking/finished-stay-promo-correction-card.tsx",
  "src/components/edit-booking/price-summary-card.tsx",
  "src/components/edit-booking/promo-code-card.tsx",
  "src/components/member-guest-consent-card.tsx",
];

/**
 * Shared components the Finance sweep (#5216 PR 2) classified that live outside
 * its roots: the refund cards `/admin/finance/payments` draws, and the Xero
 * activity panel of `/admin/finance/xero/records/…` (also a tab on the member
 * page, where its compact title is not a heading).
 */
const FINANCE_SHARED_FILES = [
  "src/components/admin/automatic-refund-notices-card.tsx",
  "src/components/admin/manual-refund-task-queue.tsx",
  "src/components/admin/manual-refund-task-reopen-card.tsx",
  "src/components/admin/xero-record-activity-panel.tsx",
];

/** Every single file where an unclassified `CardTitle` is never allowed. */
const FORBIDDEN_FILES = [...MEMBER_FACING_SHARED_FILES, ...FINANCE_SHARED_FILES];

/**
 * The number of production `CardTitle`s that still omit `headingLevel`. Only
 * ever lower it: a sweep that classifies titles sets it to the new count.
 */
const UNCLASSIFIED_BASELINE = 198;

function isForbidden(file: string) {
  return (
    [...FORBIDDEN_ROOTS, ...LEGACY_SWEPT_ROOTS].some((root) => file.startsWith(root)) ||
    FORBIDDEN_FILES.includes(file)
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

  it("no member-facing or swept CardTitle omits headingLevel", () => {
    const forbidden = unclassified.filter((site) =>
      isForbidden(site.slice(0, site.lastIndexOf(":")))
    );
    expect(
      forbidden,
      "Give each of these CardTitles a headingLevel from its page's real " +
        "outline: 1 when the card is the page's whole content and nothing else " +
        "renders an h1 in that state, 2 under an existing h1, and \"none\" when " +
        "it is not a heading at all (INV-PUB-006; docs/ARCHITECTURE.md, \"Card " +
        "titles and heading semantics\"):\n" +
        forbidden.join("\n")
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
    for (const root of FORBIDDEN_ROOTS) {
      expect(SOURCE_FILES.some((file) => file.startsWith(root))).toBe(true);
    }
    for (const file of FORBIDDEN_FILES) {
      expect(SOURCE_FILES).toContain(file);
    }
  });

  it("forbids only legacy roots the Finance hub really moved", () => {
    // A legacy root holds no file, so it cannot prove itself by matching one;
    // it must instead be the old home of a page the hub registry says moved.
    const movedFrom = FINANCE_HUB.pages
      .filter((page) => page.moved)
      .map((page) => `src/app/(admin)${page.oldPath}/`);
    for (const root of LEGACY_SWEPT_ROOTS) {
      expect(movedFrom.some((path) => path.startsWith(root)), root).toBe(true);
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
