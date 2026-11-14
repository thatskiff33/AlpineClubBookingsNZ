import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tokensForContext } from "../token-catalogue";
import { PRIVACY_RECIPIENTS } from "../privacy-recipient-classification";
import {
  STARTER_PRIVACY_RECIPIENT_ITEMS,
  starterPageContent,
} from "../../../prisma/starter-page-content";

// Production deploys run Prisma migrations but not the seed, so the starter
// PageContent rows are backfilled by a data migration. These tests keep that
// SQL in sync with starterPageContent: if a starter page is added or edited
// without a matching backfill migration, deploy-only environments would 404
// the affected public route or keep stale default copy.
const INSERT_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260611101500_backfill_starter_page_content",
  "migration.sql",
);

const BACKFILL_404_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260614110000_backfill_404_page_content",
  "migration.sql",
);

const POLICY_PAGES_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260702090000_backfill_policy_page_content",
  "migration.sql",
);

// The built-in "/booking-requests" row, backfilled when that page moved from a
// static (public) route to a database-backed, token-driven CMS page.
const BOOKING_REQUESTS_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260811020000_backfill_booking_requests_page_content",
  "migration.sql",
);

// The built-in "/school-bookings" row, backfilled for the same static -> dynamic
// move.
const SCHOOL_BOOKINGS_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260812010000_backfill_school_bookings_page_content",
  "migration.sql",
);

const HOME_UPDATE_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260613090000_update_starter_home_page_content",
  "migration.sql",
);

// Issue #2431 (epic #2422, PR #2428 review finding B8): supersedes the #716
// migration above as the authoritative writer of the home hero text — the old
// copy said the lodge "welcomes members and guests year-round", which reads as
// an open invitation for anyone to book and contradicted the starter FAQ seeded
// beside it. It changes headerText only; caption and title are still whatever
// #716 wrote.
const HOME_GUEST_COPY_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260802150000_update_starter_home_guest_copy",
  "migration.sql",
);

const FAQ_UPDATE_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260702120000_update_starter_faq_accordion",
  "migration.sql",
);

const PRIVACY_UPDATE_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260702144000_update_privacy_for_analytics_consent",
  "migration.sql",
);

const NON_MEMBER_HOLD_COPY_UPDATE_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260705130000_add_non_member_hold_enabled",
  "migration.sql",
);

// Issue #1945 (E15): guarded update that genericises the club-specific lodge
// name/geography in the privacy, terms, and FAQ starter copy. It supersedes the
// privacy (#975) and terms/FAQ (#1287) update migrations as the authoritative
// writer of the current seed text for those three pages.
const GENERICISE_LODGE_COPY_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260717180000_genericise_starter_lodge_copy",
  "migration.sql",
);

// Issue #4031: guarded update that corrects section 7's audit-log retention
// schedule. It superseded #1945 as the writer of the privacy seed text, until
// #4914's 20261214010000 migration took over; #1945 still writes the current
// Terms.
const PRIVACY_AUDIT_RETENTION_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20261119010000_correct_starter_privacy_audit_retention",
  "migration.sql",
);

// #4914: guarded update that corrected email-log retention and made hosting
// host-neutral. It superseded #4031 as the privacy writer, until #5007's
// 20261222030000 migration took over.
const PRIVACY_RETENTION_HOSTING_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20261214010000_correct_starter_privacy_retention_and_hosting",
  "migration.sql",
);

// #5007 (release 2 of #4918): guarded update that lists every member-facing
// register recipient in section 5 and names the host through {{data-hosting}}.
// It is the current writer of the privacy seed text.
const PRIVACY_RECIPIENTS_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20261222030000_rewrite_starter_privacy_recipients",
  "migration.sql",
);

// Follow-up to #4914: guarded update that makes the FAQ's personal-data answer
// a summary of every category held, pointing to section 2 of the Privacy
// Policy. It supersedes #1945 as the authoritative writer of the current FAQ
// seed text.
const FAQ_PERSONAL_DATA_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20261218070000_summarise_starter_faq_personal_data",
  "migration.sql",
);

// Previous starter FAQ contentHtml (flat <h3>/<p> pairs), replaced by the
// accordion update migration. Extracted verbatim from the policy-pages
// backfill so the update migration's WHERE guard provably matches what that
// backfill wrote; rows edited by an admin since then are left untouched.
function previousFaqContentHtml(policyPagesSql: string) {
  const faqBlock = policyPagesSql
    .split("'starter-page-faq'")[1]
    ?.match(/\$cms\$([\s\S]*?)\$cms\$/)?.[1];
  if (!faqBlock) {
    throw new Error("FAQ contentHtml not found in policy pages backfill SQL");
  }
  return faqBlock;
}

function previousPrivacyContentHtml(policyPagesSql: string) {
  const privacyBlock = policyPagesSql
    .split("'starter-page-privacy'")[1]
    ?.match(/\$cms\$([\s\S]*?)\$cms\$/)?.[1];
  if (!privacyBlock) {
    throw new Error("Privacy contentHtml not found in policy pages backfill SQL");
  }
  return privacyBlock;
}

function previousTermsContentHtml(policyPagesSql: string) {
  const termsBlock = policyPagesSql
    .split("'starter-page-terms'")[1]
    ?.match(/\$cms\$([\s\S]*?)\$cms\$/)?.[1];
  if (!termsBlock) {
    throw new Error("Terms contentHtml not found in policy pages backfill SQL");
  }
  return termsBlock;
}

