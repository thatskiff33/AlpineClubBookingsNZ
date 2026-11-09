import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAdminRouteRequirement } from "@/lib/admin-permissions";
import { ADMIN_PAGES } from "@/lib/admin-hubs";

// docs/COVERAGE_MATRIX.md keeps one row per admin route area (#4577). Its
// Summary count and rows drifted: it said 69 while the table had 81 rows and
// four areas had none, and four rows named a permission area the route map
// does not. The areas come from the hub registry's old paths (#4799), never a
// second directory listing of our own (INV-SSOT): the registry's suite ties
// each entry to its page on disk, and an old path does not change when its
// page moves under a hub, where the top-level directory on disk would.

const MATRIX = fs.readFileSync(
  path.join(process.cwd(), "docs/COVERAGE_MATRIX.md"),
  "utf8",
);

const ROW = /^\| `([a-z0-9-]+)` \| ([^|]+) \|/;

const rows = MATRIX.split("\n").flatMap((line) => {
  const match = ROW.exec(line);
  return match ? [{ area: match[1], permission: match[2].trim() }] : [];
});

/** Each registered page's old top-level directory: `/admin/<area>/...`. */
const registeredAreas = Array.from(
  new Set(
    ADMIN_PAGES.map((page) => page.oldPath.slice("/admin/".length).split("/")[0]),
  ),
).sort();

describe("COVERAGE_MATRIX.md admin areas (#4577)", () => {
  it("has exactly one row for every admin area directory, and no others", () => {
    const rowAreas = rows.map((row) => row.area);
    expect(new Set(rowAreas).size).toBe(rowAreas.length);
    expect([...rowAreas].sort()).toEqual(registeredAreas);
  });

  it("states the area count the table actually has", () => {
    const stated = /- \*\*(\d+)\*\* admin route areas/.exec(MATRIX);
    expect(stated, "the Summary's area-count bullet").not.toBeNull();
    expect(Number(stated?.[1])).toBe(rows.length);
  });

  it("names the permission area the route map resolves for each row", () => {
    const mismatches = rows.flatMap(({ area, permission }) => {
      const resolved = getAdminRouteRequirement(`/admin/${area}`)?.area;
      return resolved && permission.startsWith(resolved)
        ? []
        : [`${area}: matrix says "${permission}", route map says ${resolved}`];
    });
    expect(mismatches).toEqual([]);
  });
});
