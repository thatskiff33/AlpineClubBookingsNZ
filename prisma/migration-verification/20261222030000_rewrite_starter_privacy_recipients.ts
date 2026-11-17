import { readFileSync } from "node:fs";
import path from "node:path";
import type { DataMigrationVerification } from "./types";

/**
 * #5007 (release 2 of #4918): the starter privacy policy's sections 5 and 6
 * are rewritten from the recipient register, naming the host through
 * `{{data-hosting}}`. The guard is equality on the whole previous body: the
 * #4915 body the chain leaves on an unedited page, or the #4914, #4031 or #1945
 * body a stale editor save or an old config bundle can restore. Any edited page
 * keeps every byte.
 *
 * The four bodies are READ OUT OF THIS MIGRATION'S `$previous$`, `$older$`,
 * `$oldest$` and `$earliest$` blocks rather than restated here, so the fixture
 * seeds exactly the bytes the guard names.
 */
const MIGRATION = "20261222030000_rewrite_starter_privacy_recipients";
const migrationSql = readFileSync(
  path.join(process.cwd(), "prisma", "migrations", MIGRATION, "migration.sql"),
  "utf8",
);

const previousBody = migrationSql.match(/\$previous\$([\s\S]*?)\$previous\$/)?.[1] ?? "";
const olderBody = migrationSql.match(/\$older\$([\s\S]*?)\$older\$/)?.[1] ?? "";
const oldestBody = migrationSql.match(/\$oldest\$([\s\S]*?)\$oldest\$/)?.[1] ?? "";
const earliestBody = migrationSql.match(/\$earliest\$([\s\S]*?)\$earliest\$/)?.[1] ?? "";
if (
  !previousBody.includes("The file lists exclusions") ||
  !olderBody.includes("Admin note:") ||
  olderBody.includes("The file lists exclusions") ||
  !oldestBody.includes("Retained for 90 days") ||
  // #1945's section 7 says audit logs are "then automatically pruned"; #4031's
  // replaced that with the per-kind schedule.
  !earliestBody.includes("then automatically pruned") ||
  oldestBody.includes("then automatically pruned")
) {
  // A silent "" would make the stale-restore cases and the suffix mutant test
  // nothing.
  throw new Error(`${MIGRATION}: could not read the #4915, #4914, #4031 and #1945 bodies from its guard.`);
}

// One marker per kind of body: the admin note both #4915 and #4914 carry, the
// 90-day email-log promise that #4031's and #1945's bodies both carry, and the
// new text's hosting token.
const PREVIOUS_MARKER = "hosting provider, region, backup store";
const OLDEST_MARKER = "Retained for 90 days";
const NEW_MARKER = "{{data-hosting}}";
const CLUB_NOTE = "<p>Our club also keeps paper sign-in sheets for one season.</p>";
const CLUB_HEADER = "Our privacy promise to members.";
const OLDEST_HEADER_DATE = "Last updated 17 October 2026";
const EARLIEST_HEADER_DATE = "Last updated 1 April 2026";
const OLDER_HEADER_DATE = "Last updated 12 November 2026";
const PREVIOUS_HEADER_DATE = "Last updated 14 November 2026";
const NEW_HEADER_DATE = "Last updated 18 November 2026";

const bodyState = `
  SELECT
    position('${PREVIOUS_MARKER}' IN "contentHtml") > 0 AS "previous",
    position('${OLDEST_MARKER}' IN "contentHtml") > 0 AS "oldest",
    position('${NEW_MARKER}' IN "contentHtml") > 0 AS "rewritten"
  FROM "PageContent" WHERE "slug" = 'privacy'
`;

const headerState = `
  SELECT
    position('${PREVIOUS_HEADER_DATE}' IN "headerText") > 0 AS "previousDate",
    position('${OLDER_HEADER_DATE}' IN "headerText") > 0 AS "olderDate",
    position('${OLDEST_HEADER_DATE}' IN "headerText") > 0 AS "oldestDate",
    position('${EARLIEST_HEADER_DATE}' IN "headerText") > 0 AS "earliestDate",
    position('${NEW_HEADER_DATE}' IN "headerText") > 0 AS "newDate"
  FROM "PageContent" WHERE "slug" = 'privacy'
`;

/** The header row `headerState` returns for each date the header can hold. */
const headerOn = (date: "previous" | "older" | "oldest" | "earliest" | "new") => ({
  previousDate: date === "previous",
  olderDate: date === "older",
  oldestDate: date === "oldest",
  earliestDate: date === "earliest",
  newDate: date === "new",
});

