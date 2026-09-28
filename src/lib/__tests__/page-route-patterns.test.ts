import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_MEMBER_DETAIL_ROUTE_PATTERN,
  BOOKING_DETAIL_ROUTE_PATTERN,
} from "@/lib/page-route-patterns";

/**
 * #3635: a `revalidatePath(pattern, "page")` pattern must name a real page
 * file, route groups included, or it refreshes nothing. Two of the patterns in
 * this repository once named pages that did not exist.
 */
const pageFileFor = (pattern: string) => path.join("src", "app", `.${pattern}`, "page.tsx");

describe("revalidatePath page patterns (#3635)", () => {
  it.each([
    ["BOOKING_DETAIL_ROUTE_PATTERN", BOOKING_DETAIL_ROUTE_PATTERN],
    ["ADMIN_MEMBER_DETAIL_ROUTE_PATTERN", ADMIN_MEMBER_DETAIL_ROUTE_PATTERN],
  ])("%s names a page file on disk", (_name, pattern) => {
    expect(existsSync(pageFileFor(pattern)), pageFileFor(pattern)).toBe(true);
  });

  it("every literal page pattern under src/app/api names a page file on disk", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          files.push(full);
        }
      }
    };
    walk(path.join("src", "app", "api"));
    const literal = /revalidatePath\(\s*"([^"]+)"\s*,\s*"page"\s*\)/g;
    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(literal)) {
        seen += 1;
        if (!existsSync(pageFileFor(match[1]!))) offenders.push(`${file}: ${match[1]}`);
      }
    }
    // Every page pattern goes through the constants above today, so `seen` is
    // 0; a new literal is checked here the moment it appears.
    void seen;
    expect(offenders).toEqual([]);
  });
});
