import { readFileSync } from "node:fs";
import path from "node:path";
import type { DataMigrationVerification } from "./types";

/**
 * #5007 (release 2 of #4918): the starter privacy policy's sections 5 and 6
 * are rewritten from the recipient register, naming the host through
 * `{{data-hosting}}`. The guard is equality on the whole previous body: the
 * #4914 body the chain planted, or the #4031 body a stale editor save or an old
 * config bundle can restore. Any edited page keeps every byte.
 *
 * The #4031 body is READ OUT OF THIS MIGRATION'S `$older$` block rather than
 * restated here, so the fixture seeds exactly the bytes the guard names.
 */
const MIGRATION = "20261222030000_rewrite_starter_privacy_recipients";
const migrationSql = readFileSync(
  path.join(process.cwd(), "prisma", "migrations", MIGRATION, "migration.sql"),
  "utf8",
);

const previousBody = migrationSql.match(/\$previous\$([\s\S]*?)\$previous\$/)?.[1] ?? "";
const olderBody = migrationSql.match(/\$older\$([\s\S]*?)\$older\$/)?.[1] ?? "";
if (!previousBody.includes("Admin note:") || !olderBody.includes("Retained for 90 days")) {
  // A silent "" would make the stale-restore case and the suffix mutant test
  // nothing.
  throw new Error(`${MIGRATION}: could not read the #4914 and #4031 bodies from its guard.`);
}

// One marker per body: #4914's admin note, #4031's email-log promise, and the
// new text's hosting token.
const PREVIOUS_MARKER = "hosting provider, region, backup store";
const OLDER_MARKER = "Retained for 90 days";
const NEW_MARKER = "{{data-hosting}}";
const CLUB_NOTE = "<p>Our club also keeps paper sign-in sheets for one season.</p>";
const CLUB_HEADER = "Our privacy promise to members.";
const OLDER_HEADER_DATE = "Last updated 17 October 2026";
const PREVIOUS_HEADER_DATE = "Last updated 12 November 2026";
const NEW_HEADER_DATE = "Last updated 15 November 2026";

const bodyState = `
  SELECT
    position('${PREVIOUS_MARKER}' IN "contentHtml") > 0 AS "previous",
    position('${OLDER_MARKER}' IN "contentHtml") > 0 AS "older",
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
  migration: "20261222030000_rewrite_starter_privacy_recipients",
  intent:
    "Replace an unedited starter privacy page (the #4914 or #4031 body) with sections 5 and 6 built from the recipient register and the hosting setting, and leave every edited privacy page untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a fresh install, carrying the #4914 privacy page the migration chain planted",
      seed: "",
      expectations: [
        {
          claim: "the page now names the host through {{data-hosting}} and no longer carries #4914's admin note",
          sql: bodyState,
          rows: [{ previous: false, older: false, rewritten: true }],
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
      name: "an install whose privacy page holds the #4031 body again, restored by a stale editor save or an old bundle",
      seed: `
        UPDATE "PageContent"
        SET "contentHtml" = ${dollarQuoted(olderBody)},
            "headerText" = replace("headerText", '${PREVIOUS_HEADER_DATE}', '${OLDER_HEADER_DATE}')
        WHERE "slug" = 'privacy';
      `,
      expectations: [
        {
          claim: "the unedited #4031 body is rewritten too, so the old hosting claims do not survive a restore",
          sql: bodyState,
          rows: [{ previous: false, older: false, rewritten: true }],
        },
        {
          claim: "the #4031 starter header moves to this release's date",
          sql: headerState,
          rows: [{ previousDate: false, newDate: true }],
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
          rows: [{ previous: true, older: false, rewritten: false }],
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
          rows: [{ previous: true, older: false, rewritten: false }],
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
          rows: [{ previous: true, older: false, rewritten: false }],
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
          rows: [{ previous: false, older: false, rewritten: true }],
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
      name: "invert the WHERE (IN becomes NOT IN)",
      harm:
        "Rewrites every edited privacy page with the starter copy and leaves the unedited starter page still without the register's recipients.",
      find: `AND "contentHtml" IN ($previous$`,
      replace: `AND "contentHtml" NOT IN ($previous$`,
    },
    {
      name: "drop the value guard, keeping only the slug",
      harm:
        "Overwrites every club's privacy page, including pages an admin wrote for their own club: silent loss of a club's legal text.",
      find: `AND "contentHtml" IN ($previous$`,
      replace: `AND "contentHtml" LIKE '%' OR "contentHtml" IN ($previous$`,
    },
    {
      name: "match pages that merely end with the starter text",
      harm:
        "Overwrites a club page that added its own text above the starter copy, losing the club's addition.",
      // Compares only the trailing characters, so the guard stays valid SQL
      // and the mutant is caught by what it writes, not by a parse error.
      find: `AND "contentHtml" IN (`,
      replace: `AND right("contentHtml", ${previousBody.length}) IN (`,
    },
    {
      name: "drop the header guard and always write the new header",
      harm:
        "Replaces a club's own privacy header with the starter one, silently discarding its wording.",
      find: `WHEN "headerText" IN (`,
      replace: `WHEN "headerText" IS NOT NULL OR "headerText" IN (`,
    },
    {
      name: "drop the #4031 alternative from the guard",
      harm:
        "An install whose page was restored to the #4031 body keeps telling members their data is in Sydney and that backups are encrypted.",
      find: `$previous$, $older$`,
      replace: `$previous$, $older$<dropped>`,
    },
  ],
};

/**
 * Wrap a value in a `$fixture$` dollar-quoted literal. The body carries single
 * quotes and HTML entities, so hand escaping would be one edit from seeding
 * different bytes than the guard names.
 */
function dollarQuoted(value: string): string {
  if (value.includes("$fixture$")) {
    throw new Error("fixture value contains the dollar-quote tag $fixture$");
  }
  return `$fixture$${value}$fixture$`;
}

export default verification;