function faqAccordionContentHtml(faqUpdateSql: string) {
  const faqBlock = faqUpdateSql.match(/\$faq_new\$([\s\S]*?)\$faq_new\$/)?.[1];
  if (!faqBlock) {
    throw new Error("FAQ accordion contentHtml not found in FAQ update SQL");
  }
  return faqBlock;
}

// Returns the nth $cms$-delimited blob in a migration — the value written by a
// SET clause. Used to prove each starter-copy update chains to the next: one
// migration's SET must equal the value the next migration guards its WHERE on.
function nthCmsBlock(sql: string, n: number) {
  const re = /\$cms\$([\s\S]*?)\$cms\$/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = re.exec(sql)) !== null) {
    index += 1;
    if (index === n) return match[1];
  }
  throw new Error(`cms block #${n} not found`);
}

/**
 * SQL with every "--" comment line removed, so assertions read statements
 * rather than prose. Migrations in this repository carry long explanatory
 * headers that quote the very literals under test, so a bare `toContain` on the
 * raw file would pass on a comment alone (#2490's cleanup test does the same).
 */
function statementsOnly(sql: string) {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

// Reads the headerText a "home" migration's SET clause writes, un-escaping the
// doubled SQL quotes back to the literal string. Used so the #2431 guest-copy
// migration's WHERE guard is proved byte-identical to what #716 actually
// planted, rather than to a copy of it restated in this file that could drift.
function homeHeaderTextWrittenBy(sql: string) {
  const setClause = statementsOnly(sql).split(/\bWHERE\b/)[0];
  const quoted = setClause.match(/"headerText"\s*=\s*'((?:[^']|'')*)'/)?.[1];
  if (quoted === undefined) {
    throw new Error("headerText SET value not found in home migration SQL");
  }
  return quoted.replace(/''/g, "'");
}

// Previous default "home" copy, replaced by the update migration above. The
// update migration's WHERE clause must guard on these values so deployments
// where an admin has already edited the home page are left untouched.
const PREVIOUS_HOME_CONTENT = {
  caption: "Whakapapa, Mt Ruapehu",
  title: "Mt Ruapehu Lodge",
  headerText:
    "Our club lodge sits in the Whakapapa ski area on Mt Ruapehu. Book a stay, join the club, and explore New Zealand's mountains.",
};

// The hero text #716 planted and #2431 replaces, read out of #716's own SET
// clause rather than restated here. #2431 must guard its WHERE on exactly this,
// so a deployment whose admin has edited the hero is left untouched.
const SUPERSEDED_HOME_HEADER_TEXT = homeHeaderTextWrittenBy(
  readFileSync(HOME_UPDATE_MIGRATION_PATH, "utf8"),
);

/** The starter privacy header with its "Last updated" date set to `date`. */
function privacyHeaderOn(date: string) {
  const header = starterPageContent.find((p) => p.slug === "privacy")!.headerText;
  return header.replace(/Last updated [^<]+/, `Last updated ${date}`);
}

function sqlQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The single-row `INSERT INTO "PageContent" (...) VALUES (...)` in a backfill
 * migration, as a column -> raw SQL literal map.
 *
 * Needed because the value-lockstep test above filters EMPTY strings out before
 * comparing, so a seed field of `""` is asserted by nothing at all. For most
 * fields that is harmless; for `menuTitle` on the two form pages it is the whole
 * opt-in decision (#2818 decision 1), and "the migration writes an empty menu
 * title" has to be pinned positionally rather than by substring — `''` appears
 * in almost any SQL file, so a `toContain("''")` would pass on anything.
 */
function insertedRow(sql: string): Record<string, string> {
  const statements = statementsOnly(sql);
  const columnBlock = statements.match(
    /INSERT INTO "PageContent"\s*\(([^)]*)\)/,
  )?.[1];
  const valuesBlock = statements.match(
    /VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/,
  )?.[1];

  if (!columnBlock || !valuesBlock) {
    throw new Error("single-row PageContent INSERT not found in migration SQL");
  }

  const columns = columnBlock
    .split(",")
    .map((column) => column.trim().replace(/"/g, ""));
  const values = valuesBlock.split(/,\s*\n/).map((value) => value.trim());

  if (columns.length !== values.length) {
    throw new Error(
      `column/value count mismatch: ${columns.length} columns, ${values.length} values`,
    );
  }

  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

function expectSqlContainsValue(sql: string, value: string) {
  expect(
    sql.includes(sqlQuote(value)) || sql.includes(value),
    `expected backfill SQL to contain ${value}`,
  ).toBe(true);
}

describe("starter page content backfill migration", () => {
  const insertSql = readFileSync(INSERT_MIGRATION_PATH, "utf8");
  const backfill404Sql = readFileSync(BACKFILL_404_MIGRATION_PATH, "utf8");
  const policyPagesSql = readFileSync(POLICY_PAGES_MIGRATION_PATH, "utf8");
  const bookingRequestsSql = readFileSync(BOOKING_REQUESTS_MIGRATION_PATH, "utf8");
  const schoolBookingsSql = readFileSync(SCHOOL_BOOKINGS_MIGRATION_PATH, "utf8");
  const updateSql = readFileSync(HOME_UPDATE_MIGRATION_PATH, "utf8");
  const faqUpdateSql = readFileSync(FAQ_UPDATE_MIGRATION_PATH, "utf8");
  const privacyUpdateSql = readFileSync(PRIVACY_UPDATE_MIGRATION_PATH, "utf8");
  const nonMemberHoldCopyUpdateSql = readFileSync(
    NON_MEMBER_HOLD_COPY_UPDATE_MIGRATION_PATH,
    "utf8",
  );
  const genericiseLodgeCopySql = readFileSync(
    GENERICISE_LODGE_COPY_MIGRATION_PATH,
    "utf8",
  );
  const privacyAuditRetentionSql = readFileSync(
    PRIVACY_AUDIT_RETENTION_MIGRATION_PATH,
    "utf8",
  );
  const faqPersonalDataSql = readFileSync(
    FAQ_PERSONAL_DATA_MIGRATION_PATH,
    "utf8",
  );
  // Comments stripped: #2431's header quotes the new hero in prose, and this
  // suite's job is to prove a STATEMENT writes each current seed value.
  const homeGuestCopySql = statementsOnly(
    readFileSync(HOME_GUEST_COPY_MIGRATION_PATH, "utf8"),
  );
  const allInsertSql = `${insertSql}\n${backfill404Sql}\n${policyPagesSql}\n${bookingRequestsSql}\n${schoolBookingsSql}`;
  const privacyRetentionSql = readFileSync(PRIVACY_RETENTION_HOSTING_MIGRATION_PATH, "utf8");
  const privacyRecipientsSql = readFileSync(PRIVACY_RECIPIENTS_MIGRATION_PATH, "utf8");
  const combinedSql = `${allInsertSql}\n${updateSql}\n${faqUpdateSql}\n${privacyUpdateSql}\n${nonMemberHoldCopyUpdateSql}\n${genericiseLodgeCopySql}\n${privacyAuditRetentionSql}\n${faqPersonalDataSql}\n${homeGuestCopySql}\n${privacyRetentionSql}\n${privacyRecipientsSql}`;

  it("inserts exactly the starter pages defined for the seed", () => {
    const insertedIds = [
      ...allInsertSql.matchAll(/'starter-page-([a-z0-9-]+)'/g),
    ].map((match) => match[1]);
    const expectedIds = starterPageContent.map((page) =>
      page.slug.replace(/\//g, "-"),
    );
    expect(insertedIds.sort()).toEqual(expectedIds.sort());
  });

  it("matches every current seed value so edited seeds force a new backfill", () => {
    for (const page of starterPageContent) {
      const fields = [
        page.slug,
        page.path,
        page.caption,
        page.menuTitle,
        page.title,
        page.headerText,
        page.contentHtml,
      ].filter((value) => value !== "");
      for (const value of fields) {
        expectSqlContainsValue(combinedSql, value);
      }
      expect(combinedSql).toContain(`${page.sortOrder},`);
    }
  });

  it("never overwrites existing rows in the initial backfill", () => {
    expect(allInsertSql).toContain("ON CONFLICT DO NOTHING");
    expect(allInsertSql).not.toMatch(/DO UPDATE/i);
    expect(allInsertSql).not.toMatch(/\b(UPDATE|DELETE)\b/);
  });

  it("seeds the two form pages UNLISTED, in both the seed and the backfill (#2818)", () => {
    // Advertising `/booking-requests` and `/school-bookings` is opt-in per club:
    // an empty menuTitle keeps each page out of the navigation AND out of search
    // engines, because the page reads the same field for its robots tag. The
    // value-lockstep test above skips empty strings, so without this the seed
    // could gain a menu title — silently opting every deployment in — with
    // nothing failing.
    for (const [slug, sql] of [
      ["booking-requests", bookingRequestsSql],
      ["school-bookings", schoolBookingsSql],
    ] as const) {
      const page = starterPageContent.find((entry) => entry.slug === slug);
      expect(page, `expected starter page ${slug}`).toBeDefined();
      expect(page!.menuTitle, `${slug} must seed an empty menu title`).toBe("");

      const row = insertedRow(sql);
      expect(row.slug).toBe(sqlQuote(slug));
      expect(row.menuTitle, `${slug} backfill must write an empty menu title`).toBe(
        "''",
      );
      // The header copy is NOT empty, so the page never falls back to the
      // composed string the render path deliberately escapes rather than
      // renders as HTML (#2818 decision 6).
      expect(page!.headerText.trim()).not.toBe("");
      expect(row.headerText).toBe(sqlQuote(page!.headerText));
    }
  });

  it("covers the routes that hard-404 without a record", () => {
    // "/" renders the "/home" record and the footer/sitemap link to "/rules";
    // both must exist after migrations alone.
    expect(insertSql).toContain("'/home'");
    expect(insertSql).toContain("'/rules'");
    expect(policyPagesSql).toContain("'/privacy'");
    expect(policyPagesSql).toContain("'/terms'");
    expect(policyPagesSql).toContain("'/faq'");
  });
});

describe("the contact page keeps an empty seeded menu title", () => {
  const contact = starterPageContent.find((page) => page.slug === "contact");

  it("seeds no menu label — Contact is opt-in from the CMS like any other page", () => {
    // #2813 first backfilled a "Contact" menu title, then briefly used a code
    // fallback in `buildWebsiteNavLinks`; both are gone. Contact is now a plain
    // opt-in page, so the row seeds an EMPTY menu title — a club that wants
    // Contact in its nav sets the menu title in the CMS. A re-added seed label
    // would opt every club in at once and would need a migration this release
    // deliberately does not ship.
    expect(contact).toBeDefined();
    expect(contact!.menuTitle).toBe("");
  });

  it("ships no contact menu-title backfill migration", () => {
    // The deletion half of the same decision: the data migration and its
    // verification fixture were removed, so nothing here should reference it.
    const migrationsDir = join(process.cwd(), "prisma", "migrations");
    const names = readdirSync(migrationsDir);
    expect(names).not.toContain("20260813010000_backfill_contact_menu_title");
  });
});

describe("starter privacy analytics update migration (#975)", () => {
  const sql = readFileSync(PRIVACY_UPDATE_MIGRATION_PATH, "utf8");
  const policyPagesSql = readFileSync(POLICY_PAGES_MIGRATION_PATH, "utf8");

  it("only updates the privacy row, and never inserts or deletes", () => {
    expect(sql).toMatch(/UPDATE\s+"PageContent"/);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });

  it("guards the update on the row still holding the backfilled privacy html", () => {
    expect(sql).toContain(`"slug" = ${sqlQuote("privacy")}`);
    expect(sql).toContain(previousPrivacyContentHtml(policyPagesSql));
  });

  it("writes the consent-gated analytics copy the #1945 lodge-copy migration supersedes", () => {
    // #975 no longer writes the current seed (the E15 lodge-copy migration
    // does); it must still write exactly what E15 now guards its privacy WHERE
    // on, so the update chain stays unbroken.
    const genericiseSql = readFileSync(
      GENERICISE_LODGE_COPY_MIGRATION_PATH,
      "utf8",
    );
    expect(genericiseSql).toContain(nthCmsBlock(sql, 1));
    expect(sql).toContain("Google Analytics 4");
    expect(sql).toContain("updatedAt");
  });
});

describe("starter home page content update migration", () => {
  const sql = readFileSync(HOME_UPDATE_MIGRATION_PATH, "utf8");
  const statements = statementsOnly(sql);

  it("only updates the home row, and never inserts or deletes", () => {
    expect(sql).toMatch(/UPDATE\s+"PageContent"/);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });

  it("guards the update on the row still holding the previous default text", () => {
    expect(sql).toContain(`"slug" = ${sqlQuote("home")}`);
    for (const value of Object.values(PREVIOUS_HOME_CONTENT)) {
      expect(sql, `expected WHERE clause to guard on ${value}`).toContain(
        sqlQuote(value),
      );
    }
  });

  it("writes the current caption and title from starterPageContent", () => {
    const home = starterPageContent.find((page) => page.slug === "home");
    expect(home).toBeDefined();
    for (const value of [home!.caption, home!.title]) {
      expect(sql).toContain(sqlQuote(value));
    }
  });

  it("writes the hero text the #2431 migration supersedes", () => {
    // #716 no longer writes the current hero (the #2431 guest-copy migration
    // does); it must still write exactly what #2431 guards its WHERE on, so the
    // update chain stays unbroken. SUPERSEDED_HOME_HEADER_TEXT is read out of
    // this very SET clause, so this asserts the extraction found a real value
    // and that it is the guest-booking sentence #2431 exists to remove.
    expect(statements).toContain(sqlQuote(SUPERSEDED_HOME_HEADER_TEXT));
    expect(SUPERSEDED_HOME_HEADER_TEXT).toContain(
      "welcomes members and guests year-round",
    );
  });
});

describe("starter home guest-copy update migration (#2431)", () => {
  // Comments stripped: this migration's header quotes both the old and the new
  // sentence, so every assertion below must read statements, not prose.
  const statements = statementsOnly(
    readFileSync(HOME_GUEST_COPY_MIGRATION_PATH, "utf8"),
  );
  const home = starterPageContent.find((page) => page.slug === "home");

  it("only updates the home row, and never inserts or deletes", () => {
    expect(statements).toMatch(/UPDATE\s+"PageContent"/);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).toContain(`"slug" = ${sqlQuote("home")}`);
    // Exactly one statement, and pure DML: no schema change for an old app
    // colour's compiled queries to miss during the blue/green drain.
    expect(statements.match(/;/g) ?? []).toHaveLength(1);
    expect(statements).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE)\b/i);
  });

  it("is value-scoped, so a customised hero is untouched", () => {
    // The predicate that does the work. Without the headerText equality this
    // would overwrite EVERY install's hero, edited or not — the one property
    // that makes rewriting somebody's front page safe.
    expect(statements).toMatch(/WHERE\s+"slug" = 'home'/);
    expect(statements).toContain(
      `AND "headerText" = ${sqlQuote(SUPERSEDED_HOME_HEADER_TEXT)};`,
    );

    // A club that only reworded part of the sentence no longer byte-matches, so
    // it falls outside the WHERE — demonstrated on the value itself.
    const reworded = SUPERSEDED_HOME_HEADER_TEXT.replace(
      "members and guests",
      "members and their guests",
    );
    expect(reworded).not.toBe(SUPERSEDED_HOME_HEADER_TEXT);
    expect(statements).not.toContain(sqlQuote(reworded));
  });

  it("writes the current hero text from starterPageContent", () => {
    expect(home).toBeDefined();
    expect(statements).toContain(
      `SET "headerText" = ${sqlQuote(home!.headerText)}`,
    );

    // SET (new value) must come before the WHERE guard (old value), so the two
    // are not accidentally swapped.
    const setIndex = statements.indexOf(sqlQuote(home!.headerText));
    const whereIndex = statements.indexOf(
      sqlQuote(SUPERSEDED_HOME_HEADER_TEXT),
    );
    expect(setIndex).toBeGreaterThan(-1);
    expect(whereIndex).toBeGreaterThan(setIndex);

    // Only the hero changes: caption and title are still #716's.
    expect(statements).not.toContain(sqlQuote(home!.caption));
    expect(statements).not.toContain(sqlQuote(home!.title));
  });

  it("replaces rather than clears, so a fresh front page is never blank", () => {
    // Unlike the #2484/#2490 cleanups, "/home" needs SOMETHING in its hero: it
    // is the row "/" renders, above the fold and as the page's meta description.
    expect(home!.headerText.trim()).not.toBe("");
    expect(statements).not.toMatch(/SET\s+"headerText"\s*=\s*''/);
  });

  it("seeds and writes copy that no longer advertises guest booking", () => {
    // The point of the issue: the fresh-install hero must agree with the starter
    // FAQ, which says a non-member stays only as the invited guest of a
    // financial member who is also staying.
    expect(home!.headerText).not.toMatch(/guest/i);
    expect(home!.headerText).toBe(
      "Our club lodge welcomes members year-round. Log in to book a stay, or apply to join and explore New Zealand's mountains.",
    );
    // ...and the seed stays clear of the founding club's geography (#1945).
    expect(home!.headerText).not.toMatch(
      /Waldvogel|Iwikau|Ruapehu|Whakapapa|Tokoroa/i,
    );
  });

  it("is idempotent: the value it writes is not the value it matches", () => {
    expect(home!.headerText).not.toBe(SUPERSEDED_HOME_HEADER_TEXT);
  });

  it("writes no session clock into the payload (#1627/#1656)", () => {
    expect(statements).not.toMatch(/CURRENT_TIMESTAMP/i);
    expect(statements).not.toMatch(/\bnow\s*\(/i);
    // "updatedAt" is deliberately left alone: a system repair, not an edit —
    // matching 20260802110000 (#2484) and 20260802140000 (#2490).
    expect(statements).not.toContain('"updatedAt"');
  });

  it("sorts after the migration it corrects, so migrate deploy applies it second", () => {
    expect(
      "20260802150000_update_starter_home_guest_copy" >
        "20260613090000_update_starter_home_page_content",
    ).toBe(true);
  });
});

describe("starter faq accordion update migration (#992)", () => {
  const sql = readFileSync(FAQ_UPDATE_MIGRATION_PATH, "utf8");
  const policyPagesSql = readFileSync(POLICY_PAGES_MIGRATION_PATH, "utf8");

  it("only updates the faq row, and never inserts or deletes", () => {
    expect(sql).toMatch(/UPDATE\s+"PageContent"/);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });

  it("guards the update on the row still holding the backfilled flat FAQ html", () => {
    expect(sql).toContain(`"slug" = ${sqlQuote("faq")}`);
    expect(sql).toContain(previousFaqContentHtml(policyPagesSql));
  });

  it("writes accordion contentHtml before later starter-copy updates", () => {
    const accordionHtml = faqAccordionContentHtml(sql);
    expect(sql).toContain(accordionHtml);
    expect(sql).toContain('"updatedAt" = CURRENT_TIMESTAMP');

    // SET (new accordion value) must come before the WHERE guard (old value),
    // so the two blobs are not accidentally swapped.
    const setIndex = sql.indexOf(accordionHtml);
    const whereIndex = sql.indexOf(previousFaqContentHtml(policyPagesSql));
    expect(setIndex).toBeGreaterThan(-1);
    expect(whereIndex).toBeGreaterThan(setIndex);

    // The rewrap is structural only: stripping tags must leave the question
    // and answer text identical to the pre-accordion starter content.
    const stripTags = (html: string) =>
      html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    expect(stripTags(accordionHtml)).toBe(
      stripTags(previousFaqContentHtml(policyPagesSql)),
    );
  });
});

describe("starter non-member hold copy update migration (#1287)", () => {
  const sql = readFileSync(NON_MEMBER_HOLD_COPY_UPDATE_MIGRATION_PATH, "utf8");
  const faqUpdateSql = readFileSync(FAQ_UPDATE_MIGRATION_PATH, "utf8");
  const policyPagesSql = readFileSync(POLICY_PAGES_MIGRATION_PATH, "utf8");

  it("adds the hold-enabled columns and only guard-updates starter copy", () => {
    expect(sql).toContain('ALTER TABLE "BookingDefaults" ADD COLUMN "nonMemberHoldEnabled"');
    expect(sql).toContain('ALTER TABLE "BookingPeriod" ADD COLUMN "nonMemberHoldEnabled"');
    expect(sql).toMatch(/UPDATE\s+"PageContent"/);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });

  it("guards updates on the untouched previous starter rows", () => {
    expect(sql).toContain(`"slug" = ${sqlQuote("terms")}`);
    expect(sql).toContain(previousTermsContentHtml(policyPagesSql));
    expect(sql).toContain(faqAccordionContentHtml(faqUpdateSql));
  });

  it("writes the non-member policy copy the #1945 lodge-copy migration supersedes", () => {
    // As with #975, #1287 no longer writes the current Terms/FAQ seed (the E15
    // lodge-copy migration does); its SET blobs must equal what E15 now guards
    // its Terms and FAQ WHERE clauses on.
    const genericiseSql = readFileSync(
      GENERICISE_LODGE_COPY_MIGRATION_PATH,
      "utf8",
    );
    expect(genericiseSql).toContain(nthCmsBlock(sql, 1));
    expect(genericiseSql).toContain(nthCmsBlock(sql, 2));
    expect(sql).toContain("First Paid, First In");
    expect(sql).toContain("non-member confirmation threshold");
  });
});

describe("starter lodge-copy genericise update migration (#1945)", () => {
  const sql = readFileSync(GENERICISE_LODGE_COPY_MIGRATION_PATH, "utf8");
  const privacyUpdateSql = readFileSync(PRIVACY_UPDATE_MIGRATION_PATH, "utf8");
  const nonMemberHoldSql = readFileSync(
    NON_MEMBER_HOLD_COPY_UPDATE_MIGRATION_PATH,
    "utf8",
  );

  it("only updates the privacy, terms, and faq rows; never inserts or deletes", () => {
    expect(sql).toMatch(/UPDATE\s+"PageContent"/);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(sql).toContain(`"slug" = ${sqlQuote("privacy")}`);
    expect(sql).toContain(`"slug" = ${sqlQuote("terms")}`);
    expect(sql).toContain(`"slug" = ${sqlQuote("faq")}`);
  });

  it("guards each update on the exact previous starter copy so edited rows are untouched", () => {
    // Each WHERE guard must equal what the prior migration wrote (privacy from
    // #975; terms/faq from #1287), so any admin-edited row no longer matches.
    expect(sql).toContain(nthCmsBlock(privacyUpdateSql, 1));
    expect(sql).toContain(nthCmsBlock(nonMemberHoldSql, 1));
    expect(sql).toContain(nthCmsBlock(nonMemberHoldSql, 2));
  });

  it("writes the current club-agnostic, token-driven seed copy", () => {
    // Privacy's current seed is written by #4914's
    // 20261214010000_correct_starter_privacy_retention_and_hosting migration
    // (it guards on the #4031 body) and the FAQ's by the #4914 follow-up; each
    // guards on exactly the text its predecessor wrote (asserted there).
    for (const slug of ["terms"]) {
      const page = starterPageContent.find((p) => p.slug === slug);
      expect(page, `expected starter page ${slug}`).toBeDefined();
      expect(sql).toContain(page!.contentHtml);
    }
    expect(sql).toContain("{{lodge-name}}");
    expect(sql).toContain("updatedAt");
  });
});

describe("starter privacy audit-retention update migration (#4031)", () => {
  const sql = readFileSync(PRIVACY_AUDIT_RETENTION_MIGRATION_PATH, "utf8");
  const genericiseSql = readFileSync(GENERICISE_LODGE_COPY_MIGRATION_PATH, "utf8");

  it("only updates the privacy row, and never inserts or deletes", () => {
    expect(sql).toMatch(/UPDATE\s+"PageContent"/);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(statementsOnly(sql).match(/UPDATE\s+"PageContent"/g)).toHaveLength(1);
    expect(sql).toContain(`"slug" = ${sqlQuote("privacy")}`);
  });

  it("guards the update on the exact privacy text #1945 wrote, so edited rows are untouched", () => {
    const previous = sql.match(/\$previous\$([\s\S]*?)\$previous\$/)?.[1];
    expect(previous).toBe(nthCmsBlock(genericiseSql, 1));
  });

  it("writes the current privacy seed copy, with the real audit-log schedule", () => {
    const page = starterPageContent.find((p) => p.slug === "privacy");
    expect(page).toBeDefined();
    expect(nthCmsBlock(sql, 1)).toContain("at least 10 years");
    expect(page!.contentHtml).not.toContain("Retained for 90 days, then automatically pruned");
    expect(page!.contentHtml).toContain("at least 10 years");
    expect(sql).toContain("updatedAt");
  });

  it("bumps the header's Last updated date only where the header is still the starter one", () => {
    // 17 Oct 2026 decision: the starter header (written once, by the policy
    // backfill) moves to the seed's header; any other header is kept.
    const policyPagesSql = readFileSync(POLICY_PAGES_MIGRATION_PATH, "utf8");
    const previousHeader = privacyHeaderOn("1 April 2026");
    expect(policyPagesSql).toContain(sqlQuote(previousHeader));
    expect(statementsOnly(sql)).toContain(`WHEN "headerText" = ${sqlQuote(previousHeader)}`);
    expect(statementsOnly(sql)).toContain(`THEN ${sqlQuote(privacyHeaderOn("17 October 2026"))}`);
    expect(statementsOnly(sql)).toContain(`ELSE "headerText"`);
  });
});

describe("starter FAQ personal-data summary update migration (#4914 follow-up)", () => {
  const sql = readFileSync(FAQ_PERSONAL_DATA_MIGRATION_PATH, "utf8");
  const genericiseSql = readFileSync(GENERICISE_LODGE_COPY_MIGRATION_PATH, "utf8");
  const faq = starterPageContent.find((p) => p.slug === "faq");

  it("only updates the faq row, and never inserts or deletes", () => {
    expect(statementsOnly(sql).match(/UPDATE\s+"PageContent"/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(statementsOnly(sql)).toContain(`"slug" = ${sqlQuote("faq")}`);
  });

  it("guards the update on the exact FAQ text #1945 wrote, so edited rows are untouched", () => {
    const previous = sql.match(/\$previous\$([\s\S]*?)\$previous\$/)?.[1];
    expect(previous).toBe(nthCmsBlock(genericiseSql, 3));
    expect(statementsOnly(sql)).toContain(`AND "contentHtml" = $previous$`);
  });

  it("writes the current FAQ seed copy", () => {
    expect(faq).toBeDefined();
    expect(nthCmsBlock(sql, 1)).toBe(faq!.contentHtml);
    expect(statementsOnly(sql)).toContain(`"updatedAt" = timezone('UTC', statement_timestamp())`);
  });

  it("sorts after the #1945 migration it corrects, so migrate deploy applies it second", () => {
    const stamp = (path: string) => path.split("/").at(-2)!;
    expect(stamp(FAQ_PERSONAL_DATA_MIGRATION_PATH) > stamp(GENERICISE_LODGE_COPY_MIGRATION_PATH)).toBe(true);
  });
});

describe("the starter FAQ's personal-data answer", () => {
  const faq = starterPageContent.find((p) => p.slug === "faq")!;
  const answer = faq.contentHtml
    .split("<summary>What personal data does the club hold about me?</summary>")[1]
    ?.split("</details>")[0];

  it("names the categories the summary promises", () => {
    // The pre-fix answer lacked title, gender, occupation, addresses, photo,
    // dietary or allergy information, family and membership history. The
    // answer also names emails, guests and security logs, which this list does
    // not pin; section 2 of the Privacy Policy is the full list.
    expect(answer).toBeDefined();
    for (const category of [
      "name",
      "title",
      "gender",
      "date of birth",
      "occupation",
      "email address",
      "phone number",
      "street and postal addresses",
      "profile photo",
      "dietary or allergy information",
      "family group",
      "membership history",
      "bookings",
      "payment records",
      "chore assignments",
    ]) {
      expect(answer, `missing "${category}"`).toContain(category);
    }
  });

  it("says it is a summary and points to section 2 of the Privacy Policy", () => {
    expect(answer).toContain("This is a summary.");
    expect(answer).toContain('Section 2 of our <a href="/privacy">Privacy Policy</a>');
    const privacy = starterPageContent.find((p) => p.slug === "privacy")!;
    expect(privacy.contentHtml).toContain("<h2>2. What Information We Collect</h2>");
  });

  it("only points to a section 2 that itself lists each category the summary names", () => {
    // The answer says section 2 "lists everything the club collects", so the
    // privacy seed's section 2 must name every category the summary names, in
    // the words section 2 uses. Editing either copy without the other fails here.
    const privacy = starterPageContent.find((p) => p.slug === "privacy")!;
    const section2 = privacy.contentHtml
      .split("<h2>2. What Information We Collect</h2>")[1]
      ?.split("<h2>3.")[0];
    expect(section2).toBeDefined();
    for (const wording of [
      "first and last name",
      "Title",
      "gender",
      "date of birth",
      "occupation",
      "email address",
      "phone number",
      "street and postal addresses",
      "Profile photos",
      "dietary or allergy information",
      "family relationships",
      "membership dates and history",
      "Dates of stay",
      "guest names",
      "Payment status",
      "Chore assignments",
      "Emails sent to you",
      "IP addresses and request logs",
    ]) {
      expect(section2, `section 2 lacks "${wording}"`).toContain(wording);
    }
  });
});

describe("starter privacy retention census (#4914)", () => {
  const page = starterPageContent.find((p) => p.slug === "privacy")!;
  it("uses only the configured email-log schedule, never a literal period", () => {
    const emailLine = page.contentHtml.match(/<li><strong>Email logs:<\/strong>(.*?)<\/li>/)?.[1];
    expect(emailLine?.trim()).toBe("{{email-log-retention}}.");
  });
  it("registers every retention token for the page editor", () => {
    const retentionTokens = [...page.contentHtml.matchAll(/\{\{([^}]*retention[^}]*)\}\}/g)].map((m) => m[1]);
    expect(retentionTokens).toContain("email-log-retention");
    const catalogue = tokensForContext("page-content-body").map((t) => t.token);
    for (const token of retentionTokens) expect(catalogue).toContain(token);
  });
});


describe("starter privacy retention and hosting migration (#4914)", () => {
  const sql = readFileSync(PRIVACY_RETENTION_HOSTING_MIGRATION_PATH, "utf8");
  const previousSql = readFileSync(PRIVACY_AUDIT_RETENTION_MIGRATION_PATH, "utf8");
  const written = nthCmsBlock(sql, 1);
  it("guards on the exact #4031 body", () => {
    expect(sql.match(/\$previous\$([\s\S]*?)\$previous\$/)?.[1]).toBe(nthCmsBlock(previousSql, 1));
    expect(sql).toContain('AND "contentHtml" = $previous$');
    expect(sql).toContain('WHERE "slug" = \'privacy\'');
  });
  it("preserves a custom header and uses the UTC statement clock", () => {
    expect(sql).toContain(`WHEN "headerText" = ${sqlQuote(privacyHeaderOn("17 October 2026"))}`);
    expect(sql).toContain(`THEN ${sqlQuote(privacyHeaderOn("12 November 2026"))}`);
    expect(sql).toContain('ELSE "headerText"');
    expect(sql).toContain("statement_timestamp() AT TIME ZONE 'UTC'");
  });
  it("wrote host-neutral text with visible deployment review notes", () => {
    expect(written).not.toMatch(/Lightsail|Sydney|encrypted and stored in AWS S3/);
    for (const section of [5, 6]) {
      const text = written.split(`<div><h2>${section}.`)[1]?.split('</div>')[0];
      expect(text).toContain("Admin note:");
      expect(text).toMatch(/hosting provider, region, backup store/);
    }
  });
});

describe("starter privacy recipients and hosting migration (#5007)", () => {
  const sql = readFileSync(PRIVACY_RECIPIENTS_MIGRATION_PATH, "utf8");
  const statements = statementsOnly(sql);
  const page = starterPageContent.find((p) => p.slug === "privacy")!;
  const retentionHostingSql = readFileSync(PRIVACY_RETENTION_HOSTING_MIGRATION_PATH, "utf8");
  const auditRetentionSql = readFileSync(PRIVACY_AUDIT_RETENTION_MIGRATION_PATH, "utf8");

  it("only updates the privacy row, and never inserts or deletes", () => {
    expect(statements.match(/UPDATE\s+"PageContent"/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(statements).toContain(`WHERE "slug" = ${sqlQuote("privacy")}`);
  });

  it("guards on exactly the bodies #4914 and #4031 wrote, so edited rows are untouched", () => {
    expect(statements).toContain(`AND "contentHtml" IN ($previous$`);
    expect(sql.match(/\$previous\$([\s\S]*?)\$previous\$/)?.[1]).toBe(nthCmsBlock(retentionHostingSql, 1));
    expect(sql.match(/\$older\$([\s\S]*?)\$older\$/)?.[1]).toBe(nthCmsBlock(auditRetentionSql, 1));
  });

  it("writes the current privacy seed copy", () => {
    expect(nthCmsBlock(sql, 1)).toBe(page.contentHtml);
  });

  it("moves either starter header to the seed's header and keeps any other", () => {
    expect(statements).toContain(
      `WHEN "headerText" IN (${sqlQuote(privacyHeaderOn("12 November 2026"))}, ${sqlQuote(privacyHeaderOn("17 October 2026"))})`,
    );
    // The seed date and the migration's THEN value are the same string.
    expect(statements).toContain(`THEN ${sqlQuote(page.headerText)}`);
    expect(page.headerText).toContain("Last updated 15 November 2026");
    expect(statements).toContain(`ELSE "headerText"`);
    // The two starter headers are the ones the earlier migrations wrote.
    expect(retentionHostingSql).toContain(`THEN ${sqlQuote(privacyHeaderOn("12 November 2026"))}`);
    expect(auditRetentionSql).toContain(`THEN ${sqlQuote(privacyHeaderOn("17 October 2026"))}`);
  });

  it("uses the UTC statement clock, never the session clock", () => {
    expect(statements).toContain(`"updatedAt" = timezone('UTC', statement_timestamp())`);
    expect(statements).not.toMatch(/CURRENT_TIMESTAMP|\bnow\(\)|LOCALTIMESTAMP/i);
  });

  it("sorts after the #4031 and #4914 migrations it follows", () => {
    const stamp = (path: string) => path.split(/[\\/]/).at(-2)!;
    expect(stamp(PRIVACY_RECIPIENTS_MIGRATION_PATH) > stamp(PRIVACY_RETENTION_HOSTING_MIGRATION_PATH)).toBe(true);
    expect(stamp(PRIVACY_RECIPIENTS_MIGRATION_PATH) > "20261119010000").toBe(true);
  });

  it("writes text that names the host through {{data-hosting}} and drops the old hosting claims", () => {
    const written = nthCmsBlock(sql, 1);
    expect(written).toContain("{{data-hosting}}");
    expect(written).not.toMatch(/Lightsail|Sydney|backups are encrypted|encrypted and stored/i);
  });
});

describe("starter privacy policy versus the recipient register (#5007)", () => {
  const page = starterPageContent.find((p) => p.slug === "privacy")!;
  const section = (n: number) =>
    page.contentHtml.split(`<div><h2>${n}.`)[1]?.split(`<div><h2>${n + 1}.`)[0] ?? "";
  const memberFacing = Object.entries(PRIVACY_RECIPIENTS).filter(([, r]) => r.memberFacing);

  it("lists every member-facing register entry in section 5, and nothing else", () => {
    expect(Object.keys(STARTER_PRIVACY_RECIPIENT_ITEMS).sort()).toEqual(memberFacing.map(([id]) => id).sort());
    const listed = section(5).match(/<li>.*?<\/li>/g) ?? [];
    expect(listed).toEqual(Object.values(STARTER_PRIVACY_RECIPIENT_ITEMS));
  });

  it("links each provider to the privacy notice the register records", () => {
    const registerUrls = new Set<string>(memberFacing.map(([, r]) => r.privacyUrl));
    for (const [id, item] of Object.entries(STARTER_PRIVACY_RECIPIENT_ITEMS)) {
      for (const [, href] of item.matchAll(/href="([^"]+)"/g)) {
        expect(registerUrls.has(href!), `${id} links ${href}, which no register entry records`).toBe(true);
      }
    }
  });

  it("names the host only through the club's settings, never as a fact for every club", () => {
    expect(STARTER_PRIVACY_RECIPIENT_ITEMS.hosting).toContain("{{data-hosting}}");
    expect(section(5) + section(6)).not.toMatch(/Lightsail|Sydney|Asia Pacific|region\b.*\(|encrypted and stored|backups are encrypted/i);
    expect(section(6)).toContain("hosting company described in section 5");
  });

  it("uses only tokens in the page-body catalogue", () => {
    const catalogue = new Set(tokensForContext("page-content-body").map((t) => t.token));
    const used = [...page.contentHtml.matchAll(/\{\{\s*([^}:\s]+)[^}]*\}\}/g)].map((m) => m[1]!);
    expect(used).toContain("data-hosting");
    for (const token of used) expect(catalogue.has(token), `{{${token}}} is not in the catalogue`).toBe(true);
  });
});
