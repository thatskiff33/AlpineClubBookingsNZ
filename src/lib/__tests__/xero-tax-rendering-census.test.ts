import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { productionSourceFiles } from "./support/prisma-delegate-read-scan";
import { stripComments } from "./support/strip-comments";

/**
 * ONE XERO TAX RENDERER (#4632, `INV-CONFIG-007`). Only `xero-tax-rendering.ts`
 * may name a Xero tax type or a `LineAmountTypes` value; every invoice and
 * credit note takes both from it under the club's tax treatment, so no document
 * can hard-code GST again. Tests and migration fixtures are outside the scan.
 * Disk-scanning: run by name.
 */
const ROOT = process.cwd();
const RENDERER = "src/lib/xero-tax-rendering.ts";
const NAMES_TAX = /["'`]OUTPUT2["'`]|\bLineAmountTypes\s*\.\s*[A-Z]/;

const files = productionSourceFiles(ROOT).filter((file) => file.startsWith("src/") || file.startsWith("scripts/"));

describe("one Xero tax renderer (#4632)", () => {
  it("names a Xero tax type or line-amount basis only in the renderer", () => {
    const offenders = files.filter((file) => file !== RENDERER && NAMES_TAX.test(stripComments(readFileSync(join(ROOT, file), "utf8"))));
    expect(offenders, "render Xero tax through xero-tax-rendering.ts").toEqual([]);
  });

  it("is not vacuous: the renderer is scanned and matches, and both shapes are caught", () => {
    expect(files).toContain(RENDERER);
    expect(stripComments(readFileSync(join(ROOT, RENDERER), "utf8"))).toMatch(NAMES_TAX);
    expect('lineItems: [{ taxType: "OUTPUT2" }]').toMatch(NAMES_TAX);
    expect("lineAmountTypes: LineAmountTypes.Inclusive").toMatch(NAMES_TAX);
    expect("import { LineAmountTypes } from \"xero-node\";").not.toMatch(NAMES_TAX);
  });
});
