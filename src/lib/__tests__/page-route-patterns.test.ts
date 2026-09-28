import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";
import {
  ADMIN_MEMBER_DETAIL_ROUTE_PATTERN,
  BOOKING_DETAIL_ROUTE_PATTERN,
} from "@/lib/page-route-patterns";

/**
 * #3635: a `revalidatePath(pattern, "page")` pattern must name a real page
 * file, route groups included, or it refreshes nothing. Two of the patterns in
 * this repository once named pages that did not exist.
 */
const fileFor = (pattern: string, type: "page" | "layout") =>
  path.join("src", "app", `.${pattern}`, `${type}.tsx`);
const pageFileFor = (pattern: string) => fileFor(pattern, "page");

describe("revalidatePath page patterns (#3635)", () => {
  it.each([
    ["BOOKING_DETAIL_ROUTE_PATTERN", BOOKING_DETAIL_ROUTE_PATTERN],
    ["ADMIN_MEMBER_DETAIL_ROUTE_PATTERN", ADMIN_MEMBER_DETAIL_ROUTE_PATTERN],
  ])("%s names a page file on disk", (_name, pattern) => {
    expect(existsSync(pageFileFor(pattern)), pageFileFor(pattern)).toBe(true);
  });

  it("every literal page or layout pattern in src/ names a file on disk (#3635 N10)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          files.push(full);
        }
      }
    };
    walk("src");
    // Either quote, either type argument, comments stripped so a pattern
    // quoted in prose is not read as a call.
    const literal =
      /revalidatePath\(\s*(["'])([^"']+)\1\s*,\s*(["'])(page|layout)\3\s*\)/g;
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const file of files) {
      for (const match of stripComments(readFileSync(file, "utf8")).matchAll(literal)) {
        const target = fileFor(match[2]!, match[4] as "page" | "layout");
        seen.push(target);
        if (!existsSync(target)) offenders.push(`${file}: ${match[2]} (${match[4]})`);
      }
    }
    // Not vacuous: the tree revalidates the root and group layouts literally.
    expect(seen.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
