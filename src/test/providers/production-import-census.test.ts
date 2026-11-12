/**
 * NO PRODUCTION MODULE REACHES `src/test/` (#4908).
 *
 * The provider transports here stand in for Xero and Stripe through the
 * test-only client overrides in `xero-api-client.ts` and `stripe.ts`. That seam
 * is safe only while nothing a deployment runs can load them, so this census
 * reads every non-test source file under `src/` and refuses any import,
 * re-export, dynamic `import()` or `require` whose specifier resolves into
 * test code — `src/test/`, any `__tests__` directory or a `*.test.*` /
 * `*.spec.*` file — through the `@/` alias or a relative path. Test code itself
 * may.
 *
 * Run by name: it reads source from disk, outside the import graph.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

const SRC_DIR = resolve(import.meta.dirname, "..", "..");
const TEST_DIR = join(SRC_DIR, "test");

/** Every source file a deployment could load: under `src/`, outside `src/test/`, not a test. */
function productionFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules" || full === TEST_DIR) continue;
      productionFiles(full, acc);
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])([^"'`]+)\1/g;

const TEST_FILE = /\.(test|spec)(\.[cm]?[jt]sx?)?$/;
const isTestCode = (target: string) =>
  target === TEST_DIR || target.startsWith(TEST_DIR + sep) || target.split(sep).includes("__tests__") || TEST_FILE.test(target);

/** The specifiers in `code` that resolve into test code, for a file at `file`. */
function testImports(file: string, code: string): string[] {
  const hits: string[] = [];
  for (const [, , specifier] of stripComments(code).matchAll(SPECIFIER)) {
    const target = specifier.startsWith("@/")
      ? join(SRC_DIR, specifier.slice(2))
      : specifier.startsWith(".") ? resolve(dirname(file), specifier) : null;
    if (target && isTestCode(target)) hits.push(specifier);
  }
  return hits;
}

describe("production code never imports test code (#4908)", () => {
  it("finds no production import of the test tree", () => {
    const files = productionFiles(SRC_DIR);
    // The walk is live: it reaches the modules holding the override seam.
    expect(files).toEqual(expect.arrayContaining([join(SRC_DIR, "lib", "stripe.ts"), join(SRC_DIR, "lib", "xero-api-client.ts")]));
    const offenders = files.flatMap((file) =>
      testImports(file, readFileSync(file, "utf8")).map((specifier) => `${relative(SRC_DIR, file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it("recognises every import spelling, and ignores prose", () => {
    const file = join(SRC_DIR, "lib", "example.ts");
    expect(testImports(file, [
      'import { xeroTransport } from "@/test/providers/xero-transport";',
      "export * from '../test/providers/stripe-fake';",
      "const t = await import(`@/test/providers/stripe-transport`);",
      'const r = require("../test/providers/replay-write");',
      'import "@/test";',
      'import { h } from "./__tests__/support/helper";',
      'import { t } from "@/lib/money.test";',
    ].join("\n"))).toEqual([
      "@/test/providers/xero-transport",
      "../test/providers/stripe-fake",
      "@/test/providers/stripe-transport",
      "../test/providers/replay-write",
      "@/test",
      "./__tests__/support/helper",
      "@/lib/money.test",
    ]);
    expect(testImports(file, [
      '// see "@/test/providers/xero-transport"',
      'import { x } from "@/lib/testing";',
      'import { y } from "./test/helper";',
      'import { z } from "@/lib/latest";',
    ].join("\n"))).toEqual([]);
  });
});
