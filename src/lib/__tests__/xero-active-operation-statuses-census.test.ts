import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { XERO_ACTIVE_OPERATION_STATUSES } from "@/lib/xero-active-operation-statuses";
import { OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES } from "@/lib/xero-supplementary-invoice-statuses";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const HOME = "src/lib/xero-active-operation-statuses.ts";
const MIGRATION = "prisma/migrations/20260706040000_xero_outbox_active_correlation_unique/migration.sql";

/** Status-only arrays, including Set inputs and supersets; mixed UI options and prose are excluded. */
function duplicatedLists(file: string, text: string): number[] {
  if (!XERO_ACTIVE_OPERATION_STATUSES.every((status) => text.includes(status))) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  function visit(node: ts.Node) {
    if (ts.isArrayLiteralExpression(node)) {
      const statuses = node.elements.flatMap((element) => {
        if (ts.isStringLiteralLike(element)) return [element.text];
        if (ts.isPropertyAccessExpression(element)) return [element.name.text];
        return [];
      });
      if (statuses.every((status) => /^[A-Z_]+$/.test(status)) &&
          XERO_ACTIVE_OPERATION_STATUSES.every((status) => statuses.includes(status))) {
        lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return lines;
}

describe("Xero active operation statuses (#4354, INV-SSOT-001)", () => {
  it("matches the partial unique index's active population exactly", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const predicate = sql.match(/AND\s+"status"\s+IN\s*\(([^)]+)\)/);
    expect(predicate, "migration active-status predicate must be found").not.toBeNull();
    const indexedStatuses = [...predicate![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(indexedStatuses.length).toBeGreaterThan(0);
    expect([...XERO_ACTIVE_OPERATION_STATUSES].sort()).toEqual(indexedStatuses.sort());
    expect(new Set(XERO_ACTIVE_OPERATION_STATUSES).size).toBe(XERO_ACTIVE_OPERATION_STATUSES.length);
  });

  it("keeps the supplementary-invoice name an alias of the same definition", () => {
    expect(OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES).toBe(XERO_ACTIVE_OPERATION_STATUSES);
  });

  it.each([
    '["WAITING_PAYMENT", "PENDING", "RUNNING"]',
    'new Set(["FAILED", "PENDING", /* active */ "RUNNING", "WAITING_PAYMENT"])',
    '[XeroSyncStatus.PENDING, XeroSyncStatus.RUNNING, XeroSyncStatus.WAITING_PAYMENT]',
  ])("recognizes a copied active list: %s", (code) => {
    expect(duplicatedLists("fixture.ts", code)).toEqual([1]);
  });

  it("allows derived lists, narrower populations and documentation", () => {
    expect(duplicatedLists("fixture.ts", `
      const derived = [...XERO_ACTIVE_OPERATION_STATUSES, "FAILED"];
      const narrower = ["PENDING", "WAITING_PAYMENT"];
      const filterOptions = ["all", "PENDING", "RUNNING", "WAITING_PAYMENT", "FAILED"];
      // ["PENDING", "RUNNING", "WAITING_PAYMENT"]
      const prose = '["PENDING", "RUNNING", "WAITING_PAYMENT"]';
    `)).toEqual([]);
  });

  // Reads src/ from disk: run explicitly with test:named after changing a status list.
  it("has no second literal definition anywhere in production src/", () => {
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .map((file) => `src/${file.replaceAll(path.sep, "/")}`)
      .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !file.includes("/__tests__/") && !/\.(test|spec)\./.test(file));
    expect(files).toContain(HOME);
    expect(files).toContain("src/lib/xero-sync.ts");
    const copies = files.filter((file) => file !== HOME).flatMap((file) =>
      duplicatedLists(file, readFileSync(file, "utf8")).map((line) => `${file}:${line}`),
    );
    expect(copies, "import XERO_ACTIVE_OPERATION_STATUSES instead of copying its population").toEqual([]);
  }, CENSUS_TIMEOUT_MS);
});