const verification: DataMigrationVerification = {
  migration: "20261222030000_rewrite_starter_privacy_recipients",
  intent:
    "Replace an unedited starter privacy page (the #4915, #4914, #4031 or #1945 body) with sections 5 and 6 built from the recipient register and the hosting setting, and leave every edited privacy page untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a fresh install, carrying the #4915 privacy page the migration chain planted",
      seed: "",
      expectations: [
        {
          claim: "the page now names the host through {{data-hosting}} and no longer carries the admin note",
          sql: bodyState,
          rows: [{ previous: false, oldest: false, rewritten: true }],
        },
        {
          claim: "the starter header's Last updated date moves to this release's date",
          sql: headerState,
          rows: [headerOn("new")],
        },
        {
          claim: "the privacy row itself survives; the update rewrites fields and never deletes the page",
          sql: `SELECT count(*)::int AS "rows" FROM "PageContent" WHERE "slug" = 'privacy'`,
          rows: [{ rows: 1 }],
        },
      ],
    },
    {
      name: "an install whose privacy page holds the #4914 body again, restored by a stale editor save or an old bundle",
      seed: `
        UPDATE "PageContent"
        SET "contentHtml" = ${dollarQuoted(olderBody)},
            "headerText" = replace("headerText", '${PREVIOUS_HEADER_DATE}', '${OLDER_HEADER_DATE}')
        WHERE "slug" = 'privacy';
      `,
      expectations: [
        {
          claim: "the unedited #4914 body is rewritten too, so the old section 8 does not survive a restore",
          sql: bodyState,
          rows: [{ previous: false, oldest: false, rewritten: true }],
        },
        {
          claim: "the #4914 starter header moves to this release's date",
          sql: headerState,
          rows: [headerOn("new")],
        },
      ],
    },
    {
      name: "an install whose privacy page holds the #4031 body again, restored by a stale editor save or an old bundle",
      seed: `
        UPDATE "PageContent"
        SET "contentHtml" = ${dollarQuoted(oldestBody)},
            "headerText" = replace("headerText", '${PREVIOUS_HEADER_DATE}', '${OLDEST_HEADER_DATE}')
        WHERE "slug" = 'privacy';
      `,
      expectations: [
        {
          claim: "the unedited #4031 body is rewritten too, so the old hosting claims do not survive a restore",
          sql: bodyState,
          rows: [{ previous: false, oldest: false, rewritten: true }],
        },
        {
          claim: "the #4031 starter header moves to this release's date",
          sql: headerState,
          rows: [headerOn("new")],
        },
      ],
    },
    {
      name: "an install whose privacy page holds the #1945 body again, restored by a stale editor save or an old bundle",
      seed: `
        UPDATE "PageContent"
        SET "contentHtml" = ${dollarQuoted(earliestBody)},
            "headerText" = replace("headerText", '${PREVIOUS_HEADER_DATE}', '${EARLIEST_HEADER_DATE}')
        WHERE "slug" = 'privacy';
      `,
      expectations: [
        {
          claim: "the unedited #1945 body is rewritten too, so its old hosting claims and audit-log line do not survive a restore",
          sql: bodyState,
          rows: [{ previous: false, oldest: false, rewritten: true }],
        },
        {
          claim: "the #1945 starter header moves to this release's date",
          sql: headerState,
          rows: [headerOn("new")],
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
          rows: [{ previous: true, oldest: false, rewritten: false }],
        },
        {
          claim: "the club's own addition is still there",
          sql: `SELECT position('${CLUB_NOTE}' IN "contentHtml") > 0 AS "kept" FROM "PageContent" WHERE "slug" = 'privacy'`,
          rows: [{ kept: true }],
        },
        {
          claim: "a skipped page's header keeps its date",
          sql: headerState,
          rows: [headerOn("previous")],
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
          rows: [{ previous: true, oldest: false, rewritten: false }],
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
          rows: [{ previous: true, oldest: false, rewritten: false }],
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
          rows: [{ previous: false, oldest: false, rewritten: true }],
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
      name: "drop the #4915 alternative from the guard",
      harm:
        "The page every unedited club holds after the chain is never rewritten: the release changes nothing for the clubs it exists for.",
      find: `AND "contentHtml" IN ($previous$`,
      replace: `AND "contentHtml" IN ($previous$<dropped>`,
    },
    {
      name: "drop the #4914 alternative from the guard",
      harm:
        "An install whose page was restored to the #4914 body keeps the old section 8 and the unlisted recipients.",
      find: `$previous$, $older$`,
      replace: `$previous$, $older$<dropped>`,
    },
    {
      name: "drop the #4031 alternative from the guard",
      harm:
        "An install whose page was restored to the #4031 body keeps telling members their data is in Sydney and that backups are encrypted.",
      find: `$older$, $oldest$`,
      replace: `$older$, $oldest$<dropped>`,
    },
    {
      name: "drop the #1945 alternative from the guard",
      harm:
        "An install whose page was restored to the #1945 body keeps telling members their data is in Sydney, that backups are encrypted and that audit logs are pruned after 90 days.",
      find: `$oldest$, $earliest$`,
      replace: `$oldest$, $earliest$<dropped>`,
    },
    {
      name: "forget the 14 November starter header",
      harm:
        "A page that is rewritten keeps the old Last updated date, so members see new text under an old date.",
      find: `${PREVIOUS_HEADER_DATE}</small>'`,
      replace: `${PREVIOUS_HEADER_DATE} </small>'`,
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
