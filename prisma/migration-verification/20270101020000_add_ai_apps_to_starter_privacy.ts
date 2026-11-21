import { readFileSync } from "node:fs";
import path from "node:path";
import type { DataMigrationVerification } from "./types";

/**
 * #5305 (AI app connections, ALP-653): the starter privacy policy's section 5
 * gains the AI apps entry for the register's `ai-apps` row. The guard is
 * equality on the whole previous body, the one #5007's
 * 20261222030000_rewrite_starter_privacy_recipients wrote, which is what the
 * chain leaves on an unedited page. Any edited page keeps every byte.
 *
 * The body is READ OUT OF THIS MIGRATION'S `$previous$` block rather than
 * restated here, so the fixture seeds exactly the bytes the guard names.
 */
const MIGRATION = "20270101020000_add_ai_apps_to_starter_privacy";
const migrationSql = readFileSync(
  path.join(process.cwd(), "prisma", "migrations", MIGRATION, "migration.sql"),
  "utf8",
);

const previousBody = migrationSql.match(/\$previous\$([\s\S]*?)\$previous\$/)?.[1] ?? "";
const NEW_MARKER = "AI apps you connect";
// Both bodies name the host through the token; only the new one has the entry.
const SHARED_MARKER = "{{data-hosting}}";
if (!previousBody.includes(SHARED_MARKER) || previousBody.includes(NEW_MARKER)) {
  // A silent "" would make the suffix mutant test nothing.
  throw new Error(`${MIGRATION}: could not read the #5007 body from its guard.`);
}

const CLUB_NOTE = "<p>Our club also keeps paper sign-in sheets for one season.</p>";
const CLUB_HEADER = "Our privacy promise to members.";
const PREVIOUS_HEADER_DATE = "Last updated 18 November 2026";
const NEW_HEADER_DATE = "Last updated 21 November 2026";

const bodyState = `
  SELECT
    position('${SHARED_MARKER}' IN "contentHtml") > 0 AS "starter",
    position('${NEW_MARKER}' IN "contentHtml") > 0 AS "rewritten"
  FROM "PageContent" WHERE "slug" = 'privacy'
`;

const headerState = `
  SELECT
    position('${PREVIOUS_HEADER_DATE}' IN "headerText") > 0 AS "previousDate",
    position('${NEW_HEADER_DATE}' IN "headerText") > 0 AS "newDate"
  FROM "PageContent" WHERE "slug" = 'privacy'
`;

const verification: DataMigrationVerification = {
  migration: "20270101020000_add_ai_apps_to_starter_privacy",
  intent:
    "Add the AI apps entry to an unedited starter privacy page (the #5007 body) and move its starter header's date, leaving every edited privacy page and header untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a fresh install, carrying the #5007 privacy page the migration chain planted",
      seed: "",
      expectations: [
        {
          claim: "the page now lists the AI apps entry",
          sql: bodyState,
          rows: [{ starter: true, rewritten: true }],
        },
        {
          claim: "the starter header's Last updated date moves to this release's date",
          sql: headerState,
          rows: [{ previousDate: false, newDate: true }],
        },
        {
          claim: "the privacy row itself survives; the update rewrites fields and never deletes the page",
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
          claim: "the edited page is untouched; equality on the whole previous body never matches an edited page",
          sql: bodyState,
          rows: [{ starter: true, rewritten: false }],
        },
        {
          claim: "the club's own addition is still there",
          sql: `SELECT position('${CLUB_NOTE}' IN "contentHtml") > 0 AS "kept" FROM "PageContent" WHERE "slug" = 'privacy'`,
          rows: [{ kept: true }],
        },
        {
          claim: "a skipped page's header keeps its date",
          sql: headerState,
          rows: [{ previousDate: true, newDate: false }],
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
          claim: "text added before the starter copy keeps the page untouched; the guard is equality, not a suffix match",
          sql: bodyState,
          rows: [{ starter: true, rewritten: false }],
        },
      ],
    },
    {
      name: "a page whose line endings were converted to CRLF by an editor round trip",
      seed: `
        UPDATE "PageContent"
        SET "contentHtml" = replace("contentHtml", E'\\n', E'\\r\\n')
        WHERE "slug" = 'privacy';
      `,
      expectations: [
        {
          claim: "a byte-different body is treated as edited and left alone",
          sql: bodyState,
          rows: [{ starter: true, rewritten: false }],
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
          claim: "the unedited body is still rewritten",
          sql: bodyState,
          rows: [{ starter: true, rewritten: true }],
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
        "Rewrites every edited privacy page with the starter copy and leaves the unedited starter page without the AI apps entry.",
      find: `AND "contentHtml" = $previous$`,
      replace: `AND "contentHtml" <> $previous$`,
    },
    {
      name: "drop the value guard, keeping only the slug",
      harm:
        "Overwrites every club's privacy page, including pages an admin wrote for their own club: silent loss of a club's legal text.",
      find: `AND "contentHtml" = $previous$`,
      replace: `AND "contentHtml" LIKE '%' OR "contentHtml" = $previous$`,
    },
    {
      name: "match pages that merely end with the starter text",
      harm:
        "Overwrites a club page that added its own text above the starter copy, losing the club's addition.",
      // Compares only the trailing characters, so the guard stays valid SQL
      // and the mutant is caught by what it writes, not by a parse error.
      find: `AND "contentHtml" = $previous$`,
      replace: `AND right("contentHtml", ${previousBody.length}) = $previous$`,
    },
    {
      name: "drop the header guard and always write the new header",
      harm:
        "Replaces a club's own privacy header with the starter one, silently discarding its wording.",
      find: `CASE WHEN "headerText" = `,
      replace: `CASE WHEN "headerText" IS NOT NULL OR "headerText" = `,
    },
    {
      name: "forget the 18 November starter header",
      harm:
        "A page that is rewritten keeps the old Last updated date, so members see new text under an old date.",
      find: `${PREVIOUS_HEADER_DATE}</small>'`,
      replace: `${PREVIOUS_HEADER_DATE} </small>'`,
    },
  ],
};

export default verification;
