import type { DataMigrationVerification } from "./types";

/** #4914: exact-body guard and independent header preservation. */
const OLD_LINE = "<li><strong>Email logs:</strong> Retained for 90 days for troubleshooting, then automatically deleted.</li>";
const NEW_MARKER = "<li><strong>Email logs:</strong> {{email-log-retention}}.</li>";
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
    position('${NEW_MARKER}' IN "contentHtml") > 0 AS "newSchedule"
  FROM "PageContent" WHERE "slug" = 'privacy'
`;

const verification: DataMigrationVerification = {
  migration: "20261210120000_correct_starter_privacy_retention_and_hosting",
  intent:
    "Replace the untouched starter privacy page with configured email-log retention and host-neutral copy, and leave a privacy page a club edited untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a fresh install, carrying the starter privacy page the migration chain planted",
      seed: "",
      expectations: [
        {
          claim: "section 7 renders configured email-log retention instead of promising 90 days",
          sql: sectionState,
          rows: [{ oldLine: false, newSchedule: true }],
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
          rows: [{ oldLine: true, newSchedule: false }],
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
          rows: [{ oldLine: true, newSchedule: false }],
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
          claim: "the untouched section 7 is still corrected",
          sql: sectionState,
          rows: [{ oldLine: false, newSchedule: true }],
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
        "Rewrites every edited privacy page with the starter copy and leaves the untouched starter page still making the wrong 90-day promise.",
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
