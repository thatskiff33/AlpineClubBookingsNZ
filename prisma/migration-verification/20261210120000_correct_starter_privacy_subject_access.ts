import type { DataMigrationVerification } from "./types";

/**
 * #4915 — the starter privacy policy's section 8 (access to your information).
 *
 * #4031 last rewrote the starter `privacy` PageContent row. Its section 8 said
 * only "You can download your data from your Profile page", which overstated
 * what the download held. This migration replaces the whole row's
 * `contentHtml` with the corrected starter copy, but only where the row still
 * equals the exact #4031 text. A privacy page an admin edited keeps its own
 * text byte for byte. On a page it does update, the header's "Last updated"
 * date moves to the correction's date, but only where the header is still the
 * starter one.
 *
 * No seed for the first case: the pre-state is whatever the migration chain
 * itself produces.
 */
const OLD_LINE = "You can download your data from your <a href=\"/profile\">Profile page</a>.";
const NEW_MARKER = "The file lists exclusions. Contact our Privacy Officer for anything else";
const CLUB_NOTE = "<p>Our club also keeps paper sign-in sheets for one season.</p>";
const OLD_DATE = "Last updated 17 October 2026";
const NEW_DATE = "Last updated 12 November 2026";
const CLUB_HEADER = "Our privacy promise to members.";

const headerState = `
  SELECT
    position('${OLD_DATE}' IN "headerText") > 0 AS "oldDate",
    position('${NEW_DATE}' IN "headerText") > 0 AS "newDate"
  FROM "PageContent" WHERE "slug" = 'privacy'
`;

const sectionState = `
  SELECT
    position('${OLD_LINE}' IN "contentHtml") > 0 AS "oldLine",
    position('${NEW_MARKER}' IN "contentHtml") > 0 AS "newAccess"
  FROM "PageContent" WHERE "slug" = 'privacy'
`;

const verification: DataMigrationVerification = {
  migration: "20261210120000_correct_starter_privacy_subject_access",
  intent:
    "Replace the untouched starter privacy page with the copy saying what the Profile data download holds and who answers the rest, and leave a privacy page a club edited untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a fresh install, carrying the starter privacy page the migration chain planted",
      seed: "",
      expectations: [
        {
          claim: "section 8 no longer just points at the download; it says what the file holds and who answers the rest",
          sql: sectionState,
          rows: [{ oldLine: false, newAccess: true }],
        },
        {
          claim: "the starter header's Last updated date moves to the correction's date",
          sql: headerState,
          rows: [{ oldDate: false, newDate: true }],
        },
        {
          claim: "the privacy row itself survives — the update rewrites a field, it never deletes the page",
          sql: `SELECT count(*)::int AS "rows" FROM "PageContent" WHERE "slug" = 'privacy'`,
          rows: [{ rows: 1 }],
        },
      ],
    },
    {
      name: "a club that edited its privacy page by appending its own note",
      seed: `
        UPDATE "PageContent"
        SET "contentHtml" = "contentHtml" || '${CLUB_NOTE}'
        WHERE "slug" = 'privacy';
      `,
      expectations: [
        {
          claim: "the club's own page is untouched — equality on the whole previous text, so an edited page never matches",
          sql: sectionState,
          rows: [{ oldLine: true, newAccess: false }],
        },
        {
          claim: "the club's own addition is still there",
          sql: `SELECT position('${CLUB_NOTE}' IN "contentHtml") > 0 AS "kept" FROM "PageContent" WHERE "slug" = 'privacy'`,
          rows: [{ kept: true }],
        },
        {
          claim: "an edited page's header keeps its date — nothing on a skipped row moves",
          sql: headerState,
          rows: [{ oldDate: true, newDate: false }],
        },
      ],
    },
    {
      name: "a club that edited its privacy page by adding its own note at the top",
      seed: `
        UPDATE "PageContent"
        SET "contentHtml" = '${CLUB_NOTE}' || "contentHtml"
        WHERE "slug" = 'privacy';
      `,
      expectations: [
        {
          claim: "a page with text added before the starter copy is untouched — the guard is equality, not a suffix match",
          sql: sectionState,
          rows: [{ oldLine: true, newAccess: false }],
        },
      ],
    },
    {
      name: "a club that kept the starter privacy text but rewrote its header",
      seed: `
        UPDATE "PageContent"
        SET "headerText" = '${CLUB_HEADER}'
        WHERE "slug" = 'privacy';
      `,
      expectations: [
        {
          claim: "the untouched section 8 is still corrected",
          sql: sectionState,
          rows: [{ oldLine: false, newAccess: true }],
        },
        {
          claim: "the club's own header is kept byte for byte",
          sql: `SELECT "headerText" FROM "PageContent" WHERE "slug" = 'privacy'`,
          rows: [{ headerText: CLUB_HEADER }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "invert the WHERE (= becomes <>)",
      harm:
        "Rewrites every edited privacy page with the starter copy and leaves the untouched starter page still overstating the download.",
      find: `AND "contentHtml" = $previous$`,
      replace: `AND "contentHtml" <> $previous$`,
    },
    {
      name: "drop the value guard, keeping only the slug",
      harm:
        "Overwrites every club's privacy page, including pages an admin wrote for their own club — silent loss of a club's legal text.",
      find: `AND "contentHtml" = $previous$`,
      replace: `AND "contentHtml" LIKE '%' OR "contentHtml" = $previous$`,
    },
    {
      name: "match pages that merely end with the starter text",
      harm:
        "Overwrites a club page that added its own text above the starter copy, losing the club's addition.",
      find: `AND "contentHtml" = $previous$`,
      replace: `AND "contentHtml" LIKE '%' || $previous$`,
    },
    {
      name: "drop the header guard and always write the new header",
      harm:
        "Replaces a club's own privacy header with the starter one, silently discarding its wording.",
      find: `WHEN "headerText" = 'How we collect`,
      replace: `WHEN "headerText" IS NOT NULL OR "headerText" = 'How we collect`,
    },
  ],
};

export default verification;
