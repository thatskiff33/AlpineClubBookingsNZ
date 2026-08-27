/**
 * Which surfaces name a season by the shared derivation, and which deliberately
 * still do not (#3103).
 *
 * `src/lib/season-label.ts` (#3102) is the one place that turns a season year
 * into a name. Nineteen non-test sites once wrote that name by hand as
 * `${seasonYear}/${seasonYear + 1}`, which asserts a season spans two calendar
 * years - false under a December year-end, where the season starts in January
 * and the season year IS the calendar year.
 *
 * The owner's decision on #3103 moved FIVE of those sites (four files, because
 * the member profile page inlined it twice) onto the shared derivation and held
 * back four more. **#3116 finished the job: all of them are adopted now**, and
 * the exclusion list this file used to carry is empty.
 *
 * ## What the four held-back sites were, and why holding them back ended
 *
 * They rendered the label into money and provider text: two Xero invoice-line
 * descriptions, a credit-note description, and a `server-only` activity label.
 * The stated reason for holding them was a frozen-string contract on
 * `buildComponentLineDescription` - a single-component fee reproduces that text,
 * so a backfilled legacy charge re-driven through the outbox was said to mint a
 * BYTE-IDENTICAL invoice line, which unifying would break.
 *
 * **That reasoning was wrong about its own mechanism, and #3116 measured it.**
 * `MembershipSubscriptionChargeComponent.description` is a persisted column: the
 * planner WRITES it and the mint READS IT BACK. Byte-identity for an existing
 * charge comes from persistence, not from the deriving code, so changing the
 * derivation changes newly-planned charges only. Nor does any matcher read the
 * text - reconciliation finds the invoice by its immutable `Reference`, and the
 * snapshot comparison is handed amount, account code and item code with the
 * description destructured away.
 *
 * The four were also the sites where the template was ALREADY wrong, because
 * they run on the server where the year-end genuinely is available: a
 * December-year-end club got a two-calendar-year name for a season that sits
 * inside one. Holding them back preserved a wrong label to protect a property
 * that something else was providing.
 *
 * ## What replaced the pin
 *
 * The hazard #3116 actually found is not de-duplication, it is the DEFAULT.
 * `seasonYearsLabel` defaults its year-end to the `financial-year.ts` process
 * cache, which no background worker seeds - so adopting the shared derivation
 * while taking that default would have reworded every existing club's invoices
 * AND still rendered the wrong season for the club the change was for. Every one
 * of these four now takes the year-end explicitly, and
 * `buildComponentLineDescription` REQUIRES it, so an unstated year-end is a
 * compile error rather than a silently wrong invoice line.
 *
 * ## The regex is self-checked, because a source scan that matches nothing is
 * indistinguishable from a source scan that passes
 *
 * The first case below runs the pattern over literal samples in both spellings
 * it has to catch - a template literal and a JSX pair - and over the two
 * arithmetic shapes it must NOT catch, one of which (`defaultSeasonYear + 1`) is
 * live in a file this test also asserts is clean. Without that case, a pattern
 * broken by a later edit would report every file as adopted.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "./support/strip-comments";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * A season NAMED as two calendar years, in both spellings this tree uses: the
 * template literal `${x.seasonYear}/${x.seasonYear + 1}` and the JSX pair
 * `{x.seasonYear}/{x.seasonYear + 1}`.
 *
 * It deliberately requires the `}` `/` `{` bridge, which is what separates a
 * LABEL from date or season ARITHMETIC. `Date.UTC(seasonYear + 1, ...)` computes
 * a season's end bound and `defaultSeasonYear + 1` seeds a picker with the next
 * season - rewriting either changes a date or a season, not a string, and five
 * of the twenty-four lines matching the naive `seasonYear + 1` are exactly that.
 */
const TWO_CALENDAR_YEAR_NAME =
  /[Ss]easonYear\}\s*\/\s*\$?\{[^}]*[Ss]easonYear \+ 1/;

/**
 * The files the #3103 decision moved onto the shared derivation.
 *
 * The last three are the admin member detail screen's other three season
 * renderings. They were NOT in the decision's own list of four, and were added
 * once adopting the card alone was measured to leave that ONE screen naming a
 * single season three ways: `2026 - 2027 (Apr-Mar)` in the card, beside
 * `2026/2027 season` in the summary strip and `2026/2027` in the history table.
 * That was a defect this change introduced rather than a pre-existing one, which
 * is why it is fixed here instead of filed. The screen-wide scan below is the
 * assertion that stops it being re-split.
 */
const ADOPTED = [
  "src/app/(authenticated)/profile/page.tsx",
  "src/app/(admin)/admin/members/[id]/_components/member-seasonal-membership-card.tsx",
  "src/app/(admin)/admin/membership-types/page.tsx",
  "src/app/api/member/data-export/route.ts",
  "src/app/(admin)/admin/members/[id]/_components/member-summary-strip.tsx",
  "src/app/(admin)/admin/members/[id]/_components/member-subscription-history-table.tsx",
  "src/lib/admin-member-detail-helpers.ts",
  // The four money and provider sites, adopted by #3116. See this file's
  // docblock for why they were held back and what changed.
  "src/lib/membership-subscription-billing.ts",
  "src/lib/xero-subscription-invoices.ts",
  "src/lib/membership-cancellation-xero.ts",
  "src/lib/xero-record-activity.ts",
];

/**
 * Everything that renders on `admin/members/[id]`, scanned as a TREE rather than
 * as a list, so a component added to that screen later is covered without anyone
 * remembering to come here. `admin-member-detail-helpers.ts` lives in `src/lib`
 * but builds this screen's section-nav previews, so it is named explicitly.
 */
