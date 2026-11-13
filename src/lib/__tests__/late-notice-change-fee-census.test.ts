import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * `calculateChangeFee` is the tier math. The late-notice gate
 * (`lateNoticeChangeFee`) is its only production caller, so a door cannot
 * charge the fee and forget whether the booking has been paid.
 */
const LEAF = "src/lib/late-notice-change-fee.ts";
const CALL = /(?<!function\s)calculateChangeFee\s*\(/;

function productionSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, found);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe("calculateChangeFee has one production caller", () => {
  it("is called only from the late-notice leaf", () => {
    const callers = productionSources(join(process.cwd(), "src"))
      .filter((file) => CALL.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => relative(process.cwd(), file).split("\\").join("/"))
      .sort();
    expect(callers).toEqual([LEAF]);
  });
});
