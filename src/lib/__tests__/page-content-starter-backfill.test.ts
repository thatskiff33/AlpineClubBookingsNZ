import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { starterPageContent } from "../../../prisma/starter-page-content";

// Production deploys run Prisma migrations but not the seed, so the starter
// PageContent rows are backfilled by a data migration. These tests keep that
// SQL in sync with starterPageContent: if a starter page is added or edited
// without a matching backfill migration, deploy-only environments would 404
// the affected public route.
const MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260611101500_backfill_starter_page_content",
  "migration.sql",
);

function sqlQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

describe("starter page content backfill migration", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it("inserts exactly the starter pages defined for the seed", () => {
    const insertedIds = [...sql.matchAll(/'starter-page-([a-z-]+)'/g)].map(
      (match) => match[1],
    );
    const expectedIds = starterPageContent.map((page) =>
      page.slug.replace(/\//g, "-"),
    );
    expect(insertedIds.sort()).toEqual(expectedIds.sort());
  });

  it("matches every seed value so edited seeds force a new backfill", () => {
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
        expect(sql, `expected backfill SQL to contain ${value}`).toContain(
          sqlQuote(value),
        );
      }
      expect(sql).toContain(`${page.sortOrder},`);
    }
  });

  it("never overwrites existing rows", () => {
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).not.toMatch(/DO UPDATE/i);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE)\b/);
  });

  it("covers the routes that hard-404 without a record", () => {
    // "/" renders the "/home" record and the footer/terms/sitemap link to
    // "/rules"; both must exist after migrations alone.
    expect(sql).toContain("'/home'");
    expect(sql).toContain("'/rules'");
  });
});