const MEMBER_DETAIL_SCREEN_DIR = "src/app/(admin)/admin/members/[id]";
const MEMBER_DETAIL_SCREEN_EXTRA = ["src/lib/admin-member-detail-helpers.ts"];

/** Every non-test `.ts`/`.tsx` under a directory, recursively. */
function sourceFilesUnder(relativeDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(REPO_ROOT, dir), {
      withFileTypes: true,
    })) {
      if (entry.name === "__tests__") continue;
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry.name)) found.push(child);
    }
  };
  walk(relativeDir);
  return found;
}

function read(relative: string): string {
  // Fail closed on a rename: an unreadable path must throw here rather than
  // let a moved file read as "no template found, therefore adopted".
  //
  // COMMENTS ARE STRIPPED BEFORE MATCHING, and that is not cosmetic. This
  // repository documents each defect at the site where it was removed, so the
  // files that were cleaned MOST are the ones whose comments most often quote
  // the very text the scan is looking for - `membership-subscription-billing.ts`
  // now explains what its invoice line used to say and why it changed. Matching
  // raw source would read that explanation as an unadopted site and fail a file
  // precisely because it was documented well. One shared `stripComments`, never
  // a local reimplementation, so this scanner and every other one measure the
  // same way.
  return stripComments(readFileSync(path.join(REPO_ROOT, relative), "utf8"));
}

describe("the two-calendar-year season name (#3103)", () => {
  it("matches both spellings of the NAME and neither shape of the arithmetic", () => {
    // Positive: the two spellings that appeared in this tree.
    expect("`${seasonYear}/${seasonYear + 1}`").toMatch(TWO_CALENDAR_YEAR_NAME);
    expect("{sub.seasonYear}/{sub.seasonYear + 1}").toMatch(
      TWO_CALENDAR_YEAR_NAME,
    );
    expect("`${member.currentSeasonYear}/${member.currentSeasonYear + 1}`").toMatch(
      TWO_CALENDAR_YEAR_NAME,
    );
    // Negative: arithmetic. The second is live in `membership-types/page.tsx`,
    // which this file also asserts carries no NAME - so if the pattern grew to
    // match arithmetic, that assertion would fail rather than pass silently.
    expect("Date.UTC(seasonYear + 1, startMonth - 1, 1)").not.toMatch(
      TWO_CALENDAR_YEAR_NAME,
    );
    expect("useState(defaultSeasonYear + 1)").not.toMatch(
      TWO_CALENDAR_YEAR_NAME,
    );
  });
});

describe("the surfaces that adopted the shared derivation (#3103)", () => {
  it.each(ADOPTED)("%s names a season by the club's year-end", (relative) => {
    const source = read(relative);
    expect(source).not.toMatch(TWO_CALENDAR_YEAR_NAME);
    expect(source).toContain('from "@/lib/season-label"');
  });

  it("keeps the roll-forward picker's next-season arithmetic", () => {
    // The one `seasonYear + 1` left in an adopted file. It seeds the "to season"
    // picker with the NEXT SEASON, so sweeping it would change which season the
    // page rolls assignments into rather than how a season is spelled.
    expect(read("src/app/(admin)/admin/membership-types/page.tsx")).toContain(
      "defaultSeasonYear + 1",
    );
  });
});

describe("comment text cannot make an adopted file read as unadopted (#3116)", () => {
  it("strips a comment quoting the historical name before matching", () => {
    const documented = [
      "// It used to read `${seasonYear}/${seasonYear + 1}`, which assumed two years.",
      "const label = seasonYearsLabel(seasonYear, yearEndMonth);",
    ].join(String.fromCharCode(10));
    expect(documented).toMatch(TWO_CALENDAR_YEAR_NAME);
    expect(stripComments(documented)).not.toMatch(TWO_CALENDAR_YEAR_NAME);
  });
});

describe("the admin member detail screen names a season exactly one way (#3103)", () => {
  const screenFiles = [
    ...sourceFilesUnder(MEMBER_DETAIL_SCREEN_DIR),
    ...MEMBER_DETAIL_SCREEN_EXTRA,
  ];

  it("reaches the whole screen, so a rename cannot make this vacuous", () => {
    // The four files known to render a season on this screen today. If any is
    // renamed or moved out of the tree, this fails rather than quietly scanning
    // a smaller screen - which is the failure mode a hard-coded list has.
    for (const expected of [
      `${MEMBER_DETAIL_SCREEN_DIR}/page.tsx`,
      `${MEMBER_DETAIL_SCREEN_DIR}/_components/member-seasonal-membership-card.tsx`,
      `${MEMBER_DETAIL_SCREEN_DIR}/_components/member-summary-strip.tsx`,
      `${MEMBER_DETAIL_SCREEN_DIR}/_components/member-subscription-history-table.tsx`,
      "src/lib/admin-member-detail-helpers.ts",
    ]) {
      expect(screenFiles, `${expected} is no longer scanned`).toContain(expected);
    }
    expect(screenFiles.length).toBeGreaterThan(5);
  });

  it("has no file on it still writing the two-calendar-year name", () => {
    // The whole point: one screen, one naming. An admin reading the card, the
    // summary tile beside it and the history table below it must not see the
    // same season written three ways.
    const offenders = screenFiles.filter((relative) =>
      TWO_CALENDAR_YEAR_NAME.test(read(relative)),
    );

    expect(
      offenders,
      `These render on admin/members/[id] and still name a season as two ` +
        `calendar years, so that screen now disagrees with itself. Adopt ` +
        `seasonSelectLabel from @/lib/season-label. Offending file(s): ` +
        `${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
