/**
 * ONE WRITER of the club's tax category mappings (#5209; `INV-CONFIG-008`):
 * `xero-tax-category-write.ts`, which checks the rate against the connected
 * Xero organisation, stamps that organisation, and audits each change. Every
 * other production path — the app, a seed, a script, config transfer — stays a
 * reader, so no mapping can name a code Xero was never asked about. Migrations
 * and tests are outside the scan. Disk-scanning: run by name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { delegateUsesBeyondReads, productionSourceFiles } from "./support/prisma-delegate-read-scan";
import { stripComments } from "./support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const ROOT = process.cwd();
const DELEGATE = "xeroTaxCategoryMapping";
const WRITER = "src/lib/xero-tax-category-write.ts";
const SQL_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|COPY)\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:"?public"?\.)?"?XeroTaxCategoryMapping\b/i;

const naming = productionSourceFiles(ROOT)
  .map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }))
  .filter(({ text }) => /xeroTaxCategoryMapping|XeroTaxCategoryMapping/.test(text));

describe("the Xero tax category mappings have one writer (#5209)", () => {
  it("are written through their delegate by the one writer only", () => {
    const offenders = naming
      .filter(({ file }) => file !== WRITER)
      .flatMap(({ file, text }) =>
        delegateUsesBeyondReads(text, file, (name) => name === DELEGATE).map(({ line, text: code }) => `${file}:${line} ${code}`));
    expect(offenders, `a production path other than ${WRITER} writes XeroTaxCategoryMapping`).toEqual([]);
  }, CENSUS_TIMEOUT_MS);

  it("are written by no raw SQL in source", () => {
    expect(naming.filter(({ text }) => SQL_WRITE.test(stripComments(text))).map(({ file }) => file)).toEqual([]);
  });

  it("is not vacuous: the reader and the writer are scanned, and the writer is caught writing", () => {
    const files = naming.map(({ file }) => file);
    expect(files).toContain("src/lib/xero-tax-category-mappings.ts");
    expect(files).toContain(WRITER);
    const writer = naming.find(({ file }) => file === WRITER)!;
    expect(delegateUsesBeyondReads(writer.text, WRITER, (name) => name === DELEGATE).length).toBeGreaterThan(0);
  });
});
